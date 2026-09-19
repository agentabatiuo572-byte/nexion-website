/** Read-only capability probe. Never migrate a database or resolve a job on a GET. */
export const PUBLISH_READINESS_PROTOCOL = 1;
export const PUBLISH_STORAGE_MIGRATION = '0021_publish_checks.sql';
export const PUBLISH_STORAGE_MESSAGE = '发布服务的数据库结构尚未升级，请通过启动器完成本地升级；生产环境请由维护人员应用数据库迁移。草稿和发布记录已保留。';

// A minimal read-only surface also allows regression tests against an in-memory SQLite DB.
export interface PublishReadDatabase {
  prepare(sql: string): {
    bind(...values: unknown[]): {
      first<T>(): Promise<T | null>;
    };
    all<T>(): Promise<{ results: T[] }>;
    first<T>(): Promise<T | null>;
  };
}

const CHECK_COLUMNS = ['id', 'version_id', 'step', 'seq', 'title', 'status', 'output', 'started_at', 'ended_at'];

export async function publishStorageReady(db: PublishReadDatabase): Promise<boolean> {
  // PRAGMA returns an empty result for a missing table, without hiding unrelated DB failures.
  const columns = await db.prepare('PRAGMA table_info(publish_checks)').all<{ name: string }>();
  const names = new Set(columns.results.map(column => column.name));
  if (!CHECK_COLUMNS.every(name => names.has(name))) return false;
  const indexes = await db.prepare('PRAGMA index_list(publish_checks)').all<{ name: string; unique: number }>();
  if (!indexes.results.some(index => index.name === 'idx_checks_version_seq' && index.unique === 1)) return false;
  const key = await db.prepare('PRAGMA index_info(idx_checks_version_seq)').all<{ seqno: number; name: string }>();
  return key.results.slice().sort((a, b) => a.seqno - b.seqno).map(column => column.name).join(',') === 'version_id,seq';
}

export async function publishReadiness(db: PublishReadDatabase, now = Date.now()) {
  const storageReady = await publishStorageReady(db);
  const active = await db.prepare("SELECT id FROM config_versions WHERE status IN ('validating','publishing','unknown') ORDER BY id LIMIT 1")
    .first<{ id: number }>();
  const held = await db.prepare('SELECT version_id FROM publish_lock WHERE expires_at>?1 LIMIT 1')
    .bind(now).first<{ version_id: number }>();
  return {
    protocol: PUBLISH_READINESS_PROTOCOL,
    storageReady,
    requiredMigration: PUBLISH_STORAGE_MIGRATION,
    // Only a missing schema plus a global no-job check authorizes a managed restart.
    // New submissions/claims are blocked by the same schema probe until migrations finish.
    restartSafe: !storageReady && !active && !held,
    activeVersion: active?.id ?? held?.version_id ?? null,
    message: storageReady ? '' : PUBLISH_STORAGE_MESSAGE,
  };
}

/** Existing tasks may still heartbeat and report terminal state during an upgrade. */
export function needsPublishStorage(route: string, method: string): boolean {
  return (method === 'POST' && ['publish', 'next', 'check'].includes(route))
    || (method === 'GET' && ['status', 'preflight'].includes(route));
}
