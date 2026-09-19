// /status 的 checks 透出验收(隔离 D1 模式):checksOfVersion+checks / 空闲回最近 / 截断不丢 / 不串任务。
// harness 与 publish-checks.test.mjs 同构(4 文件约束,不抽共享模块):esbuild 打包真 worker +
// node:sqlite D1 垫片 + migrations 按序执行。/status 走 cookie 鉴权,会话行直插 sessions 表。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as nodeFs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';

const workerDir = path.dirname(fileURLToPath(import.meta.url));
const TOKEN = 'test-service-secret-with-at-least-32-characters';
const RUNNER = 'test-runner';
const LOCK_TTL = 15 * 60_000;

function createDB() {
  const db = new DatabaseSync(':memory:');
  const isQuery = (sql) => /^\s*(select|with|values|pragma|explain)\b/i.test(sql) || /\breturning\b/i.test(sql);
  const toRow = (v) => (v === undefined ? null : v);
  const dbw = {
    prepare(sql) {
      const stmt = db.prepare(sql);
      const query = isQuery(sql);
      let params = [];
      const api = {
        bind(...p) { params = p; return api; },
        first(...p) {
          const args = p.length ? p : params;
          if (!query) { stmt.run(...args); return null; }
          return toRow(stmt.get(...args));
        },
        all(...p) {
          const args = p.length ? p : params;
          if (!query) { const r = stmt.run(...args); return { results: [], success: true, meta: { changes: r.changes } }; }
          return { results: stmt.all(...args), success: true, meta: { changes: 0 } };
        },
        run(...p) {
          const args = p.length ? p : params;
          if (query) return { success: true, meta: { changes: 0 }, results: [] };
          const r = stmt.run(...args);
          return { success: true, meta: { changes: r.changes, last_row_id: Number(r.lastInsertRowid) } };
        },
        _sql: sql,
        _params: () => params,
      };
      return api;
    },
    batch(list) {
      db.exec('BEGIN');
      try {
        const out = list.map((s) => {
          const stmt = db.prepare(s._sql);
          const args = s._params();
          if (isQuery(s._sql)) {
            const rows = stmt.all(...args);
            return { results: rows, success: true, meta: { changes: 0 } };
          }
          const r = stmt.run(...args);
          return { success: true, meta: { changes: r.changes, last_row_id: Number(r.lastInsertRowid) } };
        });
        db.exec('COMMIT');
        return out;
      } catch (e) { db.exec('ROLLBACK'); throw e; }
    },
    exec(sql) { db.exec(sql); },
  };
  return dbw;
}

async function applyMigrations(dbw) {
  const dir = path.join(workerDir, '..', 'migrations');
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  assert.ok(files.includes('0021_publish_checks.sql'), 'migration 0021 must exist');
  for (const f of files) dbw.exec(await readFile(path.join(dir, f), 'utf8'));
}

let appPromise = null;
function loadApp() {
  if (!appPromise) {
    appPromise = (async () => {
      const require = createRequire(path.join(workerDir, 'package.json'));
      const esbuild = require('esbuild');
      const outFile = path.join(tmpdir(), `publish-checks-api-app-${process.pid}.mjs`);
      await esbuild.build({
        entryPoints: [path.join(workerDir, '..', 'src', 'index.ts')],
        bundle: true, format: 'esm', platform: 'node', outfile: outFile, logLevel: 'warning',
        plugins: [{
          name: 'js-to-ts',
          setup(b) {
            b.onResolve({ filter: /^\.\.?\/.*\.js$/ }, (args) => {
              const cand = path.join(args.resolveDir, args.path.slice(0, -3) + '.ts');
              if (nodeFs.existsSync(cand)) return { path: cand };
              return null;
            });
          },
        }],
      });
      return (await import(pathToFileURL(outFile).href)).app;
    })();
  }
  return appPromise;
}

