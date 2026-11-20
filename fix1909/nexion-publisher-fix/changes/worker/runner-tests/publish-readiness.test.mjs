import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { needsPublishStorage, publishReadiness, publishStorageReady, PUBLISH_READINESS_PROTOCOL } from '../src/publish-readiness.ts';

const checks = `CREATE TABLE publish_checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT, version_id INTEGER NOT NULL,
  step TEXT NOT NULL, seq INTEGER NOT NULL, title TEXT NOT NULL,
  status TEXT NOT NULL, output TEXT, started_at INTEGER NOT NULL, ended_at INTEGER
);
CREATE UNIQUE INDEX idx_checks_version_seq ON publish_checks(version_id,seq);`;

function fixture(t, upgraded = false) {
  const sqlite = new DatabaseSync(':memory:');
  t.after(() => sqlite.close());
  sqlite.exec(`CREATE TABLE config_versions(id INTEGER PRIMARY KEY,status TEXT NOT NULL);
    CREATE TABLE publish_lock(id INTEGER PRIMARY KEY,version_id INTEGER,expires_at INTEGER);`);
  if (upgraded) sqlite.exec(checks);
  const queries = [];
  const db = { prepare(sql) {
    queries.push(sql);
    const statement = sqlite.prepare(sql);
    // Node SQLite names numbered placeholders; D1 exposes them positionally.
    const bind = (...values) => ({ first: async () => statement.get(Object.fromEntries(values.map((value, i) => [`?${i + 1}`, value]))) ?? null });
    return { bind, first: async () => statement.get() ?? null, all: async () => ({ results: statement.all() }) };
  } };
  return { sqlite, db, queries };
}

test('missing checks table reports pending upgrade, not an exception', async t => {
  const { db } = fixture(t);
  assert.equal(await publishStorageReady(db), false);
});

test('complete table and unique sequence index are ready', async t => {
  const { db } = fixture(t, true);
  assert.equal(await publishStorageReady(db), true);
});

test('an incomplete table is not mistaken for an applied migration', async t => {
  const { db, sqlite } = fixture(t);
  sqlite.exec('CREATE TABLE publish_checks(id INTEGER,version_id INTEGER,seq INTEGER); CREATE UNIQUE INDEX idx_checks_version_seq ON publish_checks(version_id,seq)');
  assert.equal(await publishStorageReady(db), false);
});

test('missing unique index fails readiness', async t => {
  const { db, sqlite } = fixture(t, true);
  sqlite.exec('DROP INDEX idx_checks_version_seq');
  assert.equal(await publishStorageReady(db), false);
});

test('an index with the right name but wrong uniqueness is rejected', async t => {
  const { db, sqlite } = fixture(t, true);
  sqlite.exec('DROP INDEX idx_checks_version_seq; CREATE INDEX idx_checks_version_seq ON publish_checks(version_id,seq)');
  assert.equal(await publishStorageReady(db), false);
});

test('an index with the right name but wrong key is rejected', async t => {
  const { db, sqlite } = fixture(t, true);
  sqlite.exec('DROP INDEX idx_checks_version_seq; CREATE UNIQUE INDEX idx_checks_version_seq ON publish_checks(id,seq)');
  assert.equal(await publishStorageReady(db), false);
});

test('idle missing-schema API is eligible for a single managed restart', async t => {
  const { db } = fixture(t);
  const state = await publishReadiness(db, 1000);
  assert.equal(state.protocol, PUBLISH_READINESS_PROTOCOL);
  assert.equal(state.storageReady, false);
  assert.equal(state.restartSafe, true);
  assert.equal(state.activeVersion, null);
  assert.equal(state.requiredMigration, '0021_publish_checks.sql');
});

for (const status of ['validating', 'publishing', 'unknown']) {
  test(`${status} anywhere in history prevents restart even without a live lock`, async t => {
    const { db, sqlite } = fixture(t);
    sqlite.prepare('INSERT INTO config_versions(id,status) VALUES(1,?)').run(status);
    for (let id = 2; id < 40; id++) sqlite.prepare('INSERT INTO config_versions VALUES(?,?)').run(id, 'failed');
    const state = await publishReadiness(db, 1000);
    assert.equal(state.restartSafe, false);
    assert.equal(state.activeVersion, 1);
  });
}

test('an unexpired orphan lock prevents restart', async t => {
  const { db, sqlite } = fixture(t);
  sqlite.exec('INSERT INTO publish_lock VALUES(1,99,5000)');
  const state = await publishReadiness(db, 1000);
  assert.equal(state.restartSafe, false);
  assert.equal(state.activeVersion, 99);
});

test('expired terminal lock does not authorize a destructive cleanup', async t => {
  const { db, sqlite } = fixture(t);
  sqlite.exec("INSERT INTO config_versions VALUES(2,'failed'); INSERT INTO publish_lock VALUES(1,2,999)");
  const state = await publishReadiness(db, 1000);
  assert.equal(state.restartSafe, true);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM publish_lock').get().n, 1);
});

test('healthy schema is reused, never restarted by this probe', async t => {
  const { db } = fixture(t, true);
  const state = await publishReadiness(db, 1000);
  assert.equal(state.storageReady, true);
  assert.equal(state.restartSafe, false);
});

test('readiness performs read-only statements and preserves every row', async t => {
  const { db, sqlite, queries } = fixture(t, true);
  sqlite.exec("INSERT INTO config_versions VALUES(8,'live')");
  const before = sqlite.prepare('SELECT * FROM sqlite_master ORDER BY name').all();
  await publishReadiness(db, 1000);
  assert(queries.every(sql => /^(SELECT|PRAGMA)\b/.test(sql)));
  assert.deepEqual(sqlite.prepare('SELECT * FROM sqlite_master ORDER BY name').all(), before);
  assert.deepEqual({ ...sqlite.prepare('SELECT * FROM config_versions').get() }, { id: 8, status: 'live' });
});

test('unrelated database failure propagates; it must not become safe-to-restart', async () => {
  const broken = { prepare() { throw new Error('synthetic database I/O failure'); } };
  await assert.rejects(publishReadiness(broken), /I\/O failure/);
});

test('new submissions, claims and checks require the upgraded table', () => {
  for (const route of ['publish', 'next', 'check']) assert.equal(needsPublishStorage(route, 'POST'), true);
  for (const route of ['status', 'preflight']) assert.equal(needsPublishStorage(route, 'GET'), true);
});

test('recovery, cancellation and heartbeat routes are not disabled by schema upgrade', () => {
  for (const route of ['heartbeat', 'runner-fail', 'step', 'cancel', 'runner-state']) {
    assert.equal(needsPublishStorage(route, 'POST'), false);
    assert.equal(needsPublishStorage(route, 'GET'), false);
  }
});
