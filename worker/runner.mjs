#!/usr/bin/env node
/* 机器发布执行器：Bearer 领单 → 私有副本物化 → 全门 → 组装 → 已验证快照切换。
   local 常驻由启动器管理；production 由定向 GitHub workflow 运行。
   密钥只从 PUBLISH_RUNNER_TOKEN 读取，不接受 cookie，也没有任意 shell 指令开关。 */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, realpathSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { acquireLock, parseOptions, createApi, startLease, runCommand, createWorkspace, childEnvironment, runnerSourceFingerprint, processAlive } from './lib/runner-core.mjs';
import { parseJsonc } from './lib/read-jsonc.mjs';
import { directoryDigest, assertDigest, redactEvidence } from './lib/runner-artifacts.mjs';
import { encodePublishProgress } from '../schema/src/publish-feedback.ts';

function renameStateFile(source, destination) {
  // Windows readers may briefly block replacement; never delete the previous record.
  for (let attempt = 0; ; attempt++) {
    try { renameSync(source, destination); return; }
    catch (error) {
      if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= 4) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20 * 2 ** attempt);
    }
  }
}

const SITE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STOP = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => STOP.abort(new Error(`执行器收到 ${signal}，发布已中断`)));

async function main() {
  const options = parseOptions(process.argv.slice(2));
  const sourceFingerprint = await runnerSourceFingerprint(SITE);
  const hash = createHash('sha256').update(SITE.toLowerCase()).digest('hex').slice(0, 20);
  const stateDir = path.join(tmpdir(), `nexgrid-publisher-${hash}`);
  const lock = await acquireLock(stateDir);
  try {
  const recordPath = path.join(stateDir, 'job.json');
  const evidenceDir = path.join(stateDir, 'evidence');
  const runnerPath = path.join(stateDir, 'identity');
  const runnerId = existsSync(runnerPath) ? readFileSync(runnerPath, 'utf8').trim() : randomUUID();
  if (!/^[a-zA-Z0-9-]{16,80}$/.test(runnerId)) throw new Error('执行器持久身份损坏');
  writeFileSync(runnerPath, `${runnerId}\n`, { mode: 0o600 });
  const api = createApi(options);
  let record = existsSync(recordPath) ? JSON.parse(readFileSync(recordPath, 'utf8')) : null;
  let backoff = 1000;
  const secretValues = Object.entries(process.env).filter(([name]) => /TOKEN|PASSWORD|SECRET|PRIVATE_KEY|COOKIE|AUTHORIZATION|API[_-]?KEY/i.test(name)).map(([, value]) => value);
  const redact = (value) => redactEvidence(value, [options.token, record?.stamp, ...secretValues]).slice(-6000);
  const log = (message) => console.log(`[publisher ${new Date().toISOString()}] ${redact(message)}`);
  const save = (changes) => {
    record = { ...record, ...changes, updatedAt: Date.now() };
    const staging = `${recordPath}.tmp`;
    writeFileSync(staging, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    renameStateFile(staging, recordPath);
  };
  const clear = () => { rmSync(recordPath, { force: true }); record = null; };
  const evidencePathFor = (name, versionId) => {
    if (typeof name !== 'string' || !/^v[1-9]\d*-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.json$/.test(name) || !name.startsWith(`v${versionId}-`)) throw new Error('发布证据文件名与本单归属不符');
    const directory = lstatSync(evidenceDir, { throwIfNoEntry: false });
    if (directory && (!directory.isDirectory() || realpathSync(evidenceDir) !== path.join(realpathSync(stateDir), 'evidence'))) throw new Error('发布证据目录越过专用状态目录');
    const file = path.join(evidenceDir, name);
    for (const candidate of [file, `${file}.tmp`]) {
      const stat = lstatSync(candidate, { throwIfNoEntry: false });
      if (stat && (!stat.isFile() || stat.nlink !== 1)) throw new Error('发布证据必须是未链接的普通文件');
    }
    return file;
  };
  const storeEvidence = (name, evidence, stamp = record?.stamp) => {
    const file = evidencePathFor(name, evidence.versionId);
    evidence.updatedAt = new Date().toISOString();
    const safe = JSON.stringify(evidence, (_key, value) => typeof value === 'string' ? redactEvidence(value, [options.token, stamp, ...secretValues]) : value, 2);
    writeFileSync(`${file}.tmp`, safe + '\n', { mode: 0o600 });
    renameStateFile(`${file}.tmp`, file);
  };
  const readSavedEvidence = () => {
    if (record.evidenceFile == null) return null; // 旧版本任务未绑定证据，不猜测或新造文件。
    const file = evidencePathFor(record.evidenceFile, record.versionId);
    if (!existsSync(file)) return null;
    const evidence = JSON.parse(readFileSync(file, 'utf8'));
    if (evidence.versionId !== record.versionId || (evidence.apiOrigin && evidence.apiOrigin !== options.api) || (evidence.mode && evidence.mode !== options.mode)) throw new Error('发布证据正文与本单归属不符');
    return evidence;
  };
  const wait = async (ms) => { try { await delay(ms, undefined, { signal: STOP.signal }); } catch { /* 停机信号由循环处理。 */ } };
  const machineState = (signal = STOP.signal) => api(`/api/publish/runner-state?runnerId=${encodeURIComponent(runnerId)}`, undefined, signal);
  const checkEnvironment = (state) => {
    if (options.mode === 'production' ? !['prod', 'production'].includes(state.environment) : state.environment !== 'dev') throw new Error(`执行模式 ${options.mode} 与 API 环境 ${String(state.environment)} 不符，拒绝领取或切换`);
  };
  const report = async (step, status, extra = {}, signal = STOP.signal) => {
    const result = await api('/api/publish/step', { versionId: record.versionId, stamp: record.stamp, runnerId, step, status, ...extra }, signal);
    if (!result.ok) throw new Error(`服务端没有确认 ${step}/${status}`);
    return result;
  };
  const closeInterrupted = async (detail) => {
    if (!record) return;
    if (record.terminationUnconfirmed || (record.childPid && processAlive(record.childPid) !== false)) throw new Error('旧发布子进程尚未确认退出，保留记录并暂停接单');
    if (record.api && record.api !== options.api) throw new Error('中断单属于另一 API 地址；必须连接原地址收口，拒绝猜测归属');
    const savedEvidence = readSavedEvidence();
    if (!record.stamp) {
      const state = await machineState();
      if (state.activeVersion) {
        // 只为拿回响应丢失的口令；API 保证已开始任何步骤的任务不重派。
        const response = await api('/api/publish/next', { runnerId, versionId: state.activeVersion });
        if (!response.job?.stamp) throw new Error(`领取响应中断，v${state.activeVersion} 无法证明安全归属，等待服务端租约过期收口`);
        save({ versionId: response.job.versionId, stamp: response.job.stamp });
      } else { clear(); return { status: 'unresolved' }; }
    }
    try {
      const originalError = typeof savedEvidence?.error === 'string' && savedEvidence.error.trim() ? savedEvidence.error : detail;
      const result = await api('/api/publish/runner-fail', { versionId: record.versionId, stamp: record.stamp, runnerId: record.runnerId || runnerId, detail: redact(originalError) });
      if (!result.ok) throw new Error('服务端未确认中断单已收口');
      const serverStatus = ['validating', 'publishing', 'live', 'archived', 'failed', 'cancelled', 'unknown'].includes(result.status) ? result.status : null;
      const status = ['live', 'archived'].includes(serverStatus) ? 'published'
        : ['failed', 'cancelled', 'unknown'].includes(serverStatus) ? serverStatus
          : result.status == null && result.live === true ? 'published'
            : result.status == null && result.unknown === true ? 'unknown' : 'unresolved';
      const recovered = { status, serverStatus, recovered: true, recoveredAt: new Date().toISOString() };
      log(status === 'published' ? `v${record.versionId} 已由服务端核实${serverStatus === 'archived' ? '曾成功发布，现已归档' : '上线'}`
        : ['unknown', 'unresolved'].includes(status) ? `v${record.versionId} 切换结果待核实，保留恢复状态`
          : `v${record.versionId} 服务端终态为 ${serverStatus}，不会自动重复执行`);
      try {
        if (savedEvidence) storeEvidence(record.evidenceFile, { ...savedEvidence, ...recovered });
        else log(`v${record.versionId} 没有可更新的旧单证据文件，恢复结果仅记服务端确认日志`);
        if (status !== 'unresolved') clear();
      } catch (failure) { log(`已取得服务端恢复结果，证据或记录清理待恢复：${failure.message}`); }
      return recovered;
    } catch (error) {
      if (error.status === 409 || error.status === 404) {
        log(`v${record.versionId} 已不归当前执行器，保留中断记录并停止旧单`);
        if (savedEvidence) storeEvidence(record.evidenceFile, { ...savedEvidence, status: 'unresolved', recoveredAt: new Date().toISOString() });
        renameSync(recordPath, path.join(stateDir, `interrupted-${Date.now()}.json`));
        record = null;
        return { status: 'unresolved' };
      } else throw error;
    }
  };

  async function runJob(job) {
    if (!Number.isSafeInteger(job.versionId) || job.versionId <= 0 || typeof job.stamp !== 'string' || !job.stamp || !job.config) throw new Error('领取响应缺少合法版本、配置或归属口令');
    const evidenceFile = `v${job.versionId}-${randomUUID()}.json`;
    save({ versionId: job.versionId, stamp: job.stamp, runnerId, step: 'materialize', childPid: null, phase: 'claimed', evidenceFile });
    // The local API can restart during the long nine-locale browser gate; its lock lasts 15 minutes.
    const lease = startLease((signal) => api('/api/publish/heartbeat', { runnerId, versionId: job.versionId, stamp: job.stamp }, signal), { graceMs: 120000 });
    const evidenceAbort = new AbortController();
    const signal = AbortSignal.any([STOP.signal, lease.signal, evidenceAbort.signal]);
    let workspace;
    let published = false;
    let commandTail = '';
    let outputTimer;
    let progressTitle = '准备发布副本';
    let progressReports = Promise.resolve();
    let pendingProgress;
    let reportingProgress = false;
    let switching = false;
    let terminationUnconfirmed = false;
    let ownedChildPid = null;
    let firstCommandFailure;
    const evidence = {
      versionId: job.versionId, draftRev: job.draftRev ?? null, sourceKind: job.source ?? 'unknown',
      configSha: createHash('sha256').update(JSON.stringify(job.config)).digest('hex'),
      mode: options.mode, apiOrigin: options.api, runnerCodeSha: sourceFingerprint,
      runtime: { node: process.version, maglevDisabled: process.execArgv.includes('--no-maglev') },
      startedAt: new Date().toISOString(), status: 'claimed', steps: [],
    };
    const writeEvidence = (changes = {}) => {
      Object.assign(evidence, changes);
      storeEvidence(evidenceFile, evidence, job.stamp);
    };
    const confirmWithinLease = async (action, transientTimeoutMs = 30000) => {
      // A healthy heartbeat cannot make a permanently broken /step wait forever.
      const retrySignal = AbortSignal.any([signal, AbortSignal.timeout(transientTimeoutMs)]);
      let firstFailure;
      let firstServerFailureAt;
      for (;;) {
        try {
          retrySignal.throwIfAborted();
          const result = await action(retrySignal);
          retrySignal.throwIfAborted();
          return result;
        } catch (error) {
          if (retrySignal.aborted) throw signal.aborted ? signal.reason : firstFailure ?? error;
          if (!(error instanceof TypeError) && error.name !== 'TimeoutError' && !(error.status >= 500 && error.status <= 599)) throw error;
          firstFailure ??= error;
          if (error.status >= 500) {
            firstServerFailureAt ??= Date.now();
            if (Date.now() - firstServerFailureAt >= 16000) throw error;
          } else firstServerFailureAt = undefined;
          try { await delay(250, undefined, { signal: retrySignal }); }
          catch { throw signal.aborted ? signal.reason : firstFailure; }
        }
      }
    };
    const flushProgress = () => {
      clearTimeout(outputTimer); outputTimer = undefined;
      const step = record.step;
      const updatedAt = new Date().toISOString();
      writeEvidence({ progress: progressTitle, output: commandTail, progressUpdatedAt: updatedAt });
      const detail = encodePublishProgress(redact(progressTitle), redact(commandTail), updatedAt);
      pendingProgress = { step, detail };
      if (reportingProgress) return progressReports;
      reportingProgress = true;
      // Keep only the latest durable output during an outage; drain before changing steps.
      progressReports = progressReports.then(async () => {
        while (pendingProgress) {
          await confirmWithinLease(async (retrySignal) => {
            const current = pendingProgress;
            await report(current.step, 'running', { detail: current.detail }, retrySignal);
            if (pendingProgress === current) pendingProgress = undefined;
          }, 90000);
        }
      }).catch(error => {
        // Once switching starts, a transient progress outage must not replace final verification.
        if (switching && !signal.aborted && ![400, 401, 403, 404, 409].includes(error.status)) {
          writeEvidence({ progressReportError: error.message });
          log(`v${job.versionId} 切换进度暂未送达，继续核实最终结果：${error.message}`);
          return;
        }
        throw error;
      }).finally(() => { reportingProgress = false; });
      void progressReports.catch(error => evidenceAbort.abort(error));
      return progressReports;
    };
    /* 检查明细上报（进度窗数据源）：POST /api/publish/check，复用 confirmWithinLease；
       检查行是辅助证据——上报失败只记 evidence、不中断发布（P1：gates 期间 /check 持续 5xx
       不应杀死 healthy 发布；400 系归属错误仍抛，由调用方按失败收口）。 */
    const reportCheck = async (step, title, status, output) => {
      signal.throwIfAborted();
      try {
        await confirmWithinLease(retrySignal => api('/api/publish/check',
          { versionId: job.versionId, stamp: job.stamp, runnerId, step, title, status, ...(output != null ? { output } : {}) }, retrySignal));
      } catch (error) {
        if (!signal.aborted && ![400, 401, 403, 404, 409].includes(error.status)) {
          writeEvidence({ checkReportError: error.message });
          log(`v${job.versionId} 检查明细暂未送达(${error.message})，发布继续，明细缺口见证据`);
          return;
        }
        throw error;
      }
    };
    let checkReports = Promise.resolve();
    let pendingChecks = [];
    let reportingChecks = false;
    /* 检查行只增不改：全量上报、不合并（与 progress 只留最新不同）。
       同一步同标题的 running 只报一次（verify 每门首尾事件天然去重）。 */
    const seenRunning = new Set();
    const flushCheck = (check) => {
      if (check.status === 'running') {
        const key = check.step + ' ' + check.title;
        if (seenRunning.has(key)) return checkReports;
        seenRunning.add(key);
      }
      pendingChecks.push(check);
      if (reportingChecks) return checkReports;
      reportingChecks = true;
      checkReports = checkReports.then(async () => {
        while (pendingChecks.length) {
          const current = pendingChecks.shift();
          await reportCheck(current.step, current.title, current.status, current.output);
        }
      }).catch(error => { throw error; }).finally(() => { reportingChecks = false; });
      void checkReports.catch(error => evidenceAbort.abort(error));
      return checkReports;
    };
    const commandOptions = {
      signal, env: childEnvironment(),
      onChild: (pid) => {
        if (!record || record.versionId !== job.versionId || record.stamp !== job.stamp || (pid === null && record.childPid !== ownedChildPid)) throw new Error('子进程退出确认与当前发布归属不符');
        const late = pid === null && terminationUnconfirmed;
        const previous = record;
        try { save({ childPid: pid, ...(pid === null ? { terminationUnconfirmed: false } : {}) }); }
        catch (error) { record = previous; throw error; }
        ownedChildPid = pid;
        if (pid === null) {
          terminationUnconfirmed = false;
          if (late) log(`v${job.versionId} 命令树已确认退出，原失败等待恢复收口`);
        }
      },
      onProgress: async (detail) => {
        signal.throwIfAborted();
        progressTitle = redact(detail);
        await flushProgress();
      },
      onCheck: async (check) => { signal.throwIfAborted(); await flushCheck(check); },
      onCommand: (command) => {
        clearTimeout(outputTimer); outputTimer = undefined;
        terminationUnconfirmed ||= !!command.terminationUnconfirmed;
        const failed = command.phase === 'end' && Number.isInteger(command.code) && command.code !== 0 && !signal.aborted;
        if (failed) firstCommandFailure ??= new Error(`命令失败（${path.basename(command.command)}，exit ${command.code}）：${redact(commandTail).slice(-5000)}`);
        writeEvidence({ command, output: commandTail, ...(firstCommandFailure ? { error: firstCommandFailure.message } : {}) });
        log(`v${job.versionId} ${command.phase === 'start' ? '开始' : command.terminationUnconfirmed ? '停止处理中' : '结束'}：${path.basename(command.command)} ${command.args.join(' ')}${command.phase === 'end' ? ` (${Math.round(command.durationMs / 1000)} 秒，exit ${command.code})` : ''}`);
        if (failed) evidenceAbort.abort(firstCommandFailure);
        else if (command.phase === 'end' && !signal.aborted) void flushProgress();
      },
      onOutput: (value) => {
        commandTail = (commandTail + value).slice(-32000);
        if (!outputTimer) {
          outputTimer = setTimeout(() => {
            outputTimer = undefined;
            try { void flushProgress(); }
            catch (error) { evidenceAbort.abort(error); }
          }, 5000);
          outputTimer.unref();
        }
      },
    };
    const STEP_TITLES = { materialize: '准备文案与站点配置', gates: '构建并检查官网', build: '构建后台并组装发布包', swap: '切换新版并核验' };
    const begin = async (step) => {
      clearTimeout(outputTimer); outputTimer = undefined;
      await progressReports; await checkReports;
      signal.throwIfAborted(); await confirmWithinLease(retrySignal => lease.check(retrySignal)); commandTail = ''; save({ step, phase: 'running' }); await confirmWithinLease(retrySignal => report(step, 'running', {}, retrySignal));
      progressTitle = STEP_TITLES[step];
      evidence.steps.push({ step, status: 'running', at: new Date().toISOString() }); writeEvidence({ status: step });
      await flushProgress();
      await flushCheck({ step, title: STEP_TITLES[step], status: 'running' });
    };
    const passed = async (step) => { await flushProgress(); await checkReports; signal.throwIfAborted(); await confirmWithinLease(retrySignal => lease.check(retrySignal)); await confirmWithinLease(retrySignal => report(step, 'ok', {}, retrySignal)); save({ phase: 'ok' }); evidence.steps.push({ step, status: 'ok', output: commandTail, at: new Date().toISOString() }); writeEvidence(); await flushCheck({ step, title: STEP_TITLES[step], status: 'ok' }); };
    try {
      await lease.ready;
      await mkdir(evidenceDir, { recursive: true, mode: 0o700 });
      await begin('materialize');
      workspace = await createWorkspace(SITE, path.join(stateDir, 'jobs'), commandOptions);
      save({ workspace: workspace.root });
      writeEvidence({ source: workspace.sourceSnapshot });
      const site = workspace.site;
      // 领取与复制期间发生更新时，不能用进程内旧门检查磁盘上的新源码。
      if (await runnerSourceFingerprint(site) !== sourceFingerprint || await runnerSourceFingerprint(SITE) !== sourceFingerprint) {
        throw new Error('发布器代码已更新，本次任务停止，请在执行器重载后重新发布');
      }
      // 门和它的语言/进程依赖都从本单副本加载，不消费常驻进程的旧模块缓存。
      const { runGates, runNpm, runSourceBaseline, validateMaterialized } = await import(pathToFileURL(path.join(site, 'worker/lib/runner-gates.mjs')).href);
      await flushCheck({ step: 'materialize', title: 'source-equivalence', status: 'running' });
      const baseline = await runSourceBaseline(site, commandOptions);
      if (!baseline.ok) { await flushCheck({ step: 'materialize', title: 'source-equivalence', status: 'failed', output: redact(baseline.tail).slice(-4000) }); throw new Error(`源码种子基线未通过：${redact(baseline.tail).slice(-5000)}`); }
      await flushCheck({ step: 'materialize', title: 'source-equivalence', status: 'ok' });
      const { materializeI18n, materializeSiteJson } = await import(pathToFileURL(path.join(site, 'schema/src/materialize.ts')).href);
      const { LOCALES } = await import(pathToFileURL(path.join(site, 'schema/src/locales.ts')).href);
      const manifest = JSON.parse(await readFile(path.join(site, 'worker/seed/copy-manifest.json'), 'utf8'));
      for (const loc of LOCALES) await writeFile(path.join(site, `src/i18n/${loc}.json`), materializeI18n(job.config, manifest, loc));
      await mkdir(path.join(site, 'src/config'), { recursive: true });
      await writeFile(path.join(site, 'src/config/site.json'), materializeSiteJson(job.config));
      await flushCheck({ step: 'materialize', title: 'publish-config', status: 'running' });
      await flushCheck({ step: 'materialize', title: 'publish-materialization', status: 'running' });
      const materialized = await validateMaterialized(site, job.config);
      if (!materialized.ok) { const failedTitle = materialized.gate ?? 'publish-materialization'; const otherTitle = failedTitle === 'publish-config' ? 'publish-materialization' : 'publish-config'; await flushCheck({ step: 'materialize', title: failedTitle, status: 'failed', output: redact(materialized.tail).slice(-4000) }); await flushCheck({ step: 'materialize', title: otherTitle, status: 'skipped' }); throw new Error(`${materialized.gate}：${materialized.tail}`); }
      await flushCheck({ step: 'materialize', title: 'publish-config', status: 'ok' });
      await flushCheck({ step: 'materialize', title: 'publish-materialization', status: 'ok' });
      const { MATERIALIZED_FILES } = await import(pathToFileURL(path.join(site, 'schema/src/locales.ts')).href);
      const parts = await Promise.all(MATERIALIZED_FILES.map(async (rel) => `${rel}\0${await readFile(path.join(site, rel), 'utf8')}`));
      writeEvidence({ materializedConfigSha: createHash('sha256').update(parts.join('\0')).digest('hex') });
      await passed('materialize');
      await begin('gates');
      // 完整复制摘要覆盖业务源码、门脚本和静态资产；执行器重载指纹不能证明这些输入未变。
      const gateCachePath = path.join(stateDir, 'last-full-gates.json');
      const sourceSha = workspace.sourceSnapshot.sha256;
      let sourceUnchanged = false;
      try { sourceUnchanged = JSON.parse(readFileSync(gateCachePath, 'utf8'))?.sourceSha === sourceSha; }
      catch { sourceUnchanged = false; }
      const changeTier = job.changeTier === 'content-only' ? 'content-only' : 'config-shape';
      log(`v${job.versionId} 正在隔离副本执行${changeTier === 'content-only' && sourceUnchanged ? '增量(文案改动)' : '完整'}发布门`);
      const gates = await runGates(site, options.mode, commandOptions, { changeTier, sourceUnchanged });
      if (!gates.ok) { await flushCheck({ step: 'gates', title: gates.gate ?? '发布门', status: 'failed', output: redact(gates.tail ?? '').slice(-4000) }); throw new Error(`门未通过(${gates.gate})：${redact(gates.tail).slice(-5000)}`); }
      assertDigest(path.join(site, 'dist'), gates.artifact?.sha256);
      writeEvidence({ websiteArtifact: gates.artifact, changeTier, gateSkipped: gates.skipped ?? [] });
      if ((gates.skipped ?? []).length === 0) {
        try { writeFileSync(gateCachePath, JSON.stringify({ sourceSha, versionId: job.versionId, at: new Date().toISOString() })); }
        catch { /* 指纹落盘失败不影响本次发布,下次自动回全量 */ }
      }
      await passed('gates');
      await begin('build');
      const built = await runNpm(['run', 'build:console'], { ...commandOptions, cwd: site });
      if (built.code !== 0 || built.aborted) throw new Error(`控制台构建失败：${redact(built.output).slice(-5000)}`);
      assertDigest(path.join(site, 'dist'), gates.artifact.sha256, { exclude: ['admin', '.publish-stamp.json'] });
      assertDigest(path.join(site, 'dist/admin'), directoryDigest(path.join(site, 'admin/dist')).sha256);
      const finalArtifact = directoryDigest(path.join(site, 'dist'));
      writeEvidence({ finalArtifact });
      await passed('build');
      let deployment;
      if (options.mode === 'production') {
        const declared = parseJsonc(readFileSync(path.resolve(options.wranglerConfig), 'utf8'), 'PUBLISH_WRANGLER_CONFIG');
        if (!['prod', 'production'].includes(declared.vars?.ENVIRONMENT)) throw new Error('指定部署配置不是 production 环境');
        const { writeProductionConfig } = await import(pathToFileURL(path.join(site, 'worker/production-config.mjs')).href);
        deployment = writeProductionConfig({ outputFile: path.join(workspace.root, 'wrangler.production.json'), env: process.env, projectRoot: site });
      }
      await begin('swap');
      switching = true;
      const state = await confirmWithinLease(retrySignal => machineState(retrySignal)); checkEnvironment(state);
      if (state.activeVersion !== job.versionId) throw new Error('服务端已不再确认本次任务归属，禁止切换');
      await confirmWithinLease(retrySignal => lease.check(retrySignal)); signal.throwIfAborted();
      const promoted = await runCommand(process.execPath, [path.join(site, 'worker/promote.mjs'), '--source', path.join(site, 'dist'), '--live', path.join(options.mode === 'production' ? site : SITE, 'dist-live'), '--materialized-root', site, '--version', String(job.versionId), '--expected-sha', finalArtifact.sha256], { ...commandOptions, cwd: site, env: { ...childEnvironment(), PUBLISH_STAMP: job.stamp } });
      if (promoted.code !== 0 || promoted.aborted) throw new Error(`快照准备或提升失败：${promoted.output}`);
      if (options.mode === 'production') {
        await confirmWithinLease(retrySignal => lease.check(retrySignal)); signal.throwIfAborted();
        const deployed = await runCommand(process.execPath, [path.join(site, 'worker/node_modules/wrangler/bin/wrangler.js'), 'deploy', '--config', deployment.outputFile, '--assets', path.join(site, 'dist-live')], { ...commandOptions, cwd: path.join(site, 'worker') });
        if (deployed.code !== 0 || deployed.aborted) throw new Error(`公网部署未被证明成功：${deployed.output}`);
      }
      // 切换期间 API 可短暂重启。只重放终态汇报，不重做部署。
      clearTimeout(outputTimer); outputTimer = undefined;
      await progressReports;
      signal.throwIfAborted();
      lease.stop();
      for (let attempt = 0; ; attempt++) {
        try { await report('swap', 'ok'); break; }
        catch (error) {
          if ([400, 401, 403, 404, 409].includes(error.status) || attempt >= 5) throw error;
          await wait(1000 * (attempt + 1));
        }
      }
      published = true;
      writeEvidence({ status: 'published', finishedAt: new Date().toISOString(), output: commandTail });
      log(`v${job.versionId} ${options.mode === 'production' ? '公网部署' : '本地快照'}已由服务端核实`);
      clear(); return true;
    } catch (error) {
      clearTimeout(outputTimer); outputTimer = undefined;
      const cause = firstCommandFailure ?? (signal.aborted ? signal.reason : error);
      const failureMessage = cause instanceof Error ? cause.message : String(cause);
      try { await flushCheck({ step: record.step, title: STEP_TITLES[record.step] ?? record.step, status: 'failed', output: redact(failureMessage).slice(-4000) }); } catch { /* 检查行是辅助证据，收口失败不掩盖主错误；须在 evidenceAbort 前上报，否则 signal 已中断直接吞掉 */ }
      evidenceAbort.abort(cause);
      await progressReports.catch(() => {});
      if (published) {
        log(`v${job.versionId} 已由服务端核实发布，记录清理待恢复：${error.message}`);
        return true;
      }
      try { writeEvidence({ status: 'unresolved', error: failureMessage, output: commandTail, finishedAt: new Date().toISOString() }); }
      catch (failure) { log(`失败证据保存待恢复：${failure.message}`); }
      log(`v${job.versionId} ${terminationUnconfirmed ? '停止处理中，命令树退出待确认' : '停止'}：${redact(failureMessage)}`);
      lease.stop(); save({ phase: 'interrupted' });
      if (terminationUnconfirmed) {
        save({ terminationUnconfirmed: true });
        STOP.abort(new Error('发布子进程退出未确认，保留现场并停止接单'));
        return false;
      }
      try {
        const recovered = await closeInterrupted(failureMessage);
        published = recovered?.status === 'published';
        Object.assign(evidence, recovered);
      } catch (failure) { log(`中断状态待网络恢复后收口：${failure.message}`); }
      return published;
    } finally {
      clearTimeout(outputTimer);
      lease.stop();
      if (workspace && !terminationUnconfirmed) {
        try { await workspace.cleanup(); }
        catch (error) {
          log(`v${job.versionId} 隔离目录清理待恢复：${error.message}`);
          try { writeEvidence({ cleanupError: error.message }); } catch (failure) { log(`清理证据保存待恢复：${failure.message}`); }
        }
      }
    }
  }

    log(`启动 ${options.mode} 执行器，API ${options.api}，身份 ${runnerId}，代码 ${sourceFingerprint.slice(0, 12)}`);
    while (!STOP.signal.aborted) {
      try {
        if (record) {
          const recovered = await closeInterrupted('执行器中断后恢复；原发布单不自动重跑');
          if (options.once) { process.exitCode = recovered?.status === 'published' ? 0 : 1; break; }
          if (record) { await wait(1000); continue; }
        }
        if (await runnerSourceFingerprint(SITE) !== sourceFingerprint) {
          log('发布器代码已更新，已停止领单，退出后由启动器重载');
          if (options.once) process.exitCode = 1;
          break;
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
