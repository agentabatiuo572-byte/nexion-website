// publish_checks 落地验收(隔离 D1 模式):建表 / 写 / seq 单调 / 身份冒充 / 终态拒写 / 跨版本隔离。
// 复用 publish.spec.ts 的思路但跑在纯 node --test 下:esbuild 打包真 worker + node:sqlite 做 D1 兼容垫片,
// migrations 按序执行,不依赖 vitest/cloudflare:test。
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
      const outFile = path.join(tmpdir(), `publish-checks-app-${process.pid}.mjs`);
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

const machineHeaders = () => ({ authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' });
const postCheck = (app, env, body) =>
  app.request('/api/publish/check', { method: 'POST', headers: machineHeaders(), body: JSON.stringify(body) }, env);

async function setup() {
  const app = await loadApp();
  const dbw = createDB();
  await applyMigrations(dbw);
  return { app, env: makeEnv(dbw), db: dbw };
}

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

const checkBody = (v, over = {}) => ({
  versionId: v.versionId, stamp: v.nonce, runnerId: v.runner,
  step: 'gates', title: 'i18n-parity', status: 'ok', ...over,
});
test('migration creates publish_checks with required columns and indexes', async () => {
  const { db } = await setup();
  const cols = await db.prepare("SELECT name FROM pragma_table_info('publish_checks') ORDER BY cid").all();
  assert.deepEqual(cols.results.map((c) => c.name),
    ['id', 'version_id', 'step', 'seq', 'title', 'status', 'output', 'started_at', 'ended_at']);
  const idx = await db.prepare("SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name='publish_checks'").all();
  const byName = Object.fromEntries(idx.results.map((r) => [r.name, r.sql]));
  assert.ok(byName.idx_checks_version.includes('(version_id, seq, id)') || byName.idx_checks_version.includes('version_id,seq,id'),
    'index (version_id,seq,id) required');
  assert.ok(byName.idx_checks_step.includes('version_id, step, seq') || byName.idx_checks_step.includes('version_id,step,seq'),
    'index (version_id,step,seq) required');
});

test('writes checks with server-assigned monotonic seq', async () => {
  const { app, env, db } = await setup();
  const v = await seedVersion(db);
  await seedLock(db, v.versionId, v.nonce);
  for (const [i, s] of [['gates', 'running'], ['gates', 'ok'], ['build', 'running']].entries()) {
    const res = await postCheck(app, env, checkBody(v, { step: s[0], title: `t${i}`, status: s[1], output: `log-${i}` }));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, seq: i + 1 });
  }
  const rows = await db.prepare('SELECT step, seq, title, status, output, started_at, ended_at FROM publish_checks WHERE version_id=?1 ORDER BY seq').bind(v.versionId).all();
  assert.deepEqual(rows.results.map((r) => [r.step, r.seq, r.title, r.status, r.output]),
    [['gates', 1, 't0', 'running', 'log-0'], ['gates', 2, 't1', 'ok', 'log-1'], ['build', 3, 't2', 'running', 'log-2']]);
  assert.ok(rows.results.every((r) => typeof r.started_at === 'number' && r.ended_at === null));
  // publish_steps 语义不动:checks 写入不产生步骤行
  const steps = await db.prepare('SELECT COUNT(*) AS n FROM publish_steps WHERE version_id=?1').bind(v.versionId).first();
  assert.equal(steps.n, 0);
});

test('truncates unbounded output like step detail', async () => {
  const { app, env, db } = await setup();
  const v = await seedVersion(db);
  await seedLock(db, v.versionId, v.nonce);
  const res = await postCheck(app, env, checkBody(v, { output: 'x'.repeat(7000) }));
  assert.equal(res.status, 200);
  const row = await db.prepare('SELECT output FROM publish_checks WHERE version_id=?1').bind(v.versionId).first();
  assert.equal(row.output.length, 6000);
});

test('rejects bad payloads with 400', async () => {
  const { app, env, db } = await setup();
  const v = await seedVersion(db);
  await seedLock(db, v.versionId, v.nonce);
  const cases = [
    checkBody(v, { step: 'nope' }),
    checkBody(v, { status: 'maybe' }),
    checkBody(v, { title: '   ' }),
    checkBody(v, { title: 42 }),
    checkBody(v, { output: 42 }),
    checkBody(v, { versionId: 'x' }),
  ];
  for (const c of cases) {
    const res = await postCheck(app, env, c);
    assert.equal(res.status, 400, JSON.stringify(c));
  }
  // stamp 缺失不是形状错误,是身份失败 → 409(与 /step 第零层一致)
  const noStamp = await postCheck(app, env, { ...checkBody(v), stamp: undefined });
  assert.equal(noStamp.status, 409);
});

