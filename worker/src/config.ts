import { Hono } from 'hono';
import { SiteConfigSchema, buildManifest, diffPaths, sensitivePaths, validateConfig, type CopyManifest, type SiteConfig } from '../../schema/src/index.js';
import seedJson from '../seed/site-config.seed.json';
import manifestJson from '../seed/copy-manifest.json';
import type { Env } from './env';
import { writeAudit } from './audit';
import { loadRules } from './geo';

/* 配置模型(CON04-A1/E3 + CON13-③ 版本表底座)。
   编辑面永不直写线上:一切上新只经发布流水线(T21);此处只有 草稿/校验/版本读。 */

const SEED = SiteConfigSchema.parse(seedJson);
const MANIFEST = manifestJson as unknown as CopyManifest;

interface DraftRow {
  payload: string;
  draft_rev: number;
  updated_at: number;
}

/** 首访种子化:live v1 = 种子,草稿 = 种子副本(幂等)。
    🔴 发布/驾驶舱等一切读配置的入口都必须先调它——否则全新安装上直接调用会读到 null 而 500
    (T21 测试实证:发布接口漏调,空库发起发布即崩)。 */
export async function ensureInit(db: D1Database): Promise<void> {
  /* 两张表都要在。此前只看版本表,于是「版本表有行、草稿行没了」这种半初始化状态会被判成
     「已初始化」直接返回,概览接口随后在 draft.payload 上 500(2026-09-01 写 CON02-E2 测试时撞到)。
     下面两条 INSERT 各自带 OR IGNORE / 条件,补哪张都安全。 */
  const [hasVer, hasDraft] = await Promise.all([
    db.prepare('SELECT id FROM config_versions LIMIT 1').first(),
    db.prepare('SELECT id FROM config_draft WHERE id = 1').first(),
  ]);
  if (hasVer && hasDraft) return;
  const now = Date.now();
  if (hasVer) {
    // 版本在、草稿丢了:用当前线上内容补一份草稿,别去动版本历史
    const live = await db.prepare("SELECT payload FROM config_versions WHERE status='live' ORDER BY id DESC LIMIT 1").first<{ payload: string }>();
    await db
      .prepare('INSERT OR IGNORE INTO config_draft (id, payload, base_revision, updated_at, draft_rev) VALUES (1, ?1, 1, ?2, 1)')
      .bind(live?.payload ?? JSON.stringify(SEED), now)
      .run();
    return;
  }
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
  // CON02-③ geoEnabled:壳状态条第三 chip 的只读数据源(包④ 挂账「待 CON12 接真」,T17 交付后此处关账)
  const geo = await loadRules(c.env).catch(() => null);
  /* CON02-E2:上次发布失败 → 壳顶红条。只在「失败的那一版比线上还新」时才报——
     线上之后再没成功发布过,才说明有一次失败还没被人处理掉。
     (2026-09-01 复验 P1-D:此条 AC 明写移交本包,但接口没返、壳也没渲染,整条缺席。) */
  const lastFail = await c.env.DB
    .prepare("SELECT id, fail_reason, created_at FROM config_versions WHERE status='failed' AND id > ?1 ORDER BY id DESC LIMIT 1")
    .bind(live!.id)
    .first<{ id: number; fail_reason: string | null; created_at: number }>();
  return c.json({
    liveVersion: live!.id,
    livePublishedAt: live!.published_at,
    lastPublishFailed: lastFail ? { id: lastFail.id, reason: lastFail.fail_reason ?? '原因未记录', at: lastFail.created_at } : null,
    geo: geo ? { enabled: geo.rules.enabled, countries: geo.rules.countries.length, degraded: geo.degraded } : null,
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
  // CON09-E3:公告内容(文案/链接)变更 → server 换 id(访客关闭记忆按 id 记,新公告重新展示)。
  // T14 验收 P-3:内容改回与线上完全一致时还原线上 id——手工全量回滚不留幽灵改动。
  const a = parsed.data.announcement;
  const pa = prev.announcement;
  const liveRow = await getLive(c.env.DB);
  const la = liveRow ? (JSON.parse(liveRow.payload) as SiteConfig).announcement : null;
  if (la && JSON.stringify(a.text) === JSON.stringify(la.text) && a.href === la.href) {
    a.id = la.id;
  } else if (JSON.stringify(a.text) !== JSON.stringify(pa.text) || a.href !== pa.href) {
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

/** 下载链接探活(CON05-⑥ 按需 + CON03-③ 定时 6h 巡检共用同一实现,禁两套判据)。
    预警不阻断:结果只回显/落库,不自动下架(CON05-④「永不自动下架」)。 */
export async function probeDownloads(env: Env, persist: boolean): Promise<Record<string, unknown>> {
  const draft = await env.DB.prepare('SELECT payload FROM config_draft WHERE id = 1').first<{ payload: string }>();
  const live = await env.DB.prepare("SELECT payload FROM config_versions WHERE status='live' ORDER BY id DESC LIMIT 1").first<{ payload: string }>();
  // 定时巡检看**线上**配置(线上才是访客真正点到的);按需探活看草稿(改完想立刻试)
  const src = persist ? (live?.payload ?? draft?.payload) : (draft?.payload ?? live?.payload);
  if (!src) return { at: Date.now() };
  const cfg = (JSON.parse(src) as SiteConfig).downloads;
  const one = async (url: string, enabled: boolean) => {
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
  const targets = ['ios', 'android', 'h5'] as const;
  const results = await Promise.all(targets.map((k) => one(cfg[k].url, cfg[k].enabled)));
  const out: Record<string, unknown> = { at: Date.now() };
  const now = Date.now();
  const stmts: D1PreparedStatement[] = [];
  targets.forEach((k, i) => {
    const r = results[i]!;
    out[k] = r;
    if (!persist) return;
    if ('skipped' in r) {
      stmts.push(env.DB.prepare('DELETE FROM probe_status WHERE target = ?1').bind(k)); // 未启用的不留旧红
      return;
    }
    // 连续失败计数:成功清零,失败 +1(CON03-E3 判据「连续 2 次失败」)
    stmts.push(
      env.DB
        .prepare(
          `INSERT INTO probe_status (target, url, ok, status, fail_streak, checked_at) VALUES (?1,?2,?3,?4,?5,?6)
           ON CONFLICT(target) DO UPDATE SET url=?2, ok=?3, status=?4, checked_at=?6,
             fail_streak = CASE WHEN ?3 = 1 THEN 0 ELSE fail_streak + 1 END`,
        )
        .bind(k, cfg[k].url, r.ok ? 1 : 0, r.status, r.ok ? 0 : 1, now),
    );
  });
  if (stmts.length) await env.DB.batch(stmts);
  return out;
}

configRoutes.post('/probe-downloads', async (c) => c.json(await probeDownloads(c.env, false)));

/** 版本列表(CON13-⑤ 下半;发布/回滚动作归 T21) */
configRoutes.get('/versions', async (c) => {
  await ensureInit(c.env.DB);
  const rows = await c.env.DB
    .prepare('SELECT id, status, reason, fail_reason, created_by, created_at, published_at FROM config_versions ORDER BY id DESC LIMIT 50')
    .all();
  return c.json({ items: rows.results });
});
