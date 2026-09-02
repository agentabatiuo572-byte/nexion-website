#!/usr/bin/env node
/* 发布执行器(V1-dev 本机版;Phase C 的 CI 版走同一 §5.4 契约)。
   领任务 → 物化配置 → 站上全部机器门 → 生产构建 → 原子切换,逐步回报。
   🔴 铁则:门红即停,不回报 swap ok —— 线上保持旧版。执行器无权跳过任何一步。
   用法:npm run publish:runner -- --api http://127.0.0.1:8787 --cookie "nx_sid=..." [--once]
   为什么门跑在物化产物上:配置错误必须以「站上门」的口径被拦,而不是另造一套判据。 */
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SITE = path.join(here, '..');
const arg = (k, d) => {
  const i = process.argv.indexOf(k);
  return i >= 0 ? process.argv[i + 1] : d;
};
const API = arg('--api', 'http://127.0.0.1:8787');
const COOKIE = arg('--cookie', '');
const ONCE = process.argv.includes('--once');
const POLL_MS = 3000;

/* 网络抖动重试:质检门里的生产构建会重写 dist,而 wrangler dev 监视该目录 → 自动重启 →
   正在写的连接被掐断(实测 ECONNABORTED)。回报不能因此丢失,否则版本卡在「发布中」。 */
const api = async (p, init = {}, attempt = 1) => {
  try {
    const res = await fetch(`${API}${p}`, { ...init, headers: { 'content-type': 'application/json', cookie: COOKIE, ...(init.headers ?? {}) } });
    const body = await res.json().catch(() => ({}));
    // 🔴 409 是「被服务端拒绝」(锁过期/顺序不对/已被领走),不是成功——此前当成功继续往下跑,
    //    会让执行器在服务端已经拒收的情况下自顾自推进(验收 P2)
    if (!res.ok) {
      const err = new Error(`${p} → ${res.status} ${JSON.stringify(body).slice(0, 200)}`);
      err.status = res.status;
      err.rejected = res.status === 409 || res.status === 400 || res.status === 401;
      throw err;
    }
    return body;
  } catch (e) {
    if (e.rejected || attempt >= 5) throw e; // 服务端明确拒绝不重试
    await new Promise((r) => setTimeout(r, 1000 * attempt));
    return api(p, init, attempt + 1);
  }
};

/* 🔴 被中止就自己退场(第五轮 P1-6)。
   强制中止只在服务端放开这次发布,**碰不到本进程**——worker 没有停掉本机进程的能力。
   若本进程还在闷头跑,就会出现「运营以为已经中止、于是重新发起」与「旧执行器还在写文件」
   同时成立,而 V1 的整个设计前提是单执行器。
   所以由执行器**自己**每一步开工前确认「这单还是我的吗」;不是了就干净退出,
   把「请先手工关掉它」从文档约定变成程序行为。 */
async function stillMine(versionId, stamp) {
  try {
    const s = await api('/api/publish/status');
    if (s.activeVersion === versionId) return true;
    console.log(`■ v${versionId} 已不在进行中(可能被强制中止或已超时),执行器退出,不再写任何文件`);
    return false;
  } catch {
    return true; // 查不到就按「还是我的」继续:宁可多跑一步,也不因为一次网络抖动放弃已跑完的门链
  }
}
/** 上报要带本次领单口令:服务端据此确认是「领过单的那个执行器」在说话 */
const report = (versionId, step, status, stamp, extra = {}) => api('/api/publish/step', { method: 'POST', body: JSON.stringify({ versionId, step, status, stamp, ...extra }) });

/* 门 = 站上 13 门 + worker 自己的一致性门。
   🔴 后半截是 2026-09-01 复验 P1-C/P1-5 补的:伺服目录那道断言写对了,却**不在任何自动链里**——
   只有人手敲 `npm run gate:config` 才跑,发布流水线一次都不会碰它。
   门不在链上 = 门不存在。而它守的恰恰是「线上伺服的是已发布快照」这条 P0 修法的唯一支点,
   所以必须在每次发布时都真跑一遍。 */
