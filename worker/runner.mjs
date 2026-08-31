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

const api = async (p, init = {}) => {
  const res = await fetch(`${API}${p}`, { ...init, headers: { 'content-type': 'application/json', cookie: COOKIE, ...(init.headers ?? {}) } });
  if (!res.ok && res.status !== 409) throw new Error(`${p} → ${res.status}`);
  return res.json();
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

  // ④ 原子切换:V1-dev 下产物即时生效(worker 伺服 dist);Phase C 由 CI 部署后再回报
  await report(versionId, 'swap', 'running');
  await report(versionId, 'swap', 'ok');
  console.log(`✓ v${versionId} 已上线`);
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
