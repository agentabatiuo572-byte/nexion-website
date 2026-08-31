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
  const livePayload = JSON.parse(live!.payload) as SiteConfig;
  const changed = diffPaths(livePayload, JSON.parse(draft.payload));
  return c.json({
    liveVersion: live!.id,
    livePublishedAt: live!.published_at,
    live: { payload: livePayload }, // 编辑器「查看线上值/行级撤销」的对照源(CON04-⑥)
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
  // CON04-E2(T11 验收 P-2 修):占位符守恒是「保存级」硬拦——缺了站上渲染字面残缺;
  // 禁用词/缺译仍为草稿可存、发布拦(E1/E4 的分层设计不变)
  const placeholderErrs = validateConfig(parsed.data, MANIFEST).errors.filter((e) => e.rule === 'placeholder');
  if (placeholderErrs.length) return c.json({ error: 'placeholder', issues: placeholderErrs.slice(0, 10) }, 400);
  const prev = JSON.parse(cur.payload) as SiteConfig;
  // CON09-E3:公告内容(文案/链接)变更 → server 换 id(访客关闭记忆按 id 记,新公告重新展示)
  const a = parsed.data.announcement;
  const pa = prev.announcement;
  if (JSON.stringify(a.text) !== JSON.stringify(pa.text) || a.href !== pa.href) {
    a.id = `ann-${crypto.randomUUID().slice(0, 8)}`;
  }
  // CON11-E3:Legal markdown 剥离危险节点(白名单外的可执行面),剥离计数回显给 UI 提示
  let sanitized = 0;
  for (const doc of ['terms', 'privacy', 'appPrivacy'] as const) {
    for (const loc of ['en', 'vi', 'zh'] as const) {
      const before = parsed.data.legal[doc].md[loc];
      const after = before
        .replace(/<script[\s\S]*?<\/script\s*>/gi, '')
        .replace(/<iframe[\s\S]*?(?:<\/iframe\s*>|\/>)/gi, '')
        .replace(/\son\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '');
      if (after !== before) {
        parsed.data.legal[doc].md[loc] = after;
        sanitized++;
      }
    }
  }
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
  return c.json({ ok: true, draftRev: cur.draft_rev + 1, changedFromPrev: changed.length, sanitized });
});

/** 服务端造 id(CON08-③:禁客户端造)。kind 封闭枚举,新集合类字段接入时扩 */
configRoutes.post('/mint-id', async (c) => {
  const body = await c.req.json<{ kind?: string }>().catch(() => null);
  if (body?.kind !== 'faq') return c.json({ error: 'bad-kind' }, 400);
  return c.json({ id: `faq-${crypto.randomUUID().slice(0, 8)}` });
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

/** 下载链接即时探活(CON05-⑥「立即探活」;定时巡检归 T19 运营健康)。
    预警不阻断:结果只回显,不写库不自动下架(CON05-④「永不自动下架」)。 */
configRoutes.post('/probe-downloads', async (c) => {
  const draft = await getDraft(c.env.DB);
  const cfg = (JSON.parse(draft.payload) as SiteConfig).downloads;
  const probe = async (url: string, enabled?: boolean) => {
    if (!enabled || !url) return { skipped: true as const }; // 未启用/未配置不打不报红(T12 验收 P-5)
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 5000);
      const res = await fetch(url, { method: 'HEAD', redirect: 'follow', signal: ctl.signal });
      clearTimeout(t);
      return { ok: res.status < 400, status: res.status };
    } catch {
      return { ok: false, status: 0, note: 'unreachable' };
    }
  };
  const [ios, android, h5] = await Promise.all([
    probe(cfg.ios.url, cfg.ios.enabled),
    probe(cfg.android.url, cfg.android.enabled),
    probe(cfg.h5.url, cfg.h5.enabled),
  ]);
  return c.json({ ios, android, h5, at: Date.now() });
});

/** 版本列表(CON13-⑤ 下半;发布/回滚动作归 T21) */
configRoutes.get('/versions', async (c) => {
  await ensureInit(c.env.DB);
  const rows = await c.env.DB
    .prepare('SELECT id, status, reason, fail_reason, created_by, created_at, published_at FROM config_versions ORDER BY id DESC LIMIT 50')
    .all();
  return c.json({ items: rows.results });
});
