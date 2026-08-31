import { Hono } from 'hono';
import { SiteConfigSchema, diffPaths, sensitivePaths, validateConfig, type CopyManifest, type SiteConfig } from '../../schema/src/index.js';
import manifestJson from '../seed/copy-manifest.json';
import type { Env } from './env';
import { writeAudit } from './audit';
import { ensureInit } from './config';

/* 发布流水线(PRD CON13)。核心承诺:**不存在绕门发布的路径**——
   上新只经本文件的状态机,而状态机必然经过「前置校验 → 物化 → 站上全部机器门 → 构建 → 原子切换」。
   门红 → 版本标 failed、线上保持旧版、草稿原样保留(改动不丢)。回滚 = 以旧版内容发起新发布,同样走完整门链。
   执行器(materialize/gates/build/swap 的真正执行方)在 worker 之外:
   V1-dev = 本机脚本 runner,Phase C = CI runner,同一 §5.4 契约,worker 只做编排与状态机。 */

const MANIFEST = manifestJson as unknown as CopyManifest;
const LOCK_TTL_MS = 15 * 60_000;
export const PUBLISH_STEPS = ['materialize', 'gates', 'build', 'swap'] as const;
export type PublishStep = (typeof PUBLISH_STEPS)[number];

/** 门名 → 大白话(CON13-③;缺映射时显门名原文,绝不隐藏) */
export const GATE_REASONS: Record<string, string> = {
  'forbidden-words': '文案里有合规禁用词',
  'i18n-parity': '三语文案对不齐(有缺译或多余的键)',
  'deploy-gate': '还有未填充的信任资料占位标记',
  'launch-assets': '上线必备资产缺失(统计数字仍是演示值 / 缺联系方式 / 禁用的下载键没有说明)',
  'state-hook-consumer': '页面上有没人消费的状态钩子',
  'anchor-check': '页面锚点链接指向不存在的位置',
  'brand-parity': '品牌色与 App 端对不上',
  'particle-hue': '背景粒子色与品牌色偏离',
  'canvas-hazard': '画布内用了会被二次放大的视口单位',
  'css-shadowed': '样式里有写了但从不生效的死声明',
  'canvas-geometry': '画布几何在某些屏幕宽度下不成立',
  'render-fit': '新文案把版面挤破了(行压行 / 文字钻到导航底下 / 窄屏字号反向变大)',
  'deck-clearance': '设备叠卡的编舞几何侵入了左栏文字',
};
export const explainGate = (name: string): string => GATE_REASONS[name] ?? name;

interface LockRow { id: number; version_id: number; expires_at: number }

/** 取锁:并发发布只允许一个(E3);过期锁自动释放并把那一版标 failed */
async function acquireLock(env: Env, versionId: number, now: number): Promise<{ ok: true } | { ok: false; heldBy: number }> {
  const cur = await env.DB.prepare('SELECT id, version_id, expires_at FROM publish_lock WHERE id = 1').first<LockRow>();
  if (cur && cur.expires_at > now) return { ok: false, heldBy: cur.version_id };
  if (cur) {
    // 过期锁:上一次发布崩在半路 → 标 failed,别让它永远挂着 publishing
    await env.DB.batch([
      env.DB.prepare("UPDATE config_versions SET status='failed', fail_reason=?2 WHERE id=?1 AND status IN ('validating','publishing')").bind(cur.version_id, '发布超时(执行器无响应),锁已自动释放'),
      env.DB.prepare('DELETE FROM publish_lock WHERE id = 1'),
    ]);
  }
  await env.DB.prepare('INSERT INTO publish_lock (id, version_id, acquired_at, expires_at) VALUES (1, ?1, ?2, ?3)').bind(versionId, now, now + LOCK_TTL_MS).run();
  return { ok: true };
}
const releaseLock = (env: Env) => env.DB.prepare('DELETE FROM publish_lock WHERE id = 1').run();

async function getDraft(env: Env) {
  return (await env.DB.prepare('SELECT payload, draft_rev FROM config_draft WHERE id = 1').first<{ payload: string; draft_rev: number }>())!;
}
async function getLive(env: Env) {
  return env.DB.prepare("SELECT id, payload FROM config_versions WHERE status='live' ORDER BY id DESC LIMIT 1").first<{ id: number; payload: string }>();
}

export const publishRoutes = new Hono<{ Bindings: Env }>();

// 全新安装保障:任何发布相关入口先确保种子已就位(见 config.ts ensureInit 注释)
publishRoutes.use('*', async (c, next) => {
  await ensureInit(c.env.DB);
  await next();
});

