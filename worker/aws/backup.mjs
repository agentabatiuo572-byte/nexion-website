import { mkdirSync, readlinkSync, writeFileSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { SqliteDatabase } from './storage.mjs';
import { assertDigest } from '../lib/runner-artifacts.mjs';

export async function createBackup({ db, destination, livePath }) {
  if (!destination || !path.isAbsolute(destination)) throw new Error('Absolute backup directory required');
  mkdirSync(destination, { recursive:true, mode:0o700 });
  const name = new Date().toISOString().replaceAll(':','-');
  const database = path.join(destination, `${name}.sqlite`);
  await db.backup(database);
  // Recovery metadata comes from the completed snapshot, never from the changing source.
  const snapshot = new DatabaseSync(database, { readOnly:true });
  let versions; let activeJobs;
  try {
    versions = snapshot.prepare("SELECT id,status,published_at,claim_nonce FROM config_versions WHERE status='live'").all().map(row=>({...row}));
    activeJobs = snapshot.prepare('SELECT count(*) AS n FROM publish_lock').get().n;
  } finally { snapshot.close(); }
  const releases = realpathSync(path.join(path.dirname(livePath),'releases'));
  let recoveryRelease = null;
  for (const entry of readdirSync(releases, {withFileTypes:true})) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const candidate = path.join(releases,entry.name);
    try {
      const stamp = JSON.parse(readFileSync(path.join(candidate,'.publish-stamp.json'),'utf8'));
      if (versions.length !== 1 || !versions[0].claim_nonce || stamp.versionId !== versions[0].id || stamp.stamp !== versions[0].claim_nonce || !stamp.artifact?.sha256) continue;
      assertDigest(candidate,stamp.artifact.sha256);
      recoveryRelease = candidate; break;
    } catch { /* An unverified or incomplete release cannot be a recovery target. */ }
  }
  let observedCurrent = null;
  try { observedCurrent = readlinkSync(livePath); } catch { /* Observation only. */ }
  const metadata = { at:new Date().toISOString(), database, versions:versions.map(({claim_nonce,...version})=>version), recoveryRelease,
    recoveryStatus:!recoveryRelease ? 'unverified' : activeJobs ? 'requires-reconciliation' : 'ready', activeJobs, observedCurrent };
  writeFileSync(path.join(destination, `${name}.json`), JSON.stringify(metadata,null,2), {mode:0o600});
  return metadata;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const db = new SqliteDatabase(process.env.AWS_DATABASE_PATH);
  try { const result = await createBackup({db,destination:process.argv[2],livePath:process.env.AWS_LIVE_PATH}); console.log(`UVEL database backup completed: ${result.recoveryStatus}`); }
  finally { db.close(); }
}
