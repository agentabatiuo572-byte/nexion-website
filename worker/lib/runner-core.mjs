/* 发布执行器的可独立验证接缝。所有命令使用 argv，机器凭据只发给指定 API。 */
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { fileManifest } from './runner-artifacts.mjs';

/** 常驻进程的已加载代码必须与下一单源码一致；产物和运行状态不参与重载判断。 */
export async function runnerSourceFingerprint(site) {
  const files = ['package.json', 'package-lock.json', 'worker/package.json', 'worker/package-lock.json', 'schema/package.json'];
  for (const dir of ['worker', 'worker/lib', 'schema/src']) {
    const entries = await fs.readdir(path.join(site, dir), { recursive: dir !== 'worker', withFileTypes: true });
    for (const entry of entries) {
      const sourceFile = (dir === 'worker' ? /\.mjs$/ : /\.(?:mjs|ts)$/).test(entry.name);
      if (entry.isFile() && sourceFile) files.push(path.relative(site, path.join(entry.parentPath, entry.name)).replaceAll(path.sep, '/'));
      else if (entry.isSymbolicLink() && (dir !== 'worker' || sourceFile)) throw new Error('发布执行器源码不得使用符号链接');
    }
  }
  const hash = createHash('sha256');
  for (const rel of files.sort()) {
    hash.update(rel + '\0');
    try { hash.update(await fs.readFile(path.join(site, rel))); }
    catch (error) { if (error.code !== 'ENOENT') throw error; hash.update('[missing]'); }
    hash.update('\0');
  }
  return hash.digest('hex');
}

export function parseOptions(argv, env = process.env) {
  const known = new Set(['--api', '--once', '--version']);
  const values = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (!known.has(key)) throw new Error(`未知参数 ${key}；执行器只接受机器身份，不支持 cookie`);
    if (key === '--once') values.once = true;
    else {
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw new Error(`${key} 缺少值`);
      values[key.slice(2)] = value;
    }
  }
  const token = env.PUBLISH_RUNNER_TOKEN;
  if (!token || Buffer.byteLength(token) < 32 || token.trim() !== token || /[\r\n]/.test(token)) {
    throw new Error('PUBLISH_RUNNER_TOKEN 必须是至少 32 字节的机器密钥');
  }
  const mode = env.PUBLISH_MODE || 'local';
  if (!['local', 'production'].includes(mode)) throw new Error('PUBLISH_MODE 只支持 local 或 production');
  const api = new URL(values.api || env.PUBLISH_API_URL || 'http://127.0.0.1:8787');
  if (!['http:', 'https:'].includes(api.protocol) || api.username || api.password || api.search || api.hash || api.pathname !== '/') {
    throw new Error('PUBLISH_API_URL 必须是无凭据、无路径参数的 HTTP(S) origin');
  }
  if (mode === 'local' && !['127.0.0.1', 'localhost', '[::1]'].includes(api.hostname)) throw new Error('local 模式只允许 loopback API');
  if (mode === 'production' && api.protocol !== 'https:') throw new Error('production API 必须使用 HTTPS');
  const versionId = values.version === undefined ? undefined : Number(values.version);
  if (versionId !== undefined && (!Number.isSafeInteger(versionId) || versionId <= 0)) throw new Error('--version 必须是正整数');
  if (mode === 'production' && !env.PUBLISH_WRANGLER_CONFIG) throw new Error('production 必须指定 PUBLISH_WRANGLER_CONFIG');
  if (mode === 'production' && (!values.once || !versionId)) throw new Error('production 必须用 --once --version 定向领取本次 CI 的发布单');
  return { api: api.origin, token, mode, versionId, once: !!values.once, wranglerConfig: env.PUBLISH_WRANGLER_CONFIG, requestTimeoutMs: 8000 };
}

export const processAlive = (pid) => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'ESRCH' ? false : null; }
};

