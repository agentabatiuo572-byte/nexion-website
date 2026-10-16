import { DatabaseSync, backup } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, mkdirSync } from 'node:fs';
import path from 'node:path';

// D1's transactional subset used by the application. No await occurs inside a batch:
// changes() and audit guards always observe the preceding statement on this connection.
export class SqliteDatabase {
  constructor(filename) {
    if (filename !== ':memory:') mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    this.connection = new DatabaseSync(filename);
    this.connection.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
  }
  prepare(sql) { return new Statement(this, sql, []); }
  async batch(statements) {
    this.connection.exec('BEGIN IMMEDIATE');
    try {
      const result = statements.map(statement => {
        if (!(statement instanceof Statement) || statement.db !== this) throw new Error('Foreign database statement');
        return statement.execute();
      });
      this.connection.exec('COMMIT');
      return result;
    } catch (error) { this.connection.exec('ROLLBACK'); throw error; }
  }
  close() { this.connection.close(); }
  async backup(filename) { await backup(this.connection, filename); }
}

class Statement {
  constructor(db, sql, values) { this.db = db; this.sql = sql; this.values = values; }
  bind(...values) { return new Statement(this.db, this.sql, values); }
  execute() {
    const conn = this.db.connection;
    const started = performance.now();
    const before = conn.prepare('SELECT total_changes() AS n').get().n;
    const statement = conn.prepare(this.sql);
    // Skip SQL literals, quoted identifiers and comments when discovering numbered binds.
    const tokens = this.sql.match(/'(?:''|[^'])*'|"(?:""|[^"])*"|`[^`]*`|\[[^\]]*\]|--[^\n]*|\/\*[\s\S]*?\*\/|\?\d*/g) ?? [];
    const numbers = tokens.filter(token => /^\?\d+$/.test(token)).map(token => Number(token.slice(1)));
    if (numbers.length && tokens.includes('?')) throw new Error('Mixed SQL parameter styles are unsupported');
    if (numbers.some(n => n < 1 || n > this.values.length)) throw new Error('Missing SQL bind parameter');
    const args = numbers.length ? [Object.fromEntries([...new Set(numbers)].map(n => [String(n), this.values[n - 1]]))] : this.values;
    const results = statement.all(...args).map(row => ({ ...row }));
    const info = conn.prepare('SELECT changes() AS changes, total_changes() AS total, last_insert_rowid() AS rowid').get();
    const changes = info.total === before ? 0 : info.changes;
    return { success: true, results, meta: { changes, last_row_id: info.rowid, changed_db: info.total !== before, duration: performance.now() - started } };
  }
  async all() { return this.execute(); }
  async run() { return this.execute(); }
  async first(column) {
    const row = this.execute().results[0];
    if (!row) return null;
    if (column !== undefined && !Object.hasOwn(row, column)) throw new Error('Unknown result column');
    return column === undefined ? row : row[column];
  }
}

export function migrate(db, directory) {
  const conn = db.connection;
  conn.exec('CREATE TABLE IF NOT EXISTS _aws_migrations(name TEXT PRIMARY KEY, sha256 TEXT NOT NULL, applied_at INTEGER NOT NULL)');
  for (const name of readdirSync(directory).filter(n => /^\d+_.+\.sql$/.test(n)).sort()) {
    const sql = readFileSync(path.join(directory, name), 'utf8');
    const digest = createHash('sha256').update(sql.replaceAll('\r\n', '\n')).digest('hex');
    const prior = conn.prepare('SELECT sha256 FROM _aws_migrations WHERE name=?').get(name);
    if (prior) { if (prior.sha256 !== digest) throw new Error(`Applied migration changed: ${name}`); continue; }
    conn.exec('BEGIN IMMEDIATE');
    try {
      conn.exec(sql);
      conn.prepare('INSERT INTO _aws_migrations VALUES(?,?,?)').run(name, digest, Date.now());
      conn.exec('COMMIT');
    } catch (error) { conn.exec('ROLLBACK'); throw error; }
  }
  conn.exec('CREATE TABLE IF NOT EXISTS _aws_kv(key TEXT PRIMARY KEY, value TEXT NOT NULL, expires_at INTEGER)');
}

export function persistentKv(db) {
  return {
    async get(key, options) {
      const row = await db.prepare('SELECT value FROM _aws_kv WHERE key=? AND (expires_at IS NULL OR expires_at>?)').bind(key, Date.now()).first();
      if (!row) return null;
      return (typeof options === 'string' ? options : options?.type) === 'json' ? JSON.parse(row.value) : row.value;
    },
    async put(key, value, options = {}) {
      if (typeof value !== 'string') throw new Error('KV requires a string');
      const expiration = options.expiration ? options.expiration * 1000 : options.expirationTtl ? Date.now() + options.expirationTtl * 1000 : null;
      await db.prepare('INSERT INTO _aws_kv VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,expires_at=excluded.expires_at').bind(key, value, expiration).run();
    },
    async delete(key) { await db.prepare('DELETE FROM _aws_kv WHERE key=?').bind(key).run(); },
  };
}
