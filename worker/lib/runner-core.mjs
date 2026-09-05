/* 发布执行器的可独立验证接缝。所有命令使用 argv，机器凭据只发给指定 API。 */
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

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
  const hash = createHash('sha256').update(path.resolve(stateDir).toLowerCase()).digest();
  const port = 30000 + hash.readUInt16BE(0) % 30000;
  const server = createServer((socket) => socket.destroy());
  await new Promise((resolve, reject) => {
    server.once('error', () => reject(new Error('发布执行器已运行或互斥端口仍活跃，拒绝双开')));
    server.listen(port, '127.0.0.1', resolve);
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
    const response = await fetchImpl(`${options.api}${endpoint}`, {
      method: body === undefined ? 'GET' : 'POST', redirect: 'manual', signal: combined,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${options.token}` },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      // 服务端错误体可能反射凭据，不将其原文放日志。
      const error = new Error(`${endpoint.split('?')[0]} HTTP ${response.status}${[401, 403].includes(response.status) ? '：机器身份鉴权失败，请检查密钥配置' : ''}`);
      error.status = response.status;
      throw error;
    }
    let parsed;
    try { parsed = await response.json(); } catch { throw new Error(`${endpoint.split('?')[0]} 返回无效 JSON`); }
    return parsed;
  };
}

export function startLease(renew, { intervalMs = 10000, graceMs = 30000, requestTimeoutMs = 8000 } = {}) {
  const controller = new AbortController();
  let stopped = false;
  let timer;
  let lastSuccess = Date.now();
  let active = Promise.resolve();
  const fail = (error) => { if (!controller.signal.aborted) controller.abort(error); };
  const attempt = async () => {
    if (stopped || controller.signal.aborted) return;
    try {
      const timeout = AbortSignal.timeout(requestTimeoutMs);
      const signal = AbortSignal.any([controller.signal, timeout]);
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
    async check() { await active; if (controller.signal.aborted) throw controller.signal.reason; await attempt(); },
    stop() { stopped = true; clearTimeout(timer); },
  };
}

export function childEnvironment(env = process.env) {
  const safe = { ...env };
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
    await new Promise((resolve) => {
      const killer = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      killer.once('error', resolve); killer.once('close', resolve);
    });
  } else {
    try { process.kill(-pid, 'SIGKILL'); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
}

export function runCommand(command, args, { cwd, signal, env = childEnvironment(), onChild, onOutput, maxOutput = 32 * 1024 } = {}) {
  if (signal?.aborted) return Promise.resolve({ code: null, output: '发布已中断', aborted: true });
  return new Promise((resolve) => {
    let output = '';
    let child;
    let killing;
    let resolved = false;
    const finish = async (result) => {
      if (resolved) return;
      resolved = true;
      signal?.removeEventListener('abort', abort);
      if (killing) {
        try { await killing; } catch (error) { output += `\n子树终止未确认：${error.message}`; result.code = null; }
      }
      try { onChild?.(null); }
      catch (error) { output += `\n子进程记录未收口：${error.message}`; result.code = null; }
      resolve({ ...result, output, aborted: !!signal?.aborted });
    };
    const abort = () => { killing ??= killProcessTree(child.pid); };
    try {
      child = spawn(process.execPath, [fileURLToPath(new URL('./runner-child.mjs', import.meta.url)), command, ...args], { cwd, env, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    } catch (error) { output = error.message; void finish({ code: null }); return; }
    const collect = (chunk) => { const value = chunk.toString(); output = (output + value).slice(-maxOutput); onOutput?.(value); };
    child.stdout.on('data', collect); child.stderr.on('data', collect);
    child.once('error', (error) => { output += error.message; void finish({ code: null }); });
    child.once('close', (code) => { void finish({ code }); });
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) { abort(); return; }
    try {
      if (child.pid) onChild?.(child.pid);
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
    const listing = await runCommand('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: original, signal: options.signal, maxOutput: 16 * 1024 * 1024, onChild: options.onChild });
    if (listing.code !== 0 || listing.aborted) throw new Error('无法读取当前源码清单');
    for (const rel of new Set(listing.output.split('\0').filter(Boolean))) {
      options.signal?.throwIfAborted();
      const src = path.resolve(original, rel);
      const dest = path.resolve(site, rel);
      if (!src.startsWith(`${original}${path.sep}`) || !dest.startsWith(`${site}${path.sep}`)) throw new Error('源码路径越过隔离边界');
      let stat;
      try { stat = await fs.lstat(src); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      if (stat.isSymbolicLink() || stat.isDirectory()) throw new Error(`源码含不支持的目录或链接：${rel}`);
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.copyFile(src, dest);
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
    return { root, site, cleanup: clean };
  } catch (error) { await clean(); throw error; }
}