/** 发布前置校验(CON13-E1 的唯一判据源;UI 的「去修复」清单也读它) */
publishRoutes.get('/preflight', async (c) => {
  const draft = await getDraft(c.env);
  const live = await getLive(c.env);
  const cfg = SiteConfigSchema.parse(JSON.parse(draft.payload));
  const { errors, warnings } = validateConfig(cfg, MANIFEST);
  const changed = live ? diffPaths(JSON.parse(live.payload) as never, cfg as never) : [];
  const sensitive = sensitivePaths(changed);
  return c.json({
    ready: errors.length === 0 && changed.length > 0,
    errors, warnings,
    changedPaths: changed,
    changed: changed.length,
    sensitiveChanged: sensitive,
    reasonRequired: sensitive.length > 0,
    draftRev: draft.draft_rev,
  });
});

/** 发起发布(CON13-A1):建版本行 → 取锁 → 交执行器;不做任何「跳过门」的分支 */
publishRoutes.post('/', async (c) => {
  const body = await c.req.json<{ reason?: string; fromVersion?: number }>().catch(() => null);
  const now = Date.now();
  const live = await getLive(c.env);

  // 回滚(A2):以指定旧版内容为发布内容,同样走完整门链
  let payload: string;
  let rollbackFrom: number | null = null;
  if (body?.fromVersion) {
    const src = await c.env.DB.prepare('SELECT id, payload FROM config_versions WHERE id = ?1').bind(body.fromVersion).first<{ id: number; payload: string }>();
    if (!src) return c.json({ error: 'version-not-found' }, 404);
    payload = src.payload;
    rollbackFrom = src.id;
  } else {
    payload = (await getDraft(c.env)).payload;
  }

  const cfg = SiteConfigSchema.safeParse(JSON.parse(payload));
  if (!cfg.success) return c.json({ error: 'bad-structure' }, 400);
  const { errors } = validateConfig(cfg.data, MANIFEST);
  if (errors.length) return c.json({ error: 'preflight-failed', errors: errors.slice(0, 50) }, 409); // E1:不进流水线

  const changed = live ? diffPaths(JSON.parse(live.payload) as never, cfg.data as never) : [];
  if (!rollbackFrom && changed.length === 0) return c.json({ error: 'no-changes' }, 409);
  const sensitive = sensitivePaths(changed);
  if ((sensitive.length > 0 || rollbackFrom) && (body?.reason ?? '').trim().length < 8) {
    return c.json({ error: 'reason-required', sensitiveChanged: sensitive }, 400); // 高敏/回滚须理由
  }

  const ins = await c.env.DB
    .prepare("INSERT INTO config_versions (status, payload, reason, created_by, created_at) VALUES ('validating', ?1, ?2, 'admin', ?3) RETURNING id")
    .bind(payload, body?.reason?.trim() ?? null, now)
    .first<{ id: number }>();
  const versionId = ins!.id;

  const lock = await acquireLock(c.env, versionId, now);
  if (!lock.ok) {
    await c.env.DB.prepare("UPDATE config_versions SET status='failed', fail_reason='有发布正在进行' WHERE id=?1").bind(versionId).run();
    return c.json({ error: 'publish-in-progress', heldBy: lock.heldBy }, 409);
  }
  await writeAudit(c.env.DB, {
    action: rollbackFrom ? 'config.rollback' : 'config.publish',
    target: `v${versionId}`,
    before: live ? `live=v${live.id}` : 'live=none',
    after: rollbackFrom ? `内容取自 v${rollbackFrom}` : `${changed.length} 处改动`,
    reason: body?.reason?.trim(),
  });
  return c.json({ ok: true, versionId, rollbackFrom, steps: PUBLISH_STEPS });
});

/** 执行器领取任务(§5.4 契约;dev 本机 runner / Phase C CI runner 共用) */
publishRoutes.get('/next', async (c) => {
  const lock = await c.env.DB.prepare('SELECT version_id, expires_at FROM publish_lock WHERE id = 1').first<{ version_id: number; expires_at: number }>();
  if (!lock || lock.expires_at < Date.now()) return c.json({ job: null });
  const v = await c.env.DB.prepare('SELECT id, status, payload FROM config_versions WHERE id = ?1').bind(lock.version_id).first<{ id: number; status: string; payload: string }>();
  if (!v || !['validating', 'publishing'].includes(v.status)) return c.json({ job: null });
  return c.json({ job: { versionId: v.id, config: JSON.parse(v.payload) as SiteConfig, steps: PUBLISH_STEPS } });
});

