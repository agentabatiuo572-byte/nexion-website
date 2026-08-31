import { Hono } from 'hono';
import type { Env } from './env';

/** 动作字典(PRD CON14-③,封闭枚举:新动作必须加进这里,审计覆盖测试按它遍历) */
export const AUDIT_ACTIONS = [
  'auth.setup',
  'login.success',
  'login.fail',
  'auth.logout',
  'admin.rollup',
  'config.save',
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export interface AuditEntry {
  action: AuditAction;
  target?: string;
  before?: string;
  after?: string;
  reason?: string;
  actor?: string;
}

/** 唯一写入口。append-only:全仓不存在 UPDATE/DELETE audit 的语句(CON14-E2 由路由审计测试守)。 */
export async function writeAudit(db: D1Database, e: AuditEntry): Promise<void> {
  await db
    .prepare(
      'INSERT INTO audit (ts, actor, action, target, before_summary, after_summary, reason) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)',
    )
    .bind(Date.now(), e.actor ?? 'admin', e.action, e.target ?? null, e.before ?? null, e.after ?? null, e.reason ?? null)
    .run();
}

export interface AuditRow {
  id: number;
  ts: number;
  actor: string;
  action: string;
  target: string | null;
  before_summary: string | null;
  after_summary: string | null;
  reason: string | null;
}

/** 只读查询路由(须挂在 requireAuth 之后);无任何变更路由——append-only。 */
export const auditRoutes = new Hono<{ Bindings: Env }>();

auditRoutes.get('/', async (c) => {
  const limit = Math.min(Number(c.req.query('limit') ?? 50) || 50, 200);
  const before = Number(c.req.query('before') ?? 0) || null; // 游标:取 id < before
  const action = c.req.query('action') ?? null; // 前缀过滤,如 "login."
  const rows = await c.env.DB.prepare(
    `SELECT id, ts, actor, action, target, before_summary, after_summary, reason
     FROM audit
     WHERE (?1 IS NULL OR id < ?1) AND (?2 IS NULL OR action LIKE ?2 || '%')
     ORDER BY id DESC LIMIT ?3`,
  )
    .bind(before, action, limit)
    .all<AuditRow>();
  return c.json({ items: rows.results, nextBefore: rows.results.at(-1)?.id ?? null });
});
