import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createBackup } from '../backup.mjs';
import { SqliteDatabase } from '../storage.mjs';
import { directoryDigest } from '../../lib/runner-artifacts.mjs';

test('backup pairs the snapshot with its verified release despite concurrent source changes', async()=>{
  const folder=mkdtempSync(path.join(tmpdir(),'uvel-aws-backup-'));
  const db=new SqliteDatabase(path.join(folder,'source.sqlite'));
  db.connection.exec("CREATE TABLE config_versions(id INTEGER,status TEXT,published_at INTEGER,claim_nonce TEXT); CREATE TABLE publish_lock(version_id INTEGER); INSERT INTO config_versions VALUES(1,'live',1,'current-incarnation')");
  const stale=path.join(folder,'releases','a-stale'); mkdirSync(stale,{recursive:true});
  writeFileSync(path.join(stale,'index.html'),'old incarnation of version one');
  writeFileSync(path.join(stale,'.publish-stamp.json'),JSON.stringify({versionId:1,stamp:'old-incarnation',artifact:directoryDigest(stale)}));
  const release=path.join(folder,'releases','z-current'); mkdirSync(release,{recursive:true});
  writeFileSync(path.join(release,'index.html'),'version one');
  writeFileSync(path.join(release,'.publish-stamp.json'),JSON.stringify({versionId:1,stamp:'current-incarnation',artifact:directoryDigest(release)}));
  const backup=db.backup.bind(db);
  db.backup=async file=>{await backup(file);db.connection.exec("UPDATE config_versions SET id=2");};
  const result=await createBackup({db,destination:path.join(folder,'backups'),livePath:path.join(folder,'current')});
  assert.equal(result.versions[0].id,1);assert.equal(result.recoveryRelease,release);assert.equal(result.recoveryStatus,'ready');
  const restored=new SqliteDatabase(result.database);assert.equal(await restored.prepare('SELECT id FROM config_versions').first('id'),1);restored.close();
  db.connection.exec('UPDATE config_versions SET id=1');
  writeFileSync(path.join(release,'index.html'),'tampered');
  const second=await createBackup({db,destination:path.join(folder,'more-backups'),livePath:path.join(folder,'current')});
  assert.equal(second.versions[0].id,1);assert.equal(second.recoveryRelease,null);assert.equal(second.recoveryStatus,'unverified');db.close();
});