/** 执行器回报步骤(running/ok/failed);任一步 failed → 版本 failed + 释放锁,线上保持旧版 */
publishRoutes.post('/step', async (c) => {
  const b = await c.req.json<{ versionId?: number; step?: PublishStep; status?: string; detail?: string; gate?: string }>().catch(() => null);
  if (!b?.versionId || !b.step || !PUBLISH_STEPS.includes(b.step) || !['running', 'ok', 'failed'].includes(b.status ?? '')) {
    return c.json({ error: 'bad-request' }, 400);
  }
  const now = Date.now();
  const lock = await c.env.DB.prepare('SELECT version_id FROM publish_lock WHERE id = 1').first<{ version_id: number }>();
  if (!lock || lock.version_id !== b.versionId) return c.json({ error: 'not-current-job' }, 409);

  if (b.status === 'running') {
    await c.env.DB.batch([
      c.env.DB.prepare('INSERT INTO publish_steps (version_id, step, status, started_at) VALUES (?1,?2,?3,?4)').bind(b.versionId, b.step, 'running', now),
      c.env.DB.prepare("UPDATE config_versions SET status='publishing' WHERE id=?1").bind(b.versionId),
      c.env.DB.prepare('UPDATE publish_lock SET expires_at=?2 WHERE id=1').bind(b.versionId, now + LOCK_TTL_MS), // 心跳续锁
    ]);
    return c.json({ ok: true });
  }

  await c.env.DB
    .prepare("UPDATE publish_steps SET status=?3, detail=?4, ended_at=?5 WHERE version_id=?1 AND step=?2 AND status='running'")
    .bind(b.versionId, b.step, b.status, b.detail ?? null, now)
    .run();

  if (b.status === 'failed') {
    const reason = b.gate ? `${explainGate(b.gate)}(门:${b.gate})` : (b.detail ?? '执行器报告失败');
    await c.env.DB.batch([
      c.env.DB.prepare("UPDATE config_versions SET status='failed', fail_reason=?2 WHERE id=?1").bind(b.versionId, reason),
      c.env.DB.prepare('DELETE FROM publish_lock WHERE id = 1'),
    ]);
    await writeAudit(c.env.DB, { action: 'config.publish.failed', target: `v${b.versionId}`, after: reason });
    return c.json({ ok: true, failed: true, reason });
  }

  // 最后一步成功 = 原子切换:旧 live 退历史,新版本上线
  if (b.step === 'swap') {
    const live = await getLive(c.env);
    const stmts = [
      c.env.DB.prepare("UPDATE config_versions SET status='live', published_at=?2 WHERE id=?1").bind(b.versionId, now),
      c.env.DB.prepare('DELETE FROM publish_lock WHERE id = 1'),
    ];
    if (live) stmts.unshift(c.env.DB.prepare("UPDATE config_versions SET status='archived' WHERE id=?1").bind(live.id));
    await c.env.DB.batch(stmts);
    await writeAudit(c.env.DB, { action: 'config.publish.live', target: `v${b.versionId}`, before: live ? `v${live.id}` : 'none' });
  }
  return c.json({ ok: true });
});

/** 版本列表 + 当前发布进度(UI 轮询用) */
publishRoutes.get('/status', async (c) => {
  const lock = await c.env.DB.prepare('SELECT version_id, expires_at FROM publish_lock WHERE id = 1').first<{ version_id: number; expires_at: number }>();
  const active = lock && lock.expires_at > Date.now() ? lock.version_id : null;
  const steps = active
    ? (await c.env.DB.prepare('SELECT step, status, detail, started_at, ended_at FROM publish_steps WHERE version_id=?1 ORDER BY id').bind(active).all()).results
    : [];
  const versions = (
    await c.env.DB
      .prepare('SELECT id, status, reason, fail_reason, created_by, created_at, published_at FROM config_versions ORDER BY id DESC LIMIT 30')
      .all<{ id: number; status: string; reason: string | null; fail_reason: string | null; created_by: string; created_at: number; published_at: number | null }>()
  ).results;
  return c.json({ activeVersion: active, steps, versions, stepNames: PUBLISH_STEPS });
});

/** 取消排队中的发布(CON13-E4:执行器不在线时不吊死) */
publishRoutes.post('/cancel', async (c) => {
  const lock = await c.env.DB.prepare('SELECT version_id FROM publish_lock WHERE id = 1').first<{ version_id: number }>();
  if (!lock) return c.json({ error: 'no-active-publish' }, 409);
  const started = await c.env.DB.prepare("SELECT COUNT(*) n FROM publish_steps WHERE version_id=?1 AND status<>'running'").bind(lock.version_id).first<{ n: number }>();
  if ((started?.n ?? 0) > 0) return c.json({ error: 'already-running(已有步骤完成,不可取消)' }, 409);
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE config_versions SET status='failed', fail_reason='已取消(执行器未上线)' WHERE id=?1").bind(lock.version_id),
    c.env.DB.prepare('DELETE FROM publish_lock WHERE id = 1'),
  ]);
  await writeAudit(c.env.DB, { action: 'config.publish.cancel', target: `v${lock.version_id}` });
  return c.json({ ok: true });
});
