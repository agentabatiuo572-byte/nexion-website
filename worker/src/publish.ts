import { Hono } from 'hono';
import { SiteConfigSchema, diffPaths, materializeSiteJson, sensitivePaths, validateConfig, type CopyManifest, type SiteConfig } from '../../schema/src/index.js';
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
  'config-consistency': '服务端配置与代码对不上(定时任务 / 伺服目录 / 失败面映射)',
};
export const explainGate = (name: string): string => GATE_REASONS[name] ?? name;

interface LockRow { id: number; version_id: number; expires_at: number; claim_nonce: string | null; claimed_at: number | null }

/** 线上快照里的上线印记,由 promote.mjs 写入;服务端标 live 前回读核实(见 STAMP_WHY) */
const STAMP_PATH = '/.publish-stamp.json';

/* 🔴 STAMP_WHY(2026-09-01 复验 P0-A)——为什么标 live 之前要去读文件:
   上一版修法只封了三种**畸形上报序列**(跳步 / 不先报 running / 过期锁)。
   但「老老实实把四步按顺序各报一遍」根本不畸形,于是纯 HTTP 调用者依然能让版本上线而一道门没跑,
   且伪造出的步骤记录与真发布**完全同形**(唯一差别是 gates 只花了几十毫秒,而没有任何东西在看这个)。
   根因不是序列校验不够严,是**服务端信了汇报**——它把「执行器说做完了」当成「确实做完了」。
   序列校验再加几条也堵不住,因为伪造者只要照着合法序列走。
   改成**服务端核实结果**:上线要求线上快照里存在一枚带本次一次性口令的印记,
   而那枚印记只有真跑过 promote.mjs(即真搬运过已过门产物)才会落到文件系统里。
   HTTP 面上无论发多少个请求都写不出这个文件,于是「不存在绕门发布 API」从口号变成了机器事实。 */

const randomHex = (n: number) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => b.toString(16).padStart(2, '0')).join('');

/** 取锁:并发发布只允许一个(E3);过期锁自动释放并把那一版标 failed。同时生成本次的一次性口令。 */
async function acquireLock(env: Env, versionId: number, now: number): Promise<{ ok: true; nonce: string } | { ok: false; heldBy: number }> {
  const cur = await env.DB.prepare('SELECT id, version_id, expires_at, claim_nonce, claimed_at FROM publish_lock WHERE id = 1').first<LockRow>();
  if (cur && cur.expires_at > now) return { ok: false, heldBy: cur.version_id };
  if (cur) {
    // 过期锁:上一次发布崩在半路 → 标 failed,别让它永远挂着 publishing
    await env.DB.batch([
      env.DB.prepare("UPDATE config_versions SET status='failed', fail_reason=?2 WHERE id=?1 AND status IN ('validating','publishing')").bind(cur.version_id, '发布超时(执行器无响应),锁已自动释放'),
      env.DB.prepare('DELETE FROM publish_lock WHERE id = 1'),
    ]);
  }
  const nonce = randomHex(16);
  await env.DB.prepare('INSERT INTO publish_lock (id, version_id, acquired_at, expires_at, claim_nonce) VALUES (1, ?1, ?2, ?3, ?4)').bind(versionId, now, now + LOCK_TTL_MS, nonce).run();
  return { ok: true, nonce };
}
const releaseLock = (env: Env) => env.DB.prepare('DELETE FROM publish_lock WHERE id = 1').run();

/** 读线上快照的上线印记。读不到 / 读不动都返回 null —— 由调用方判成「不许上线」(fail-closed)。 */
async function readLiveStamp(env: Env): Promise<{ versionId?: number; stamp?: string; configSha?: string } | null> {
  try {
    const res = await env.ASSETS.fetch(new Request(`https://assets.internal${STAMP_PATH}`, { method: 'GET' }));
    if (!res.ok) return null;
    return (await res.json()) as { versionId?: number; stamp?: string; configSha?: string };
  } catch {
    return null;
  }
}