function runGates() {
  const r = spawnSync('npm', ['run', 'verify'], { cwd: SITE, shell: true, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  let out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  /* 🔴 退出码文件读不到 = **门没跑起来**,不是「用进程码兜一下」就完事(第十轮独立验收 P1)。
     上一版无条件回读该文件,而它是上一次运行留下的:verify 崩在启动阶段时文件还在、值还是 0,
     于是「门根本没跑」被报成「门全绿」。verify-preamble 每次开跑先把它置 2,
     所以读不到只有一个解释:那一步压根没执行到。 */
  let code;
  const codePath = path.join(SITE, '.verify-exit.code');
  try {
    code = Number(readFileSync(codePath, 'utf8').trim());
    if (!Number.isFinite(code)) throw new Error('内容不是数字');
  } catch (e) {
    out += `\n---- 门链判据缺席 ----\n读不到 ${codePath}(${String(e).slice(0, 80)})——门没跑起来,一律判红`;
    return { ok: false, gate: 'verify-not-run', tail: out.split('\n').slice(-25).join('\n') };
  }
  let gate = /✗\s+([a-z0-9-]+)/i.exec(out)?.[1] ?? null;

  if (code === 0) {
    /* 🔴 门与测试**必须在链上**(第十轮独立验收 P1:实测八处孤儿)。
       「门不在链上 = 门不存在」——只在「我记得跑」的时候才跑的检查,等于没有。
       上一版这里只有两道门 + 两条自检,而下面这些当时全是孤儿:
       **worker 的全套单元测试**(发布流水线自己的正确性,一次都没在发布时跑过)、
       产物无关性门、字节级静态对照、埋点体积、种子等价、以及各门的红测套件。
       ⚠️ 只列**真实存在**的入口:上一版我在 `test:gates` 里对两个根本没有 `--self-test`
       实现的脚本传了该参数,它们把未知参数忽略、跑的是主门,而我把输出条数当成了自检条数
       ——「55 条自检全绿」里有 5 条是假的。凡加一行到这张表,先确认那个入口真的存在。 */
    for (const [name, cmd, args, cwd] of [
      ['jsonc-reader-红测', 'node', ['lib/test-read-jsonc.mjs'], here],
      ['exit-finally-红测', 'node', ['lib/test-exit-skips-finally.mjs'], here],
      ['config-consistency-自检', 'node', ['gate-config-consistency.mjs', '--self-test'], here],
      ['console-copy-自检', 'node', ['gate-console-copy.mjs', '--self-test'], here],
      ['css-shadowed-红测', 'node', ['scripts/test-css-shadowed.mjs'], SITE],
      ['render-fit-自检', 'node', ['scripts/gate-render-fit.mjs', '--self-test'], SITE],
      ['worker-单测', 'npx', ['vitest', 'run'], here],
      ['config-consistency', 'node', ['gate-config-consistency.mjs'], here],
      ['console-copy', 'node', ['gate-console-copy.mjs'], here],
      ['equivalence', 'node', ['--import', './register-ts-ext.mjs', 'gate-equivalence.mjs'], here],
      ['beacon-size', 'node', ['gate-beacon-size.mjs'], here],
    ]) {
      const w = spawnSync(cmd, args, { cwd, shell: true, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
      out += `\n---- ${name} ----\n${(w.stdout ?? '').split('\n').slice(-8).join('\n')}${w.stderr ?? ''}`;
      if (w.status !== 0) {
        code = w.status ?? 1;
        gate = name;
        break;
      }
    }
  }
  return { ok: code === 0, gate, tail: out.split('\n').slice(-25).join('\n') };
}

async function runJob(job) {
  const { versionId, config, stamp } = job;
  // ① 物化:配置 → 站消费物(与种子同一物化器,零第二实现)
  await report(versionId, 'materialize', 'running', stamp);
  try {
    const { materializeI18n, materializeSiteJson } = await import('../schema/src/materialize.ts');
    const manifest = JSON.parse(readFileSync(path.join(here, 'seed/copy-manifest.json'), 'utf8'));
    for (const loc of ['en', 'vi', 'zh']) {
      writeFileSync(path.join(SITE, `src/i18n/${loc}.json`), materializeI18n(config, manifest, loc));
    }
    mkdirSync(path.join(SITE, 'src/config'), { recursive: true });
    writeFileSync(path.join(SITE, 'src/config/site.json'), materializeSiteJson(config));
    await report(versionId, 'materialize', 'ok', stamp);
  } catch (e) {
    await report(versionId, 'materialize', 'failed', stamp, { detail: String(e).slice(0, 500) });
    return;
  }

  // ② 站上全部机器门(必须在物化后的产物上跑)。门要跑五六分钟,开跑前先确认这单还是自己的。
  if (!(await stillMine(versionId, stamp))) return;
  await report(versionId, 'gates', 'running', stamp);
  const gates = runGates();
  if (!gates.ok) {
    await report(versionId, 'gates', 'failed', stamp, { gate: gates.gate, detail: gates.tail });
    console.log(`✗ 门红(${gates.gate ?? '见日志'}),线上保持旧版;工作树已物化的内容请按需 git checkout`);
    return;
  }
  await report(versionId, 'gates', 'ok', stamp);

  // ③ 生产构建(verify 内含构建,这里做控制台组装与产物就位)
  await report(versionId, 'build', 'running', stamp);
  try {
    execFileSync('npm', ['run', 'build:console'], { cwd: SITE, shell: true, stdio: 'pipe' });
    await report(versionId, 'build', 'ok', stamp);
  } catch (e) {
    await report(versionId, 'build', 'failed', stamp, { detail: String(e).slice(0, 500) });
    return;
  }

  /* ④ 原子切换:把已过门的 dist 提升为线上快照 dist-live(worker 伺服的是后者)。
     🔴 这一步之前,线上一直是上一版——门跑到一半时未过门的内容不会对外(验收 P0-3 的修法本体)。
     🔴 一次性口令原样透传给 promote,由它写进快照里的上线印记;服务端标 live 前会回读核实
        (复验 P0-A:光有序列校验挡不住「照合法顺序全报一遍」,必须让上线依赖一件
         纯 HTTP 调用者做不到的事——往文件系统里落一个文件)。 */
  // 切换是唯一会动线上快照的一步:动手前再确认一次这单还是自己的,别在已被中止后还去改线上
  if (!(await stillMine(versionId, stamp))) return;
  await report(versionId, 'swap', 'running', stamp);
  try {
    execFileSync('node', ['promote.mjs', '--version', String(versionId), '--stamp', String(stamp ?? '')], { cwd: here, stdio: 'pipe' });
    await report(versionId, 'swap', 'ok', stamp);
    console.log(`✓ v${versionId} 已上线(dist-live 已更新)`);
  } catch (e) {
    await report(versionId, 'swap', 'failed', stamp, { detail: `快照提升失败:${String(e).slice(0, 400)}` });
    console.log('✗ 快照提升失败,线上保持旧版');
  }
}

async function loop() {
  for (;;) {
    const { job } = await api('/api/publish/next', { method: 'POST', body: '{}' });
    if (job) {
      console.log(`▶ 领到发布任务 v${job.versionId}`);
      await runJob(job);
      if (ONCE) return;
    } else if (ONCE) {
      console.log('无待处理任务');
      return;
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

loop().catch((e) => {
  console.error('执行器异常:', e);
  process.exit(1);
});
