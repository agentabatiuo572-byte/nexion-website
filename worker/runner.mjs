#!/usr/bin/env node
/* 机器发布执行器：Bearer 领单 → 私有副本物化 → 全门 → 组装 → 已验证快照切换。
   local 常驻由启动器管理；production 由定向 GitHub workflow 运行。
   密钥只从 PUBLISH_RUNNER_TOKEN 读取，不接受 cookie，也没有任意 shell 指令开关。 */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { acquireLock, parseOptions, createApi, startLease, runCommand, createWorkspace, childEnvironment } from './lib/runner-core.mjs';
import { runGates, runNpm, runSourceBaseline, validateMaterialized } from './lib/runner-gates.mjs';
import { parseJsonc } from './lib/read-jsonc.mjs';

const SITE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STOP = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => STOP.abort(new Error(`执行器收到 ${signal}，发布已中断`)));

async function main() {
  const options = parseOptions(process.argv.slice(2));
  const hash = createHash('sha256').update(SITE.toLowerCase()).digest('hex').slice(0, 20);
  const stateDir = path.join(tmpdir(), `nexgrid-publisher-${hash}`);
  const lock = await acquireLock(stateDir);
  try {
  const recordPath = path.join(stateDir, 'job.json');
  const runnerPath = path.join(stateDir, 'identity');
  const runnerId = existsSync(runnerPath) ? readFileSync(runnerPath, 'utf8').trim() : randomUUID();
  if (!/^[a-zA-Z0-9-]{16,80}$/.test(runnerId)) throw new Error('执行器持久身份损坏');
  writeFileSync(runnerPath, `${runnerId}\n`, { mode: 0o600 });
  const api = createApi(options);
  let record = existsSync(recordPath) ? JSON.parse(readFileSync(recordPath, 'utf8')) : null;
  let backoff = 1000;
  const redact = (value) => {
    let text = String(value);
    for (const secret of [options.token, record?.stamp, process.env.CLOUDFLARE_API_TOKEN]) if (secret) text = text.split(secret).join('[redacted]');
    return text.slice(-6000);
  };
  const log = (message) => console.log(`[publisher ${new Date().toISOString()}] ${redact(message)}`);
  const save = (changes) => {
    record = { ...record, ...changes, updatedAt: Date.now() };
    const staging = `${recordPath}.tmp`;
    writeFileSync(staging, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    renameSync(staging, recordPath);
  };
  const clear = () => { rmSync(recordPath, { force: true }); record = null; };
  const wait = async (ms) => { try { await delay(ms, undefined, { signal: STOP.signal }); } catch { /* 停机信号由循环处理。 */ } };
  const machineState = () => api(`/api/publish/runner-state?runnerId=${encodeURIComponent(runnerId)}`, undefined, STOP.signal);
  const checkEnvironment = (state) => {
    if (options.mode === 'production' ? !['prod', 'production'].includes(state.environment) : state.environment !== 'dev') throw new Error(`执行模式 ${options.mode} 与 API 环境 ${String(state.environment)} 不符，拒绝领取或切换`);
  };
  const report = async (step, status, extra = {}) => {
    const result = await api('/api/publish/step', { versionId: record.versionId, stamp: record.stamp, runnerId, step, status, ...extra });
    if (!result.ok) throw new Error(`服务端没有确认 ${step}/${status}`);
    return result;
  };
  const closeInterrupted = async (detail) => {
    if (!record) return;
    if (record.api && record.api !== options.api) throw new Error('中断单属于另一 API 地址；必须连接原地址收口，拒绝猜测归属');
    if (!record.stamp) {
      const state = await machineState();
      if (state.activeVersion) {
        // 只为拿回响应丢失的口令；API 保证已开始任何步骤的任务不重派。
        const response = await api('/api/publish/next', { runnerId, versionId: state.activeVersion });
        if (!response.job?.stamp) throw new Error(`领取响应中断，v${state.activeVersion} 无法证明安全归属，等待服务端租约过期收口`);
        save({ versionId: response.job.versionId, stamp: response.job.stamp });
      } else { clear(); return; }
    }
    try {
      const result = await api('/api/publish/runner-fail', { versionId: record.versionId, stamp: record.stamp, runnerId: record.runnerId || runnerId, detail: redact(detail) });
      if (!result.ok) throw new Error('服务端未确认中断单已收口');
      log(result.live ? `v${record.versionId} 已由服务端核实上线，恢复记录已收口` : result.unknown ? `v${record.versionId} 切换结果待核实，已封住后续发布` : `v${record.versionId} 中断记录已收口，不会自动重复执行`);
      clear();
    } catch (error) {
      if (error.status === 409 || error.status === 404) {
        log(`v${record.versionId} 已不归当前执行器，保留中断记录并停止旧单`);
        renameSync(recordPath, path.join(stateDir, `interrupted-${Date.now()}.json`));
        record = null;
      } else throw error;
    }
  };

  async function runJob(job) {
    if (!Number.isSafeInteger(job.versionId) || job.versionId <= 0 || typeof job.stamp !== 'string' || !job.stamp || !job.config) throw new Error('领取响应缺少合法版本、配置或归属口令');
    save({ versionId: job.versionId, stamp: job.stamp, runnerId, step: 'materialize', childPid: null, phase: 'claimed' });
    const lease = startLease((signal) => api('/api/publish/heartbeat', { runnerId, versionId: job.versionId, stamp: job.stamp }, signal));
    const signal = AbortSignal.any([STOP.signal, lease.signal]);
    let workspace;
    const commandOptions = { signal, onChild: (pid) => save({ childPid: pid }), env: childEnvironment() };
    const begin = async (step) => {
      signal.throwIfAborted(); await lease.check(); save({ step, phase: 'running' }); await report(step, 'running');
    };
    const passed = async (step) => { signal.throwIfAborted(); await lease.check(); await report(step, 'ok'); save({ phase: 'ok' }); };
    try {
      await lease.ready;
      await begin('materialize');
      workspace = await createWorkspace(SITE, path.join(stateDir, 'jobs'), commandOptions);
      save({ workspace: workspace.root });
      const site = workspace.site;
      const baseline = await runSourceBaseline(site, commandOptions);
      if (!baseline.ok) throw new Error(`源码种子基线未通过：${baseline.tail}`);
      const { materializeI18n, materializeSiteJson } = await import(pathToFileURL(path.join(site, 'schema/src/materialize.ts')).href);
      const manifest = JSON.parse(await readFile(path.join(site, 'worker/seed/copy-manifest.json'), 'utf8'));
      for (const loc of ['en', 'vi', 'zh']) await writeFile(path.join(site, `src/i18n/${loc}.json`), materializeI18n(job.config, manifest, loc));
      await mkdir(path.join(site, 'src/config'), { recursive: true });
      await writeFile(path.join(site, 'src/config/site.json'), materializeSiteJson(job.config));
      const materialized = await validateMaterialized(site, job.config);
      if (!materialized.ok) throw new Error(`${materialized.gate}：${materialized.tail}`);
      await passed('materialize');
      await begin('gates');
      log(`v${job.versionId} 正在隔离副本执行完整发布门`);
      const gates = await runGates(site, options.mode, commandOptions);
      if (!gates.ok) throw new Error(`门未通过(${gates.gate})：${gates.tail}`);
      await passed('gates');
      await begin('build');
      const built = await runNpm(['run', 'build:console'], { ...commandOptions, cwd: site });
      if (built.code !== 0 || built.aborted) throw new Error(`控制台构建失败：${built.output}`);
      await passed('build');
      let deployment;
      if (options.mode === 'production') {
        const declared = parseJsonc(readFileSync(path.resolve(options.wranglerConfig), 'utf8'), 'PUBLISH_WRANGLER_CONFIG');
        if (!['prod', 'production'].includes(declared.vars?.ENVIRONMENT)) throw new Error('指定部署配置不是 production 环境');
        const { writeProductionConfig } = await import(pathToFileURL(path.join(site, 'worker/production-config.mjs')).href);
        deployment = writeProductionConfig({ outputFile: path.join(workspace.root, 'wrangler.production.json'), env: process.env, projectRoot: site });
      }
      await begin('swap');
      const state = await machineState(); checkEnvironment(state);
      if (state.activeVersion !== job.versionId) throw new Error('服务端已不再确认本次任务归属，禁止切换');
      await lease.check(); signal.throwIfAborted();
      const promoted = await runCommand(process.execPath, [path.join(site, 'worker/promote.mjs'), '--source', path.join(site, 'dist'), '--live', path.join(options.mode === 'production' ? site : SITE, 'dist-live'), '--materialized-root', site, '--version', String(job.versionId)], { ...commandOptions, cwd: site, env: { ...childEnvironment(), PUBLISH_STAMP: job.stamp } });
      if (promoted.code !== 0 || promoted.aborted) throw new Error(`快照准备或提升失败：${promoted.output}`);
      if (options.mode === 'production') {
        await lease.check();
        const deployed = await runCommand(process.execPath, [path.join(site, 'worker/node_modules/wrangler/bin/wrangler.js'), 'deploy', '--config', deployment.outputFile, '--assets', path.join(site, 'dist-live')], { ...commandOptions, cwd: path.join(site, 'worker') });
        if (deployed.code !== 0 || deployed.aborted) throw new Error(`公网部署未被证明成功：${deployed.output}`);
      }
      // 切换期间 API 可短暂重启。只重放终态汇报，不重做部署。
      signal.throwIfAborted();
      lease.stop();
      for (let attempt = 0; ; attempt++) {
        try { await report('swap', 'ok'); break; }
        catch (error) {
          if ([400, 401, 403, 404, 409].includes(error.status) || attempt >= 5) throw error;
          await wait(1000 * (attempt + 1));
        }
      }
      log(`v${job.versionId} ${options.mode === 'production' ? '公网部署' : '本地快照'}已由服务端核实`);
      clear(); return true;
    } catch (error) {
      log(`v${job.versionId} 停止：${redact(error.message)}`);
      lease.stop(); save({ phase: 'interrupted', childPid: null });
      try { await closeInterrupted(error.message); } catch (failure) { log(`中断状态待网络恢复后收口：${failure.message}`); }
      return false;
    } finally {
      lease.stop();
      if (workspace) await workspace.cleanup();
    }
  }

    log(`启动 ${options.mode} 执行器，API ${options.api}，身份 ${runnerId}`);
    while (!STOP.signal.aborted) {
      try {
        if (record) {
          await closeInterrupted('执行器中断后恢复；原发布单不自动重跑');
          if (options.once) { process.exitCode = 1; break; }
        }
        const state = await machineState(); checkEnvironment(state);
        await api('/api/publish/heartbeat', { runnerId }, STOP.signal);
        save({ phase: 'claiming', runnerId, versionId: options.versionId ?? null, stamp: null, childPid: null, api: options.api });
        const next = await api('/api/publish/next', { runnerId, ...(options.versionId ? { versionId: options.versionId } : {}) }, STOP.signal);
        if (next.job) {
          log(`领取 v${next.job.versionId}`);
          const ok = await runJob(next.job);
          if (options.once) { process.exitCode = ok ? 0 : 1; break; }
        } else {
          clear();
          if (options.once) { log(options.versionId ? '指定版本没有可领取任务' : '无待处理任务'); process.exitCode = options.versionId ? 1 : 0; break; }
        }
        backoff = 1000; await wait(3000);
      } catch (error) {
        if (STOP.signal.aborted) break;
        log(error.message);
        if (options.once) { process.exitCode = 1; break; }
        await wait(backoff); backoff = Math.min(backoff * 2, 30000);
      }
    }
  } finally { await lock.release(); }
}

main().catch((error) => { console.error(`发布执行器停止：${error.message}`); process.exitCode = 1; });