/** 这一版的配置**该**物化成什么样 —— 服务端自己算,不问执行器(见 STAMP_WHY 第二段) */
async function expectedConfigSha(payload: string): Promise<string> {
  const json = materializeSiteJson(SiteConfigSchema.parse(JSON.parse(payload)));
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(json));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** 线上快照实际是哪一版(据印记);与数据库记的 live 不一致 = 劈叉,必须让人看见 */
export async function liveSnapshotDrift(env: Env): Promise<{ dbLive: number; snapshot: number | null } | null> {
  const [stamp, live] = await Promise.all([readLiveStamp(env), getLive(env)]);
  if (!live) return null;
  const snapVer = stamp?.versionId ?? null;
  if (snapVer === live.id) return null;
  /* 全新环境豁免:线上那一版是**初始种子**(= 上线前手工构建的站内容,从没走过流水线),
     快照自然没有上线印记。此时报劈叉是永久噪音,而永久红条只会训练人忽略红条。
     一旦真发布过一次,种子就不再是 live,这条豁免自动失效。 */
  if (snapVer === null) {
    const seed = await env.DB.prepare("SELECT created_by FROM config_versions WHERE id=?1").bind(live.id).first<{ created_by: string }>();
    if (seed?.created_by === 'system') return null;
  }
  return { dbLive: live.id, snapshot: snapVer };
}

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
    /* 🔴 拿不到锁 = 这次发布**根本没开始过**,把刚建的行删掉,别留成 failed(2026-09-01 复验 P1-1)。
       留成 failed 的后果不是多一行历史:壳顶红条判「有比线上更新的失败版本」,
       而这行垃圾的 id 永远比线上大,于是运营多点一次「发布」,就会得到一条
       **成功发布也清不掉**的假红条,写着一个从没发布过的版本号。
       这一族的教训:**没发生过的事不要留痕迹**——留了就会被别处当成事实读。 */
    await c.env.DB.prepare('DELETE FROM config_versions WHERE id=?1').bind(versionId).run();
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

/** 执行器领取任务(§5.4 契约;dev 本机 runner / Phase C CI runner 共用)。
    已有步骤开始的任务不再派发:防两个执行器领到同一单各干各的(验收 P1「/next 无租约」)。
    执行器崩溃后的续跑走「锁过期 → 自愈标 failed → 重新发起」,不靠二次派发同一单。 */
/* 用 POST:领单会**写库**(原子占位),不该是 GET。
   带副作用的 GET 在 SameSite=Lax 下是会被跨站顶层导航触发的那一类(复验 P2)。 */
publishRoutes.post('/next', async (c) => {
  const lock = await c.env.DB.prepare('SELECT version_id, expires_at FROM publish_lock WHERE id = 1').first<{ version_id: number; expires_at: number }>();
  if (!lock || lock.expires_at < Date.now()) return c.json({ job: null });
  const v = await c.env.DB.prepare('SELECT id, status, payload FROM config_versions WHERE id = ?1').bind(lock.version_id).first<{ id: number; status: string; payload: string }>();
  if (!v || !['validating', 'publishing'].includes(v.status)) return c.json({ job: null });

  /* 🔴 原子占位(2026-09-01 复验 P1-B):此前判「已有步骤记录就不再派发」只挡得住**先后**——
     两个执行器一起启动就是同一个 3 秒节拍,实测两次并发 /next 领到同一单,各干各的。
     改成条件更新:claimed_at 为空才能写进去,同时到达也只有一个能拿到(单语句,不存在读后写的窗口)。 */
  const claim = await c.env.DB
    .prepare('UPDATE publish_lock SET claimed_at=?1, claimed_by=?2 WHERE id=1 AND version_id=?3 AND claimed_at IS NULL RETURNING claim_nonce')
    .bind(Date.now(), c.req.header('user-agent')?.slice(0, 64) ?? 'runner', v.id)
    .first<{ claim_nonce: string | null }>();
  if (!claim) return c.json({ job: null, note: 'already-claimed' });

  return c.json({
    job: { versionId: v.id, config: JSON.parse(v.payload) as SiteConfig, steps: PUBLISH_STEPS, stamp: claim.claim_nonce },
  });
});

/** 执行器回报步骤(running/ok/failed);任一步 failed → 版本 failed + 释放锁,线上保持旧版。
    🔴 三道硬约束(2026-09-01 验收 P0-1/P0-2:此前只校验「版本号是当前锁持有的」,
    于是「发起发布 + 直接报 swap ok」两条请求就能让版本 live,publish_steps 表全空——
    连跑过门的痕迹都没有;过期锁也照收):
      ① 锁必须未过期(与 /next、/status 同判据);
      ② **前序步骤必须都已 ok**(顺序不可跳);
      ③ 报 ok/failed 前该步必须已 running(先声明再收口,防凭空落一步)。 */
