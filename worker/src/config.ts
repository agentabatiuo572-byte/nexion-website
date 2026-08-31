import { Hono } from 'hono';
import { SiteConfigSchema, buildManifest, diffPaths, sensitivePaths, validateConfig, type CopyManifest, type SiteConfig } from '../../schema/src/index.js';
import seedJson from '../seed/site-config.seed.json';
import manifestJson from '../seed/copy-manifest.json';
import type { Env } from './env';
import { writeAudit } from './audit';

/* 配置模型(CON04-A1/E3 + CON13-③ 版本表底座)。
   编辑面永不直写线上:一切上新只经发布流水线(T21);此处只有 草稿/校验/版本读。 */

const SEED = SiteConfigSchema.parse(seedJson);
const MANIFEST = manifestJson as unknown as CopyManifest;

interface DraftRow {
  payload: string;
  draft_rev: number;
  updated_at: number;
}

/** 首访种子化:live v1 = 种子,草稿 = 种子副本(幂等) */
async function ensureInit(db: D1Database): Promise<void> {
  const has = await db.prepare('SELECT id FROM config_versions LIMIT 1').first();
  if (has) return;
  const now = Date.now();
  await db.batch([
    db
      .prepare("INSERT INTO config_versions (status, payload, reason, created_by, created_at, published_at) VALUES ('live', ?1, '初始种子(=上线前站内容)', 'system', ?2, ?2)")
      .bind(JSON.stringify(SEED), now),
    db.prepare('INSERT OR IGNORE INTO config_draft (id, payload, base_revision, updated_at, draft_rev) VALUES (1, ?1, 1, ?2, 1)').bind(JSON.stringify(SEED), now),
  ]);
}

async function getDraft(db: D1Database): Promise<DraftRow> {
  return (await db.prepare('SELECT payload, draft_rev, updated_at FROM config_draft WHERE id = 1').first<DraftRow>())!;
}

async function getLive(db: D1Database): Promise<{ id: number; payload: string; published_at: number } | null> {
  return db
    .prepare("SELECT id, payload, published_at FROM config_versions WHERE status = 'live' ORDER BY id DESC LIMIT 1")
    .first<{ id: number; payload: string; published_at: number }>();
}

export const configRoutes = new Hono<{ Bindings: Env }>();

/** 概览:壳状态条与各模块共用(CON02-③) */
configRoutes.get('/', async (c) => {
  await ensureInit(c.env.DB);
  const [draft, live] = await Promise.all([getDraft(c.env.DB), getLive(c.env.DB)]);
  const changed = diffPaths(JSON.parse(live!.payload), JSON.parse(draft.payload));
  return c.json({
    liveVersion: live!.id,
    livePublishedAt: live!.published_at,
    draft: { payload: JSON.parse(draft.payload) as SiteConfig, draftRev: draft.draft_rev, updatedAt: draft.updated_at },
    dirty: changed.length,
    changedPaths: changed.slice(0, 200),
    sensitiveChanged: sensitivePaths(changed),
  });
});

/** 存草稿(CON04-A1/E1/E3):结构校验拦、禁用词不拦(红旗留发布前置);乐观锁 409 */
configRoutes.put('/draft', async (c) => {
  await ensureInit(c.env.DB);
  const body = await c.req.json<{ payload?: unknown; baseRevision?: number }>().catch(() => null);
  if (!body || typeof body.baseRevision !== 'number') return c.json({ error: 'bad-request' }, 400);
  const parsed = SiteConfigSchema.safeParse(body.payload);
  if (!parsed.success) return c.json({ error: 'bad-structure', issues: parsed.error.issues.slice(0, 10) }, 400);
  const cur = await getDraft(c.env.DB);
  if (cur.draft_rev !== body.baseRevision) return c.json({ error: 'conflict', draftRev: cur.draft_rev }, 409); // E3:不静默覆盖
  const now = Date.now();
  const changed = diffPaths(JSON.parse(cur.payload), parsed.data);
  await c.env.DB
    .prepare('UPDATE config_draft SET payload = ?1, updated_at = ?2, draft_rev = draft_rev + 1 WHERE id = 1 AND draft_rev = ?3')
    .bind(JSON.stringify(parsed.data), now, body.baseRevision)
    .run();
  await writeAudit(c.env.DB, {
    action: 'config.save',
    target: 'draft',
    after: `${changed.length} 处改动:${changed.slice(0, 5).join(', ')}${changed.length > 5 ? ' …' : ''}`,
  });
  return c.json({ ok: true, draftRev: cur.draft_rev + 1, changedFromPrev: changed.length });
});

/** 发布前置校验(CON13-E1 的数据源;也供各模块「保存时即时校验」共用) */
configRoutes.post('/validate', async (c) => {
  await ensureInit(c.env.DB);
  const body = await c.req.json<{ payload?: unknown }>().catch(() => null);
  const target = body?.payload ?? JSON.parse((await getDraft(c.env.DB)).payload);
  const parsed = SiteConfigSchema.safeParse(target);
  if (!parsed.success) return c.json({ errors: parsed.error.issues.slice(0, 20).map((i) => ({ path: i.path.join('.'), rule: 'structure', message: i.message })), warnings: [] });
  const live = await getLive(c.env.DB);
  const changed = live ? diffPaths(JSON.parse(live.payload), parsed.data) : [];
  const { errors, warnings } = validateConfig(parsed.data, MANIFEST);
  return c.json({ errors, warnings, sensitiveChanged: sensitivePaths(changed) });
});

/** 版本列表(CON13-⑤ 下半;发布/回滚动作归 T21) */
configRoutes.get('/versions', async (c) => {
  await ensureInit(c.env.DB);
  const rows = await c.env.DB
    .prepare('SELECT id, status, reason, fail_reason, created_by, created_at, published_at FROM config_versions ORDER BY id DESC LIMIT 50')
    .all();
  return c.json({ items: rows.results });
});