test('rejects impersonation with 409 and writes nothing', async () => {
  const { app, env, db } = await setup();
  const v = await seedVersion(db);
  await seedLock(db, v.versionId, v.nonce);
  const badStamp = await postCheck(app, env, checkBody(v, { stamp: 'forged-nonce' }));
  assert.equal(badStamp.status, 409);
  assert.equal((await badStamp.json()).error, 'not-the-claimed-runner(请先领取任务)');
  const badRunner = await postCheck(app, env, checkBody(v, { runnerId: 'other-runner' }));
  assert.equal(badRunner.status, 409);
  const missing = await postCheck(app, env, checkBody(v, { versionId: 9999 }));
  assert.equal(missing.status, 404);
  const n = await db.prepare('SELECT COUNT(*) AS n FROM publish_checks').first();
  assert.equal(n.n, 0);
});

test('refuses writes to terminal versions', async () => {
  const { app, env, db } = await setup();
  const v = await seedVersion(db);
  await seedLock(db, v.versionId, v.nonce);
  assert.equal((await postCheck(app, env, checkBody(v))).status, 200);
  // 终态:版本 failed + 锁释放(与 commitPublishFailure 的收口一致)
  await db.prepare("UPDATE config_versions SET status='failed' WHERE id=?1").bind(v.versionId).run();
  await db.prepare('DELETE FROM publish_lock WHERE id=1').run();
  const res = await postCheck(app, env, checkBody(v));
  assert.equal(res.status, 409);
  assert.equal((await res.json()).error, 'version-not-active');
  // live 同样拒写
  await db.prepare("UPDATE config_versions SET status='live' WHERE id=?1").bind(v.versionId).run();
  assert.equal((await postCheck(app, env, checkBody(v))).status, 409);
  const n = await db.prepare('SELECT COUNT(*) AS n FROM publish_checks WHERE version_id=?1').bind(v.versionId).first();
  assert.equal(n.n, 1);
});

test('rejects writes when the lock is gone or expired', async () => {
  const { app, env, db } = await setup();
  const v = await seedVersion(db);
  await seedLock(db, v.versionId, v.nonce);
  await db.prepare('DELETE FROM publish_lock WHERE id=1').run();
  assert.equal((await postCheck(app, env, checkBody(v))).status, 409);
  await seedLock(db, v.versionId, v.nonce, RUNNER, -1000);
  const expired = await postCheck(app, env, checkBody(v));
  assert.equal(expired.status, 409);
  assert.equal((await expired.json()).error, 'lock-expired(发布已超时,请重新发起)');
  const n = await db.prepare('SELECT COUNT(*) AS n FROM publish_checks').first();
  assert.equal(n.n, 0);
});

test('isolates checks per version with independent seq', async () => {
  const { app, env, db } = await setup();
  const a = await seedVersion(db, { nonce: 'nonce-a' });
  const b = await seedVersion(db, { nonce: 'nonce-b' });
  await seedLock(db, a.versionId, a.nonce);
  assert.equal((await postCheck(app, env, checkBody(a, { title: 'a-1' }))).status, 200);
  assert.equal((await postCheck(app, env, checkBody(a, { title: 'a-2' }))).status, 200);
  // 锁转到 B:B 的口令与 A 不同,A 的旧口令写 B 必须 409
  await db.prepare('UPDATE publish_lock SET version_id=?1, claim_nonce=?2, claimed_by=?3').bind(b.versionId, b.nonce, b.runner).run();
  assert.equal((await postCheck(app, env, checkBody(b, { stamp: a.nonce }))).status, 409);
  const rb = await postCheck(app, env, checkBody(b, { title: 'b-1' }));
  assert.equal(rb.status, 200);
  assert.deepEqual(await rb.json(), { ok: true, seq: 1 });
  const rows = await db.prepare('SELECT version_id, seq, title FROM publish_checks ORDER BY version_id, seq').all();
  assert.deepEqual(rows.results.map((r) => [r.version_id, r.seq, r.title]),
    [[a.versionId, 1, 'a-1'], [a.versionId, 2, 'a-2'], [b.versionId, 1, 'b-1']]);
});