publishRoutes.post('/step', async (c) => {
  const b = await c.req.json<{ versionId?: number; step?: PublishStep; status?: string; detail?: string; gate?: string; stamp?: string }>().catch(() => null);
  if (!b?.versionId || !b.step || !PUBLISH_STEPS.includes(b.step) || !['running', 'ok', 'failed'].includes(b.status ?? '')) {
    return c.json({ error: 'bad-request' }, 400);
  }
  const now = Date.now();
  const lock = await c.env.DB
    .prepare('SELECT version_id, expires_at, claim_nonce, claimed_at FROM publish_lock WHERE id = 1')
    .first<{ version_id: number; expires_at: number; claim_nonce: string | null; claimed_at: number | null }>();
  if (!lock || lock.version_id !== b.versionId) return c.json({ error: 'not-current-job' }, 409);
  if (lock.expires_at <= now) return c.json({ error: 'lock-expired(发布已超时,请重新发起)' }, 409); // ①
  /* 上报必须来自**领过单的那个执行器**。此前 /step 与领单完全不绑定:不调 /next 也能一路上报
     (复验 P2)。虽然最后过不了上线核验,但足以占住锁、制造一堆假步骤记录。 */
  if (!lock.claimed_at || !lock.claim_nonce || b.stamp !== lock.claim_nonce) {
    return c.json({ error: 'not-the-claimed-runner(请先领取任务)' }, 409);
  }

  // ② 前序步骤必须全部 ok —— 这是「不存在绕门上线」的实际承载点
  const idx = PUBLISH_STEPS.indexOf(b.step);
  const done = (
    await c.env.DB.prepare("SELECT step FROM publish_steps WHERE version_id=?1 AND status='ok'").bind(b.versionId).all<{ step: string }>()
  ).results.map((r) => r.step);
  const missing = PUBLISH_STEPS.slice(0, idx).filter((s) => !done.includes(s));
  if (missing.length) {
    return c.json({ error: 'step-out-of-order', missing, expected: PUBLISH_STEPS[done.length] ?? null }, 409);
  }
  /* 每一步只许声明一次。此前只挡「重复收口」,于是对已经 ok 的步骤反复报 running 会返 200,
     每报一次还顺手把锁续 15 分钟 —— 一个只会读写自己那一格的调用方就能无限期占住发布位(复验 P2)。 */
  const existing = await c.env.DB.prepare('SELECT status FROM publish_steps WHERE version_id=?1 AND step=?2').bind(b.versionId, b.step).first<{ status: string }>();
  if (b.status === 'running' && existing) return c.json({ error: 'step-already-started', at: existing.status }, 409);
  if (b.status !== 'running' && done.includes(b.step)) return c.json({ error: 'step-already-done' }, 409); // 重复收口

  if (b.status === 'running') {
    await c.env.DB.batch([
      c.env.DB.prepare('INSERT INTO publish_steps (version_id, step, status, started_at) VALUES (?1,?2,?3,?4)').bind(b.versionId, b.step, 'running', now),
      c.env.DB.prepare("UPDATE config_versions SET status='publishing' WHERE id=?1").bind(b.versionId),
      c.env.DB.prepare('UPDATE publish_lock SET expires_at=?2 WHERE id=1').bind(b.versionId, now + LOCK_TTL_MS), // 心跳续锁
    ]);
    return c.json({ ok: true });
  }

  // ③ 该步必须已 running(受影响行数=0 说明没先声明就想收口)
  const upd = await c.env.DB
    .prepare("UPDATE publish_steps SET status=?3, detail=?4, ended_at=?5 WHERE version_id=?1 AND step=?2 AND status='running'")
    .bind(b.versionId, b.step, b.status, b.detail ?? null, now)
    .run();
  if ((upd.meta.changes ?? 0) === 0) return c.json({ error: 'step-not-running(先报 running 再报结果)' }, 409);

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
    /* 🔴 标 live 之前先核实线上快照(见文件上方 STAMP_WHY)。
       印记缺失 / 版本对不上 / 口令对不上 —— 一律拒绝上线并把这一版标 failed。
       fail-closed:读不到也算不通过。宁可让一次真发布因为环境异常而失败(重发即可),
       也不能让一次没搬运过的发布被记成 live —— 那会让数据库说的和线上伺服的静默劈叉。 */
    const stamp = await readLiveStamp(c.env);
    const nonceRow = await c.env.DB.prepare('SELECT claim_nonce FROM publish_lock WHERE id = 1').first<{ claim_nonce: string | null }>();
    const ver = await c.env.DB.prepare('SELECT payload FROM config_versions WHERE id=?1').bind(b.versionId).first<{ payload: string }>();
    const wantSha = ver ? await expectedConfigSha(ver.payload).catch(() => null) : null;
    const good =
      stamp && stamp.versionId === b.versionId && !!nonceRow?.claim_nonce && stamp.stamp === nonceRow.claim_nonce && !!wantSha && stamp.configSha === wantSha;
    if (!good) {
      const why = !stamp
        ? '线上快照里没有本次发布的上线印记(切换步没有真正搬运过产物)'
        : stamp.versionId !== b.versionId
          ? `线上快照的印记指向 v${stamp.versionId},不是本次要上线的 v${b.versionId}`
          : stamp.stamp !== nonceRow?.claim_nonce
            ? '线上快照的印记口令与本次发布不符'
            : `线上快照不是照这一版的配置构建的(内容摘要对不上:期望 ${String(wantSha).slice(0, 12)}…,实际 ${String(stamp.configSha ?? '缺失').slice(0, 12)}…)`;
      await c.env.DB.batch([
        c.env.DB.prepare("UPDATE config_versions SET status='failed', fail_reason=?2 WHERE id=?1").bind(b.versionId, `上线核验未通过:${why}`),
        c.env.DB.prepare("UPDATE publish_steps SET status='failed', detail=?3 WHERE version_id=?1 AND step=?2").bind(b.versionId, 'swap', why),
        c.env.DB.prepare('DELETE FROM publish_lock WHERE id = 1'),
      ]);
      await writeAudit(c.env.DB, { action: 'config.publish.failed', target: `v${b.versionId}`, after: `上线核验未通过:${why}` });
      return c.json({ error: 'live-verification-failed', why }, 409);
    }
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

/** 版本列表 + 当前发布进度(UI 轮询用)。
    🔴 读时自愈:锁已过期(或根本没锁)却还挂在 validating/publishing 的版本,一律标 failed——
    否则执行器中途死掉后,界面会一直显示「正在发布」直到下一次有人发起发布才被顺手清理,
    那是「看起来在跑、其实早死了」的假状态(实测:执行器被开发服务器重启掐断后即如此)。 */
publishRoutes.get('/status', async (c) => {
  const lock = await c.env.DB.prepare('SELECT version_id, expires_at FROM publish_lock WHERE id = 1').first<{ version_id: number; expires_at: number }>();
  const now = Date.now();
  const active = lock && lock.expires_at > now ? lock.version_id : null;
  await c.env.DB
    .prepare(
      `UPDATE config_versions SET status='failed',
         fail_reason=COALESCE(fail_reason,'发布中断(执行器无响应或超时),线上保持旧版')
       WHERE status IN ('validating','publishing') AND id <> COALESCE(?1, -1)`,
    )
    .bind(active)
    .run();
  if (!active && lock) await releaseLock(c.env); // 顺手清掉过期锁
  /* 步骤日志:进行中看当前版本;没有进行中时回**最近一次**的步骤日志——
     否则失败态下「查看原始日志」永远没有数据可渲染(验收 P1:日志存了却取不回)。 */
  const stepsOf = active ?? (await c.env.DB.prepare('SELECT version_id FROM publish_steps ORDER BY id DESC LIMIT 1').first<{ version_id: number }>())?.version_id ?? null;
  const steps = stepsOf
    ? (await c.env.DB.prepare('SELECT version_id, step, status, detail, started_at, ended_at FROM publish_steps WHERE version_id=?1 ORDER BY id').bind(stepsOf).all()).results
    : [];
  const versions = (
    await c.env.DB
      .prepare('SELECT id, status, reason, fail_reason, created_by, created_at, published_at FROM config_versions ORDER BY id DESC LIMIT 30')
      .all<{ id: number; status: string; reason: string | null; fail_reason: string | null; created_by: string; created_at: number; published_at: number | null }>()
  ).results;
  /* 🔴 劈叉自查(2026-09-01 复验 P1-3):切换脚本先落盘、再回报,所以「盘上已经换了、回报没送到」
     是一个不需要攻击者就会发生的形态(执行器死在这一拍即可)。此前没有任何一处会发现它——
     界面说「线上保持旧版」,而站上早就是新内容了。现在每次读状态都拿线上快照的印记与
     数据库记的 live 对一次,不一致就明说,让人能看见并重发一次把两边对齐。 */
  const drift = await liveSnapshotDrift(c.env).catch(() => null);
  return c.json({ activeVersion: active, stepsOfVersion: stepsOf, steps, versions, stepNames: PUBLISH_STEPS, drift });
});

/** 执行器失联判据:最后一次步骤动静距今超过这个时长,就当它已经死了。
    实测门链单步最长 343-361 秒,原定 8 分钟只剩两分钟余量——过线后会在执行器健康时劝人掐掉正在跑的发布(复验 P2)。
    改 12 分钟:仍小于 15 分钟的锁 TTL,不会出现「劝不动又等不到」的空档。 */
const RUNNER_SILENT_MS = 12 * 60_000;

/* 取消发布(CON13-E4:执行器不在线时不吊死)。两档:
   ① 排队态(一步都没开始)—— 直接取消,任何时候都行;
   ② 已开工但执行器失联 —— 需要显式 `force:true` + 理由,记审计。

   🔴 为什么要加第二档(2026-09-01 复验 P1-A):上一轮我把「/next 不再派发已领取的单」和
   「任何步骤开始即不可取消」两条**分别**改对了,合起来却造出一个新故障:执行器崩在半路时,
   领不到、取消不了、重发也 409,只能干等 15 分钟锁超时,期间每试一次还多留一行垃圾失败版本;
   而 README 上写着「执行器重启会自动接管」——那句话被这两条修法一起变成了假话。
   两个各自正确的修法合起来造出新缺陷,是「只看单条修法」看不出来的,必须留出人工出口。 */
publishRoutes.post('/cancel', async (c) => {
  const body = await c.req.json<{ force?: boolean; reason?: string }>().catch(() => null);
  const lock = await c.env.DB.prepare('SELECT version_id FROM publish_lock WHERE id = 1').first<{ version_id: number }>();
  if (!lock) return c.json({ error: 'no-active-publish' }, 409);
  const last = await c.env.DB
    .prepare('SELECT MAX(COALESCE(ended_at, started_at)) AS t, COUNT(*) AS n FROM publish_steps WHERE version_id=?1')
    .bind(lock.version_id)
    .first<{ t: number | null; n: number }>();
  const started = (last?.n ?? 0) > 0;
  const silentMs = last?.t ? Date.now() - last.t : 0;

  if (started) {
    if (!body?.force) {
      return c.json(
        {
          error: 'already-running',
          canForce: silentMs >= RUNNER_SILENT_MS,
          silentMs,
          hint:
            silentMs >= RUNNER_SILENT_MS
              ? '执行器已超过 8 分钟没有动静,可带 force 与理由强制中止'
              : '执行器仍在工作(最近有步骤动静),中止会留下没人收口的中间态',
        },
        409,
      );
    }
    if (silentMs < RUNNER_SILENT_MS) return c.json({ error: 'runner-still-alive', silentMs }, 409);
    if (!body.reason?.trim()) return c.json({ error: 'reason-required(强制中止必须写明理由)' }, 400);
  }

  const why = started ? `强制中止(执行器失联 ${Math.round(silentMs / 60_000)} 分钟):${body!.reason!.trim()}` : '已取消(执行器未上线)';
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE config_versions SET status='failed', fail_reason=?2 WHERE id=?1").bind(lock.version_id, why),
    c.env.DB.prepare("UPDATE publish_steps SET status='failed', detail=?2, ended_at=?3 WHERE version_id=?1 AND status='running'").bind(lock.version_id, why, Date.now()),
    c.env.DB.prepare('DELETE FROM publish_lock WHERE id = 1'),
  ]);
  await writeAudit(c.env.DB, { action: 'config.publish.cancel', target: `v${lock.version_id}`, after: why, reason: body?.reason?.trim() });
  return c.json({ ok: true, forced: !!started });
});
