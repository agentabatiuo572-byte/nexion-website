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
  'geo.update',
  'bypass.issue',
  'config.publish',
  'config.publish.live',
  'config.publish.failed',
  'config.publish.cancel',
  /* 被并发挡下的发起。不建版本行(否则会造出清不掉的假红条),但要留一行审计——
     否则「谁在什么时候试图发布过、被谁挡了」在系统里彻底查不到(第四轮 P2-4)。 */
  'config.publish.rejected',
  'config.rollback',
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

/* 类型分组:一个类别可能横跨多个前缀。
   🔴 CON14-② 写死了四类「内容 / 规则 / 发布 / 登录」,而上一版只支持**单前缀**,
   于是「发布」这一类根本建不出来 —— 发布/回滚/取消被塞进语义相反的「内容」底下
   (第十轮独立验收 P1-5:点「内容」会看到七种动作,其中六种是发布相关的)。
   分组定义放服务端:前端只传类别名,两边不会各自演化出不同的归类。 */
export const AUDIT_GROUPS: Record<string, readonly string[]> = {
  content: ['config.save'],
  publish: ['config.publish', 'config.rollback'],
  geo: ['geo.', 'bypass.'],
  session: ['login.', 'auth.'],
  ops: ['admin.'],
};

auditRoutes.get('/', async (c) => {
  const limit = Math.min(Number(c.req.query('limit') ?? 50) || 50, 200);
  const before = Number(c.req.query('before') ?? 0) || null; // 游标:取 id < before
  const group = c.req.query('group') ?? null; // 类别过滤(见 AUDIT_GROUPS)
  const action = c.req.query('action') ?? null; // 单前缀过滤(旧口径,保留)
  /* 时间过滤:CON14-② A1「按类型**与时间**过滤」、⑤ 默认态「过滤条(类型/**时间**)」两处明写,
     而上一版一个日期输入都没有——出事后要查「昨天下午三点到四点」只能一页页往回按。 */
  const from = Number(c.req.query('from') ?? 0) || null;
  const to = Number(c.req.query('to') ?? 0) || null;

  const prefixes = group ? AUDIT_GROUPS[group] : action ? [action] : null;
  if (group && !prefixes) return c.json({ error: 'unknown-group' }, 400);
  // 多前缀:拼成 (action LIKE ?a || '%' OR action LIKE ?b || '%');无过滤时恒真
  const binds: unknown[] = [before, limit, from, to];
  const clause = prefixes
    ? `AND (${prefixes.map((_, i) => `action LIKE ?${5 + i} || '%'`).join(' OR ')})`
    : '';
  if (prefixes) binds.push(...prefixes);

  const rows = await c.env.DB.prepare(
    `SELECT id, ts, actor, action, target, before_summary, after_summary, reason
     FROM audit
     WHERE (?1 IS NULL OR id < ?1)
       AND (?3 IS NULL OR ts >= ?3)
       AND (?4 IS NULL OR ts <= ?4)
       ${clause}
     ORDER BY id DESC LIMIT ?2`,
  )
    .bind(...binds)
    .all<AuditRow>();
  return c.json({ items: rows.results, nextBefore: rows.results.at(-1)?.id ?? null });
});