function makeEnv(dbw) {
  return {
    DB: dbw,
    KV: { get: async () => null, put: async () => {}, delete: async () => {} },
    ASSETS: { fetch: async () => new Response('not found', { status: 404 }) },
    ENVIRONMENT: 'dev',
    SETUP_TOKEN: 'dev-setup-token',
    BEACON_SALT: 'dev-beacon-salt',
    BYPASS_SECRET: 'dev-bypass-secret',
    PUBLISH_RUNNER_TOKEN: TOKEN,
    PUBLISH_EXECUTION_MODE: 'local',
    KDF_ITER: '1000',
  };
}

async function setup() {
  const app = await loadApp();
  const dbw = createDB();
  await applyMigrations(dbw);
  const env = makeEnv(dbw);
  const sessionToken = 'api-test-session-token';
  const tokenHash = createHash('sha256').update(sessionToken).digest('hex');
  const now = Date.now();
  await dbw.prepare('INSERT INTO sessions (token_hash, created_at, expires_at) VALUES (?1, ?2, ?3)')
    .bind(tokenHash, now, now + 7 * 24 * 3600_000).run();
  const cookie = `nx_sid=${sessionToken}`;
  return { app, env, db: dbw, cookie };
}

const getStatus = (app, env, cookie) =>
  app.request('/api/publish/status', { headers: { cookie } }, env);
