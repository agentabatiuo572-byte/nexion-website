import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SqliteDatabase, migrate, persistentKv } from '../storage.mjs';
const migrations = fileURLToPath(new URL('../../migrations/', import.meta.url));
const open = () => { const db = new SqliteDatabase(':memory:'); migrate(db, migrations); return db; };

test('all current migrations apply once and preserve rows', async () => {
  const db = open(); const before = await db.prepare('SELECT count(*) AS n FROM _aws_migrations').first('n');
  assert.ok(before >= 24); migrate(db, migrations);
  assert.equal(await db.prepare('SELECT count(*) AS n FROM _aws_migrations').first('n'), before); db.close();
});
test('numbered binds retain repeated, sparse and reordered SQLite positions', async () => {
  const db = open();
  assert.deepEqual(await db.prepare("SELECT ?3 AS c, ?1 AS a, ?1 AS b, '?99' AS literal").bind('one', null, 3).first(), {c:3,a:'one',b:'one',literal:'?99'});
  assert.equal(await db.prepare('SELECT json_extract(?,?) AS n').bind('{"n":4}', '$.n').first('n'),4); db.close();
});
test('DML RETURNING has real changes and first performs the write', async () => {
  const db = open();
  const [insert, audit] = await db.batch([
    db.prepare('INSERT INTO auth_account VALUES(1,?1,?2,?3) RETURNING id').bind('hash','salt',1),
    db.prepare("INSERT INTO audit(ts,actor,action) SELECT 1,'admin','test' WHERE changes()>0"),
  ]);
  assert.equal(insert.meta.changes,1); assert.equal(insert.results[0].id,1); assert.equal(audit.meta.changes,1);
  assert.equal((await db.prepare('UPDATE auth_account SET initialized_at=? WHERE id=1 RETURNING initialized_at').bind(2).first()).initialized_at,2);
  assert.equal((await db.prepare('SELECT * FROM auth_account').all()).meta.changes,0); db.close();
});
test('a failed audit rolls back the entire preceding mutation', async () => {
  const db = open();
  await assert.rejects(db.batch([db.prepare("INSERT INTO auth_account VALUES(1,'hash','salt',1)"),db.prepare('INSERT INTO audit(ts,action) VALUES(NULL,NULL)')]));
  assert.equal(await db.prepare('SELECT * FROM auth_account').first(),null); db.close();
});
test('failed conditional write does not emit audit or delete another row', async () => {
  const db = open();
  const rows = await db.batch([db.prepare('UPDATE auth_account SET initialized_at=2 WHERE id=1'),db.prepare("INSERT INTO audit(ts,action) SELECT 1,'wrong' WHERE changes()>0")]);
  assert.equal(rows[0].meta.changes,0); assert.equal(rows[1].meta.changes,0); db.close();
});
test('database, KV and consistent backup survive connection restart', async () => {
  const folder = mkdtempSync(path.join(tmpdir(),'uvel-aws-storage-')); const file = path.join(folder,'data.sqlite');
  const db = new SqliteDatabase(file); migrate(db,migrations); await persistentKv(db).put('geo','{"version":2}');
  await db.backup(path.join(folder,'backup.sqlite')); db.close();
  for (const name of ['data.sqlite','backup.sqlite']) { const restored = new SqliteDatabase(path.join(folder,name)); assert.deepEqual(await persistentKv(restored).get('geo','json'),{version:2}); restored.close(); }
  assert.ok(readFileSync(path.join(folder,'backup.sqlite')).length > 0);
});
test('KV expiration is enforced on reads', async () => { const db = open(); const kv = persistentKv(db); await kv.put('old','value',{expiration:1}); assert.equal(await kv.get('old'),null); db.close(); });
