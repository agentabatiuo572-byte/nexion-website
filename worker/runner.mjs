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
const report = (versionId, step, status, extra = {}) => api('/api/publish/step', { method: 'POST', body: JSON.stringify({ versionId, step, status, ...extra }) });

/** 站上 13 门:退出码读 .verify-exit.code 文件(站规矩:不读管道) */
function runGates() {
  const r = spawnSync('npm', ['run', 'verify'], { cwd: SITE, shell: true, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  let code = r.status ?? 1;
  try {
    code = Number(readFileSync(path.join(SITE, '.verify-exit.code'), 'utf8').trim());
  } catch {
    /* 文件读不到就用进程码,但要在 detail 里说明 */
  }
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  // 从汇总里抓第一条红门名(UI 用它做大白话映射)
  const gate = /✗\s+([a-z0-9-]+)/i.exec(out)?.[1] ?? null;
  return { ok: code === 0, gate, tail: out.split('\n').slice(-25).join('\n') };
}

async function runJob(job) {
  const { versionId, config } = job;
  // ① 物化:配置 → 站消费物(与种子同一物化器,零第二实现)
  await report(versionId, 'materialize', 'running');
  try {
    const { materializeI18n, materializeSiteJson } = await import('../schema/src/materialize.ts');
    const manifest = JSON.parse(readFileSync(path.join(here, 'seed/copy-manifest.json'), 'utf8'));
    for (const loc of ['en', 'vi', 'zh']) {
      writeFileSync(path.join(SITE, `src/i18n/${loc}.json`), materializeI18n(config, manifest, loc));
    }
    mkdirSync(path.join(SITE, 'src/config'), { recursive: true });
    writeFileSync(path.join(SITE, 'src/config/site.json'), materializeSiteJson(config));
    await report(versionId, 'materialize', 'ok');
  } catch (e) {
    await report(versionId, 'materialize', 'failed', { detail: String(e).slice(0, 500) });
    return;
  }

  // ② 站上全部机器门(必须在物化后的产物上跑)
  await report(versionId, 'gates', 'running');
  const gates = runGates();
  if (!gates.ok) {
    await report(versionId, 'gates', 'failed', { gate: gates.gate, detail: gates.tail });
    console.log(`✗ 门红(${gates.gate ?? '见日志'}),线上保持旧版;工作树已物化的内容请按需 git checkout`);
    return;
  }
  await report(versionId, 'gates', 'ok');

  // ③ 生产构建(verify 内含构建,这里做控制台组装与产物就位)
  await report(versionId, 'build', 'running');
  try {
    execFileSync('npm', ['run', 'build:console'], { cwd: SITE, shell: true, stdio: 'pipe' });
    await report(versionId, 'build', 'ok');
  } catch (e) {
    await report(versionId, 'build', 'failed', { detail: String(e).slice(0, 500) });
    return;
  }

  /* ④ 原子切换:把已过门的 dist 提升为线上快照 dist-live(worker 伺服的是后者)。
     🔴 这一步之前,线上一直是上一版——门跑到一半时未过门的内容不会对外(验收 P0-3 的修法本体)。 */
  await report(versionId, 'swap', 'running');
  try {
    execFileSync('node', ['promote.mjs'], { cwd: here, stdio: 'pipe' });
    await report(versionId, 'swap', 'ok');
    console.log(`✓ v${versionId} 已上线(dist-live 已更新)`);
  } catch (e) {
    await report(versionId, 'swap', 'failed', { detail: `快照提升失败:${String(e).slice(0, 400)}` });
    console.log('✗ 快照提升失败,线上保持旧版');
  }
}

async function loop() {
  for (;;) {
    const { job } = await api('/api/publish/next');
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
