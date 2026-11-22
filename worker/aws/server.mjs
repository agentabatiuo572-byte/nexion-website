import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { SqliteDatabase, migrate, persistentKv } from './storage.mjs';
import { assetsBinding } from './assets.mjs';

export function validateEnvironment(env) {
  if (env.ENVIRONMENT !== 'production' || env.PUBLISH_EXECUTION_MODE !== 'aws') throw new Error('AWS requires production/aws');
  const origin = new URL(env.PUBLIC_ORIGIN);
  if (origin.protocol !== 'https:' || origin.origin !== env.PUBLIC_ORIGIN) throw new Error('Canonical HTTPS origin required');
  for (const key of ['SETUP_TOKEN','PUBLISH_RUNNER_TOKEN','BEACON_SALT','BYPASS_SECRET','GATE_SECRET','AI_CREDENTIAL_ENCRYPTION_KEY']) {
    if (!env[key] || env[key].length < 32 || /dev-|placeholder|test-secret/i.test(env[key])) throw new Error(`Missing production secret: ${key}`);
  }
  for (const key of ['AWS_DATABASE_PATH','AWS_LIVE_PATH']) if (!path.isAbsolute(env[key] ?? '')) throw new Error(`Absolute path required: ${key}`);
  return origin;
}

export function createHttpServer(worker, env, { host = '127.0.0.1', port = 8791 } = {}) {
  const pending = new Set();
  const ctx = { waitUntil(promise) { const p = Promise.resolve(promise).catch(() => console.error('background-task-failed')).finally(() => pending.delete(p)); pending.add(p); }, passThroughOnException() {} };
  const server = createServer(async (incoming, outgoing) => {
    try {
      // Nginx supplies sanitized CF headers. This service is bound only to loopback;
      // forwarded host/protocol are deliberately ignored, even on the machine API.
      const url = new URL(incoming.url, env.PUBLIC_ORIGIN);
      if (url.origin !== env.PUBLIC_ORIGIN) { outgoing.writeHead(400).end(); return; }
      let decoded;
      try { decoded = decodeURIComponent(url.pathname); } catch { outgoing.writeHead(400).end(); return; }
      // Hono decodes routes. Reject aliases before any authentication/CSRF classifier.
      if (/^\/(?:api|admin)(?:\/|$)/.test(decoded) && decoded !== url.pathname) {
        outgoing.writeHead(400, { 'cache-control':'no-store' }).end('Noncanonical route'); return;
      }
      if (decoded.includes('\\') || decoded.includes('\0') || decoded.split('/').some(part => part.startsWith('.')) || /^\/(?:_headers|_redirects)$/.test(decoded)) {
        outgoing.writeHead(404, { 'cache-control':'no-store' }).end('Not found'); return;
      }
      const machine = /^\/api\/publish\/(?:next|step|check|heartbeat|runner-state|runner-fail)\/?$/.test(url.pathname);
      if (!['GET','HEAD'].includes(incoming.method) && /^\/api\/(?:auth|config|publish|geo|ai|translations|admin)(?:\/|$)/.test(url.pathname) && !machine) {
        if (incoming.headers.origin !== env.PUBLIC_ORIGIN) { outgoing.writeHead(403, { 'content-type':'application/json','cache-control':'no-store' }).end('{"error":"origin-rejected"}'); return; }
        if (!/^application\/json(?:\s*;|$)/i.test(incoming.headers['content-type'] ?? '')) { outgoing.writeHead(415).end(); return; }
      }
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) if (value !== undefined && !['host','connection','transfer-encoding'].includes(name)) headers.set(name, Array.isArray(value) ? value.join(',') : value);
      headers.set('host', new URL(env.PUBLIC_ORIGIN).host);
      const chunks = []; let bytes = 0;
      for await (const chunk of incoming) {
        bytes += chunk.length;
        if (bytes > 2 * 1024 * 1024) { outgoing.writeHead(413).end(); return; }
        chunks.push(chunk);
      }
      const request = new Request(url, { method:incoming.method, headers, ...(!['GET','HEAD'].includes(incoming.method) && bytes ? { body:Buffer.concat(chunks) } : {}) });
      const response = await worker.fetch(request, env, ctx);
      for (const [name, value] of response.headers) if (name !== 'set-cookie') outgoing.setHeader(name, value);
      const cookies = response.headers.getSetCookie();
      if (cookies.length) outgoing.setHeader('set-cookie', cookies);
      if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/admin')) outgoing.setHeader('Cache-Control', 'no-store');
      outgoing.setHeader('X-Content-Type-Options', 'nosniff');
      outgoing.writeHead(response.status);
      if (incoming.method === 'HEAD' || !response.body) outgoing.end();
      else Readable.fromWeb(response.body).on('error', () => outgoing.destroy()).pipe(outgoing);
    } catch { if (!outgoing.headersSent) outgoing.writeHead(500, { 'content-type':'application/json', 'cache-control':'no-store' }); outgoing.end('{"error":"internal-error"}'); console.error('request-failed'); }
  });
  server.requestTimeout = 30000; server.headersTimeout = 15000;
  return { server, ctx, pending, listen:() => new Promise(resolve => server.listen(port, host, resolve)) };
}

export function startScheduler(worker, env, ctx, now = () => new Date()) {
  let lastMinute = ''; let busy = false; let lastDaily = ''; let lastProbe = ''; let inFlight = Promise.resolve();
  const tick = async () => {
    if (busy) return;
    const date = now(); const key = date.toISOString().slice(0,16);
    if (key === lastMinute) return;
    busy = true; lastMinute = key;
    try {
      const day = date.toISOString().slice(0,10); const probe = String(Math.floor(date.getTime() / 21_600_000));
      const jobs = ['* * * * *'];
      if (lastProbe !== probe) jobs.push('0 */6 * * *');
      if ((date.getUTCHours() > 0 || date.getUTCMinutes() >= 10) && lastDaily !== day) jobs.push('10 0 * * *');
      await Promise.all(jobs.map(async cron => {
        const work = [];
        await worker.scheduled({ cron, scheduledTime:date.getTime() }, env, { ...ctx, waitUntil(p) { work.push(Promise.resolve(p)); } });
        await Promise.all(work);
        if (cron === '10 0 * * *') lastDaily = day;
        if (cron === '0 */6 * * *') lastProbe = probe;
      }));
    } finally { busy = false; }
  };
  const run = () => { if (!busy) inFlight = tick().catch(() => console.error('scheduler-failed')); };
  const timer = setInterval(run, 5000); timer.unref(); run();
  return async () => { clearInterval(timer); await inFlight; };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  validateEnvironment(process.env);
  const { default: worker } = await import('./dist/worker.mjs');
  const db = new SqliteDatabase(process.env.AWS_DATABASE_PATH);
  migrate(db, fileURLToPath(new URL('../migrations/', import.meta.url)));
  const env = { ...process.env, DB:db, KV:persistentKv(db), ASSETS:assetsBinding(process.env.AWS_LIVE_PATH) };
  const service = createHttpServer(worker, env);
  await service.listen();
  const stopScheduler = startScheduler(worker, env, service.ctx);
  console.log('UVEL admin production API listening on loopback:8791');
  let stopping = false;
  for (const signal of ['SIGTERM','SIGINT']) process.on(signal, () => {
    if (stopping) return; stopping = true; const schedulerStopped = stopScheduler();
    service.server.close(async () => { await schedulerStopped; await Promise.allSettled([...service.pending]); db.close(); process.exit(0); });
    setTimeout(() => process.exit(1), 25000).unref();
  });
}
