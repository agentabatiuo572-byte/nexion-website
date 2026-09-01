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
  let code = r.status ?? 1;
  try {
    code = Number(readFileSync(path.join(SITE, '.verify-exit.code'), 'utf8').trim());
  } catch {
    /* 文件读不到就用进程码,但要在 detail 里说明 */
  }
  let out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  let gate = /✗\s+([a-z0-9-]+)/i.exec(out)?.[1] ?? null;

  if (code === 0) {
    /* 🔴 先跑门的**自检**再跑门本体(2026-09-01 补):
       这两道门各有二十多条自检,而它们此前**不在任何一条链里** —— 只在「我记得跑」的时候才跑,
       正是 memory 里那条「新建测试天然成孤儿」的形态。门坏了却报绿是最贵的一种错,
       而自检只花几百毫秒。read-jsonc 是两道门共用的配置读取器,同理。 */
    for (const [name, script, ...args] of [
      ['jsonc-reader-自检', 'lib/test-read-jsonc.mjs'],
      ['config-consistency-自检', 'gate-config-consistency.mjs', '--self-test'],
      ['console-copy-自检', 'gate-console-copy.mjs', '--self-test'],
      ['config-consistency', 'gate-config-consistency.mjs'],
      ['console-copy', 'gate-console-copy.mjs'],
    ]) {
      const w = spawnSync('node', [script, ...args], { cwd: here, shell: true, encoding: 'utf8' });
      out += `\n---- ${name} ----\n${w.stdout ?? ''}${w.stderr ?? ''}`;
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