const machineHeaders = () => ({ authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' });
const postCheck = (app, env, body) =>
  app.request('/api/publish/check', { method: 'POST', headers: machineHeaders(), body: JSON.stringify(body) }, env);

async function seedVersion(db, { status = 'validating', nonce = 'nonce-1', runner = RUNNER } = {}) {
  const now = Date.now();
  const row = await db.prepare(
    `INSERT INTO config_versions (status, payload, reason, created_by, created_at, claim_nonce, runner_id, source_draft_rev)
     VALUES (?1, '{}', NULL, 'admin', ?2, ?3, ?4, NULL) RETURNING id`,
  ).bind(status, now, nonce, runner).first();
  return { versionId: row.id, nonce, runner };
}

async function seedLock(db, versionId, nonce, runner = RUNNER, expiresIn = LOCK_TTL) {
  const now = Date.now();
  await db.prepare(
    `INSERT INTO publish_lock (id, version_id, acquired_at, expires_at, claim_nonce, claimed_at, claimed_by)
     VALUES (1, ?1, ?2, ?3, ?4, ?2, ?5)`,
  ).bind(versionId, now, now + expiresIn, nonce, runner).run();
}

async function seedStep(db, versionId, step = 'materialize', status = 'running', detail = 'd') {
  const now = Date.now();
  await db.prepare(
    `INSERT INTO publish_steps (version_id, step, status, started_at, detail) VALUES (?1, ?2, ?3, ?4, ?5)`,
  ).bind(versionId, step, status, now, detail).run();
}

const checkBody = (v, over = {}) => ({
  versionId: v.versionId, stamp: v.nonce, runnerId: v.runner,
  step: 'gates', title: 'i18n-parity', status: 'ok', ...over,
});
test('status exposes checksOfVersion and checks ordered by seq', async () => {
  const { app, env, db, cookie } = await setup();
  const v = await seedVersion(db);
  await seedLock(db, v.versionId, v.nonce);
  await seedStep(db, v.versionId);
  assert.equal((await postCheck(app, env, checkBody(v, { title: 'gate-a', status: 'running', output: 'o1' }))).status, 200);
  assert.equal((await postCheck(app, env, checkBody(v, { title: 'gate-b', status: 'ok', output: 'o2' }))).status, 200);
  assert.equal((await postCheck(app, env, checkBody(v, { step: 'build', title: 'assemble', status: 'running' }))).status, 200);
  const res = await getStatus(app, env, cookie);
  assert.equal(res.status, 200);
  const s = await res.json();
  assert.equal(s.activeVersion, v.versionId);
  assert.equal(s.checksOfVersion, v.versionId);
  assert.equal(s.checksOfVersion, s.stepsOfVersion);
  assert.deepEqual(s.checks.map((c) => [c.step, c.seq, c.title, c.status, c.output]),
    [['gates', 1, 'gate-a', 'running', 'o1'], ['gates', 2, 'gate-b', 'ok', 'o2'], ['build', 3, 'assemble', 'running', null]]);
  assert.deepEqual(Object.keys(s.checks[0]).sort(),
    ['ended_at', 'output', 'seq', 'started_at', 'status', 'step', 'title', 'version_id']);
  assert.ok(s.checks.every((c) => c.version_id === v.versionId && c.ended_at === null && typeof c.started_at === 'number'));
});

test('falls back to the most recent run when idle', async () => {
  const { app, env, db, cookie } = await setup();
  const v = await seedVersion(db, { nonce: 'nonce-done' });
  await seedLock(db, v.versionId, v.nonce);
  await seedStep(db, v.versionId, 'materialize', 'ok');
  assert.equal((await postCheck(app, env, checkBody(v, { title: 'gate-a' }))).status, 200);
  // 任务收口:版本 failed + 锁释放(与 commitPublishFailure 的收口一致),无进行中
  await db.prepare("UPDATE config_versions SET status='failed' WHERE id=?1").bind(v.versionId).run();
  await db.prepare('DELETE FROM publish_lock WHERE id=1').run();
  const s = await (await getStatus(app, env, cookie)).json();
  assert.equal(s.activeVersion, null);
  assert.equal(s.stepsOfVersion, v.versionId);
  assert.equal(s.checksOfVersion, v.versionId);
  assert.deepEqual(s.checks.map((c) => [c.seq, c.title]), [[1, 'gate-a']]);
});

test('does not mix tasks: idle fallback serves one version only', async () => {
  const { app, env, db, cookie } = await setup();
  const a = await seedVersion(db, { status: 'failed', nonce: 'nonce-a' });
  await seedStep(db, a.versionId, 'materialize', 'failed');
  await db.prepare(
    `INSERT INTO publish_checks (version_id, step, seq, title, status, started_at) VALUES (?1, 'gates', 1, 'old-gate', 'failed', ?2)`,
  ).bind(a.versionId, Date.now()).run();
  const b = await seedVersion(db, { nonce: 'nonce-b' });
  await seedLock(db, b.versionId, b.nonce);
  await seedStep(db, b.versionId);
  assert.equal((await postCheck(app, env, checkBody(b, { title: 'new-gate' }))).status, 200);
  const active = await (await getStatus(app, env, cookie)).json();
  assert.equal(active.checksOfVersion, b.versionId);
  assert.deepEqual(active.checks.map((c) => c.title), ['new-gate']);
  // B 收口后回最近一次(仍是 B 的步骤版本),A 的检查行永不混入
  await db.prepare("UPDATE config_versions SET status='failed' WHERE id=?1").bind(b.versionId).run();
  await db.prepare('DELETE FROM publish_lock WHERE id=1').run();
  const idle = await (await getStatus(app, env, cookie)).json();
  assert.equal(idle.checksOfVersion, b.versionId);
  assert.deepEqual(idle.checks.map((c) => [c.version_id, c.title]), [[b.versionId, 'new-gate']]);
});

test('version truncation keeps checks', async () => {
  const { app, env, db, cookie } = await setup();
  let latest = null;
  for (let i = 0; i < 32; i++) {
    const done = i < 31;
    const v = await seedVersion(db, { status: done ? 'failed' : 'validating', nonce: `nonce-${i}` });
    latest = v;
  }
  await seedLock(db, latest.versionId, latest.nonce);
  await seedStep(db, latest.versionId);
  assert.equal((await postCheck(app, env, checkBody(latest, { title: 'kept-gate' }))).status, 200);
  await db.prepare("UPDATE config_versions SET status='failed' WHERE id=?1").bind(latest.versionId).run();
  await db.prepare('DELETE FROM publish_lock WHERE id=1').run();
  const s = await (await getStatus(app, env, cookie)).json();
  assert.equal(s.versionsTruncated, true);
  assert.equal(s.versions.length, 30);
  assert.equal(s.checksOfVersion, latest.versionId);
  assert.deepEqual(s.checks.map((c) => [c.seq, c.title]), [[1, 'kept-gate']]);
  assert.equal(s.stepsOfVersion, latest.versionId);
  assert.equal(s.steps.length, 1);
});