export async function acquireLock(stateDir) {
  await fs.mkdir(stateDir, { recursive: true, mode: 0o700 });
  // OS 持有监听 socket：进程崩溃会自动释放，也串行化陈旧 PID 文件的回收。
  // Windows 使用命名管道，避免哈希 TCP 端口与浏览器临时端口/系统保留端口冲突。
  const hash = createHash('sha256').update(path.resolve(stateDir).toLowerCase()).digest();
  const port = 30000 + hash.readUInt16BE(0) % 30000;
  const server = createServer((socket) => socket.destroy());
  await new Promise((resolve, reject) => {
    server.once('error', (error) => reject(new Error(`发布执行器已运行或互斥资源不可用，拒绝双开 (${error.code})`)));
    if (process.platform === 'win32') server.listen(`\\\\.\\pipe\\nexgrid-publisher-${hash.toString('hex')}`, resolve);
    else server.listen(port, '127.0.0.1', resolve);
  });
  const lockPath = path.join(stateDir, 'runner.lock');
  const nonce = randomUUID();
  const close = () => new Promise((resolve) => server.close(resolve));
  try {
    let previous;
    try { previous = JSON.parse(await fs.readFile(lockPath, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw new Error('执行器锁归属未知，无法确认原进程已退出'); }
    if (previous && processAlive(previous.pid) !== false) throw new Error('原执行器仍活跃或进程归属无法确认');
    let record;
    try { record = JSON.parse(await fs.readFile(path.join(stateDir, 'job.json'), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw new Error('发布工作记录损坏，无法确认遗留子进程'); }
    // IPC 监护进程在原 runner 退出后清理子树；给它一个有界的退出窗口。
    if (record?.childPid) {
      for (let i = 0; i < 20 && processAlive(record.childPid) === true; i++) await delay(250);
      if (processAlive(record.childPid) !== false) throw new Error('原发布子进程仍活跃或归属无法确认，禁止并发写入');
    }
    await fs.writeFile(lockPath, `${JSON.stringify({ pid: process.pid, nonce, at: Date.now() })}\n`, { mode: 0o600 });
    return {
      async release() {
        try {
          const current = JSON.parse(await fs.readFile(lockPath, 'utf8'));
          if (current.nonce === nonce) await fs.rm(lockPath);
        } finally { await close(); }
      },
    };
  } catch (error) { await close(); throw error; }
}

export function createApi(options, fetchImpl = fetch) {
  return async (endpoint, body, signal) => {
    const timeout = AbortSignal.timeout(options.requestTimeoutMs ?? 8000);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const payload = body === undefined ? undefined : JSON.stringify(body);
    let lastFailure;
    // Machine endpoints are idempotent; a brief API restart shares one deadline across retries.
    for (let attempt = 0; ; attempt++) {
      try {
        combined.throwIfAborted();
        const response = await fetchImpl(`${options.api}${endpoint}`, {
          method: body === undefined ? 'GET' : 'POST', redirect: 'manual', signal: combined,
          headers: { 'content-type': 'application/json', authorization: `Bearer ${options.token}` },
          ...(payload === undefined ? {} : { body: payload }),
        });
        if (!response.ok) {
          // 服务端错误体可能反射凭据，不将其原文放日志。
          let preparation = '';
          if (endpoint === '/api/publish/heartbeat' && !body?.versionId && [409, 503].includes(response.status)) {
            const failure = await response.json().catch(() => null);
            if (failure?.error === 'config-upgrade-conflict') preparation = '：草稿升级存在冲突，等待后台处理后重试';
            if (failure?.error === 'config-upgrade-retry') preparation = '：草稿准备暂未成功，稍后重试';
          }
          await response.body?.cancel().catch(() => {});
          const error = new Error(`${endpoint.split('?')[0]} HTTP ${response.status}${[401, 403].includes(response.status) ? '：机器身份鉴权失败，请检查密钥配置' : preparation}`);
          error.status = response.status;
          throw error;
        }
        try { return await response.json(); }
        catch (error) {
          if (error instanceof TypeError) throw error; // Response stream disconnected; replay the same request.
          throw new Error(`${endpoint.split('?')[0]} 返回无效 JSON`);
        }
      } catch (error) {
        if (combined.aborted) throw signal?.aborted ? signal.reason : lastFailure ?? combined.reason;
        if (!(error instanceof TypeError) && !(error.status >= 500 && error.status <= 599)) throw error;
        lastFailure = error;
        try { await delay(Math.min(250 * 2 ** attempt, 1000), undefined, { signal: combined }); }
        catch { throw signal?.aborted ? signal.reason : lastFailure; }
      }
    }
  };
}

export function startLease(renew, { intervalMs = 10000, graceMs = 30000, requestTimeoutMs = 8000 } = {}) {
  const controller = new AbortController();
  let stopped = false;
  let timer;
  let lastSuccess = Date.now();
  let active = Promise.resolve();
  const fail = (error) => { if (!controller.signal.aborted) controller.abort(error); };
  const attempt = async (confirmationSignal) => {
    if (stopped || controller.signal.aborted) return;
    try {
      const timeout = AbortSignal.timeout(requestTimeoutMs);
      const signal = AbortSignal.any([controller.signal, timeout, ...(confirmationSignal ? [confirmationSignal] : [])]);
      signal.throwIfAborted();
      let onAbort;
      const deadline = new Promise((_, reject) => { onAbort = () => reject(signal.reason); signal.addEventListener('abort', onAbort, { once: true }); });
      try { await Promise.race([renew(signal), deadline]); }
      finally { signal.removeEventListener('abort', onAbort); }
      lastSuccess = Date.now();
    } catch (error) {
      if ([400, 401, 403, 404, 409].includes(error.status) || Date.now() - lastSuccess >= graceMs) fail(error);
      throw error;
    }
  };
  const schedule = () => {
    if (stopped || controller.signal.aborted) return;
    timer = setTimeout(() => {
      active = attempt().catch(() => {}).finally(schedule);
    }, Math.min(intervalMs, graceMs));
  };
  const ready = attempt().then(schedule);
  return {
    signal: controller.signal, ready,
    async check(signal) {
      let onAbort;
      const cancelled = new Promise((_, reject) => {
        if (signal) { onAbort = () => reject(signal.reason); signal.addEventListener('abort', onAbort, { once: true }); }
      });
      try {
        signal?.throwIfAborted();
        await Promise.race([active, cancelled]);
        if (controller.signal.aborted) throw controller.signal.reason;
        await attempt(signal);
      } finally { if (onAbort) signal.removeEventListener('abort', onAbort); }
    },
    stop() { stopped = true; clearTimeout(timer); },
  };
}

export function childEnvironment(env = process.env) {
  const safe = { ...env };
  for (const name of Object.keys(safe)) {
    if (/^(?:AI_|OPENAI_)/i.test(name)) delete safe[name];
  }
  delete safe.PUBLISH_RUNNER_TOKEN;
  delete safe.PUBLISH_STAMP;
  // 发布门不等待 Wrangler 的版本提示或遥测联网；父环境的反向设置也不能重新开启。
  safe.WRANGLER_HIDE_BANNER = 'true';
  safe.WRANGLER_SEND_METRICS = 'false';
  return safe;
}

export async function killProcessTree(pid) {
  if (!pid || processAlive(pid) === false) return;
  if (process.platform === 'win32') {
    await new Promise((resolve, reject) => {
      const killer = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 5000 });
      killer.once('error', reject);
      killer.once('close', (code) => code === 0 ? resolve() : reject(new Error(`taskkill 退出码 ${code ?? '未知'}`)));
    });
  } else {
    try { process.kill(-pid, 'SIGKILL'); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
  for (let i = 0; i < 40 && processAlive(pid) === true; i++) await delay(25);
  if (processAlive(pid) !== false) throw new Error(`进程 ${pid} 仍活跃或退出状态未知`);
}

export function runCommand(command, args, { cwd, signal, env = childEnvironment(), onChild, onOutput, onCommand, onProgress, onCheck, maxOutput = 32 * 1024, timeoutMs = 30 * 60 * 1000 } = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2 ** 31 - 1) throw new Error('命令 timeoutMs 必须是 1 至 2147483647 的整数毫秒');
  if (signal?.aborted) return Promise.resolve({ code: null, output: '发布已中断', aborted: true, timedOut: false });
  return new Promise((resolve) => {
    const started = performance.now();
    const details = { command, args, cwd, startedAt: new Date().toISOString(), timeoutMs };
    let output = '';
    let truncated = false;
    let timedOut = false;
    let child;
    let killing;
    let timer;
    let resolved = false;
    let finishing = false;
    let childClosed = false;
    let stopConfirmed = false;
    let terminationUnconfirmed = false;
    let childCleared = false;
    let progressReader;
    let progressWork = Promise.resolve();
    let pendingProgressDetail;
    let progressRunning = false;
    let progressFailed = false;
    let progressCancelled = false;
    let cancelProgress;
    const progressStopped = new Promise((stop) => { cancelProgress = stop; });
    /* 检查明细事件([publish-check])与进度([publish-progress])走同一 stdout 行流：
       按序解析、全量经 onCheck 透出（不合并、不丢弃——每条都是落库行）。
       校验口径与 progress 同例：title 非空、status 合法，不合法记 failProgress。 */
    let checkWork = Promise.resolve();
    let checking = false;
    let pendingChecks = [];
    let markClosed;
    const closed = new Promise((resolveClosed) => { markClosed = resolveClosed; });
    let markStopped;
    const stopped = new Promise(resolveStopped => { markStopped = resolveStopped; });
    const clearChild = () => { if (!childCleared) { onChild?.(null); childCleared = true; } };
    const confirmLateStop = () => {
      if (!resolved || !terminationUnconfirmed || !stopConfirmed || !childClosed) return;
      try { clearChild(); }
      catch { console.error('发布子进程退出确认未能持久化，保留原记录'); }
    };
    const requestStop = async () => {
      let stopTimer;
      // IPC retains the watchdog until it confirms its actual command tree is closed.
      child.send('stop', () => {});
      try {
        await Promise.race([
          Promise.all([stopped, closed]),
          new Promise((_, reject) => { stopTimer = setTimeout(() => reject(new Error('监护进程尚未确认命令树及输出通道退出')), 5000); }),
        ]);
      } finally { clearTimeout(stopTimer); }
    };
    const finish = async (result) => {
      if (finishing) return;
      finishing = true;
      /* 失败也先排空已解析的 [publish-check] 终态行（failed 配对 running），再停进度上报；
         但排空有界（5s）：onCheck 挂起（如上报链断）不能卡住 finish 收口（P1 回归：无界 drain 挂死测试）。 */
      try { await Promise.race([checkWork, delay(5000)]); }
      catch { /* checkWork 内部已 failProgress 落盘，不再抛 */ }
      if (Number.isInteger(result.code) && result.code !== 0) {
        progressCancelled = true;
        pendingProgressDetail = undefined;
        pendingChecks = [];
        cancelProgress();
      } else await Promise.race([Promise.all([progressWork, checkWork]), progressStopped]);
      signal?.removeEventListener('abort', abort);
      progressReader?.close();
      if (killing) {
        try { await killing; }
        catch (error) { output += `\n子树终止未确认：${error.message}`; result.code = null; terminationUnconfirmed = true; }
      }
      if (timedOut) output += `\n命令超过最长执行时间 ${timeoutMs}ms，已停止本次发布`;
      if (timedOut || signal?.aborted || progressFailed) result.code = null;
      resolved = true;
      // 无法确认退出时保留归属记录，不能让后续任务误判旧子树已消失。
      try { if (!terminationUnconfirmed) clearChild(); }
      catch (error) { output += `\n子进程记录未收口：${error.message}`; result.code = null; }
      const status = { ...result, aborted: !!signal?.aborted, timedOut, terminationUnconfirmed };
      try { onCommand?.({ ...details, phase: 'end', durationMs: Math.round(performance.now() - started), ...status }); }
      catch (error) { output += `\n命令进度未收口：${error.message}`; status.code = null; }
      // 熔丝覆盖 drain 全程，收口才清：既不断未完成 onProgress 的超时截断，也不留 timer 拖住进程退出。
      clearTimeout(timer);
      resolve({ ...status, output, truncated });
    };
    const abort = () => {
      if (resolved) return;
      progressCancelled = true;
      pendingProgressDetail = undefined;
      pendingChecks = [];
      cancelProgress();
      if (!childClosed && child) killing ??= requestStop();
      void finish({ code: null });
    };
    try {
      child = spawn(process.execPath, [fileURLToPath(new URL('./runner-child.mjs', import.meta.url)), command, ...args], { cwd, env, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    } catch (error) { output = error.message; void finish({ code: null }); return; }
    const collect = (chunk) => {
      const value = chunk.toString();
      truncated ||= output.length + value.length > maxOutput;
      output = (output + value).slice(-maxOutput);
      try { if (!resolved) onOutput?.(value); }
      catch (error) { output += `\n命令输出未能持久化：${error.message}`; abort(); }
    };
    child.stdout.on('data', collect); child.stderr.on('data', collect);
    if (onProgress || onCheck) {
      const failProgress = (error) => {
        if (progressCancelled) return;
        progressFailed = true;
        output += `\n命令进度未能持久化：${error.message}`;
        abort();
      };
      const handleCheckLine = (line) => {
        let event;
        try {
          event = JSON.parse(line.slice('[publish-check] '.length));
          if (typeof event?.title !== 'string' || !event.title.trim() || event.title.length > 200) throw new Error('检查标题格式无效');
          if (!['running', 'ok', 'failed', 'skipped', 'unknown'].includes(event.status)) throw new Error('检查状态格式无效');
          if (event.step != null && typeof event.step !== 'string') throw new Error('检查步骤格式无效');
        } catch (error) { failProgress(error); return; }
        pendingChecks.push({ step: typeof event.step === 'string' && event.step ? event.step : 'gates', title: event.title.trim(), status: event.status });
        if (checking) return;
        checking = true;
        checkWork = (async () => {
          try {
            while (!progressCancelled && pendingChecks.length) {
              const check = pendingChecks.shift();
              await onCheck?.(check);
            }
          } catch (error) { failProgress(error); }
          finally { checking = false; }
        })();
      };
      progressReader = createInterface({ input: child.stdout, crlfDelay: Infinity });
      progressReader.on('line', (line) => {
        if (finishing || progressCancelled) return;
        if (line.startsWith('[publish-check] ')) return handleCheckLine(line);
        if (!onProgress || !line.startsWith('[publish-progress] ')) return;
        try {
          const { detail } = JSON.parse(line.slice('[publish-progress] '.length));
          if (typeof detail !== 'string' || detail.length > 6000) throw new Error('进度说明格式无效');
          pendingProgressDetail = detail;
        } catch (error) { failProgress(error); return; }
        if (progressRunning) return;
        progressRunning = true;
        progressWork = (async () => {
          try {
            while (!progressCancelled && pendingProgressDetail !== undefined) {
              const detail = pendingProgressDetail;
              pendingProgressDetail = undefined;
              await onProgress(detail);
            }
          } catch (error) { failProgress(error); }
          finally { progressRunning = false; }
        })();
      });
    }
    child.once('error', (error) => { output += error.message; void finish({ code: null }); });
    child.on('message', message => { if (message === 'stopped') { stopConfirmed = true; markStopped(); confirmLateStop(); } });
    child.once('close', (code) => { childClosed = true; markClosed(); confirmLateStop(); void finish({ code }); });
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) { abort(); return; }
    try {
      if (child.pid) onChild?.(child.pid);
      onCommand?.({ ...details, phase: 'start' });
      if (resolved || signal?.aborted) { abort(); return; }
      // 绝对时限独立于租约心跳和 stdout/stderr 活动，不能被健康信号续期。
      timer = setTimeout(() => { timedOut = true; abort(); }, Math.max(1, timeoutMs - (performance.now() - started)));
      child.send('start', (error) => {
        if (error) { output += `\n子进程未能启动：${error.message}`; abort(); void finish({ code: null }); }
      });
    } catch (error) {
      output += `\n无法持久化子进程身份：${error.message}`;
      abort(); void finish({ code: null });
    }
  });
}

export async function verifyExit(site, result) {
  let code;
  try {
    const raw = (await fs.readFile(path.join(site, '.verify-exit.code'), 'utf8')).trim();
    if (!/^[0-9]+$/.test(raw)) throw new Error('invalid');
    code = Number(raw);
  } catch { return { ok: false, gate: 'verify-not-run', tail: 'verify 退出码文件缺失或损坏；门未被证明执行' }; }
  return { ok: result.code === 0 && code === 0 && !result.aborted, gate: result.code !== 0 ? 'verify-process' : code ? 'verify' : null, tail: result.output };
}

export async function createWorkspace(source, jobsRoot, options = {}) {
  const original = await fs.realpath(source);
  const parent = path.resolve(jobsRoot);
  if (parent === original || parent.startsWith(`${original}${path.sep}`)) throw new Error('隔离目录必须在源码仓库以外');
  await fs.mkdir(parent, { recursive: true, mode: 0o700 });
  const root = await fs.mkdtemp(path.join(parent, 'job-'));
  const site = path.join(root, 'site');
  await fs.mkdir(site, { mode: 0o700 });
  const clean = async () => {
    // root 来自 mkdtemp 且必须仍位于专用 jobsRoot；永不递归删除链接指向的依赖。
    if (path.dirname(root) !== parent || !path.basename(root).startsWith('job-')) throw new Error('隔离目录边界不成立');
    await fs.rm(root, { recursive: true, force: true });
  };
  try {
    const snapshot = async () => {
      const listing = await runCommand('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { ...options, cwd: original, maxOutput: 16 * 1024 * 1024 });
      if (listing.code !== 0 || listing.aborted || listing.truncated || (listing.output && !listing.output.endsWith('\0'))) throw new Error('无法读取完整当前源码清单');
      const files = [];
      for (const rel of new Set(listing.output.split('\0').filter(Boolean))) {
        const segments = rel.replaceAll('\\', '/').toLowerCase().split('/');
        const name = segments.at(-1);
        if (segments.some(segment => segment === '.local-start' || segment === '.wrangler') ||
            name === '.dev.vars' || (name.startsWith('.dev.vars.') && name !== '.dev.vars.example')) {
          throw new Error('私有运行配置进入源码清单，停止发布；请恢复 Git 忽略及未跟踪状态');
        }
        try { await fs.lstat(path.join(original, rel)); files.push(rel); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      return fileManifest(original, files);
    };
    const sourceSnapshot = await snapshot();
    for (const { path: rel } of sourceSnapshot.manifest) {
      options.signal?.throwIfAborted();
      const src = path.resolve(original, rel);
      const dest = path.resolve(site, rel);
      if (!src.startsWith(`${original}${path.sep}`) || !dest.startsWith(`${site}${path.sep}`)) throw new Error('源码路径越过隔离边界');
      let stat;
      stat = await fs.lstat(src);
      if (stat.isSymbolicLink() || stat.isDirectory()) throw new Error(`源码含不支持的目录或链接：${rel}`);
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.copyFile(src, dest);
    }
    if (fileManifest(site, sourceSnapshot.manifest.map(file => file.path)).sha256 !== sourceSnapshot.sha256 || (await snapshot()).sha256 !== sourceSnapshot.sha256) {
      throw new Error('隔离复制期间源码内容或文件清单发生变化，停止本次发布');
    }
    for (const rel of ['node_modules', 'worker/node_modules', 'admin/node_modules', 'schema/node_modules']) {
      const target = path.join(original, rel);
      try {
        if ((await fs.stat(target)).isDirectory()) {
          await fs.mkdir(path.dirname(path.join(site, rel)), { recursive: true });
          await fs.symlink(target, path.join(site, rel), process.platform === 'win32' ? 'junction' : 'dir');
        }
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    return { root, site, sourceSnapshot, cleanup: clean };
  } catch (error) {
    try { await clean(); } catch (cleanup) { error.message += `；隔离目录清理待恢复：${cleanup.message}`; }
    throw error;
  }
}
