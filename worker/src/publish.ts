import { Hono } from 'hono';
import { LOCALES, SiteConfigSchema, diffPaths, materializeI18n, materializeSiteJson, sensitivePaths, validateConfig, type CopyManifest, type SiteConfig } from '../../schema/src/index.js';
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
  await env.DB.batch([
    env.DB.prepare('INSERT INTO publish_lock (id, version_id, acquired_at, expires_at, claim_nonce) VALUES (1, ?1, ?2, ?3, ?4)').bind(versionId, now, now + LOCK_TTL_MS, nonce),
    // 口令同时记在版本行上:锁会被释放,版本不会(见 0007 迁移的说明)
    env.DB.prepare('UPDATE config_versions SET claim_nonce=?2 WHERE id=?1').bind(versionId, nonce),
  ]);
  return { ok: true, nonce };
}
const releaseLock = (env: Env) => env.DB.prepare('DELETE FROM publish_lock WHERE id = 1').run();

interface LiveStamp {
  versionId?: number;
  stamp?: string;
  configSha?: string;
  /** 搬运那一刻几个关键文件的内容摘要(抽查用,见 verifyAnchors) */
  anchors?: Record<string, string>;
}

/** 读线上快照的上线印记。读不到 / 读不动都返回 null —— 由调用方判成「不许上线」(fail-closed)。 */
async function readLiveStamp(env: Env): Promise<LiveStamp | null> {
  try {
    const res = await env.ASSETS.fetch(new Request(`https://assets.internal${STAMP_PATH}`, { method: 'GET' }));
    if (!res.ok) return null;
    return (await res.json()) as LiveStamp;
  } catch {
    return null;
  }
}

const sha256Hex = async (buf: ArrayBuffer): Promise<string> =>
  Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', buf)), (b) => b.toString(16).padStart(2, '0')).join('');

/* 拿印记里的锚点摘要**回核实物**:线上现在伺服的这几个文件,还是搬运那一刻的内容吗?
   🔴 为什么需要(2026-09-01 第五轮 P1-4):印记只带版本号时,「有人直接改了线上快照」报不出来——
   劈叉自查比的是版本号,而版本号不会因为文件被改而变。服务端读得到自己伺服的内容,那就该真去读。
   ⚠️ 明确边界:**抽查不是全量**。只覆盖 promote 记下的那几个锚点,动了别的资产仍看不见;
   全量遍历整个快照的代价与收益不成比例。锚点选的是「改了就一定影响访客看到什么」的那几个。
   返回:null = 没有锚点可核(旧印记 / 无印记);[] = 全部一致;非空 = 对不上的那些路径。 */
async function verifyAnchors(env: Env, stamp: LiveStamp | null): Promise<string[] | null> {
  const anchors = stamp?.anchors;
  if (!anchors || Object.keys(anchors).length === 0) return null;
  const bad: string[] = [];
  for (const [p, want] of Object.entries(anchors)) {
    try {
      const res = await env.ASSETS.fetch(new Request(`https://assets.internal${p}`, { method: 'GET' }));
      if (!res.ok) {
        bad.push(`${p}(取不到,HTTP ${res.status})`);
        continue;
      }
      if ((await sha256Hex(await res.arrayBuffer())) !== want) bad.push(p);
    } catch {
      bad.push(`${p}(读取失败)`);
    }
  }
  return bad;
}

/* 这一版的配置**该**物化成什么样 —— 服务端自己算,不问执行器(见 STAMP_WHY 第二段)。
   🔴 必须覆盖**全部消费物**,不只是 site.json(2026-09-01 第四轮 P1-3):
   第一版只哈希了 site.json,而文案 / FAQ / Legal 全部物化进 i18n 三份文件、根本不进 site.json——
   于是「只改文案」这个**后台最常见的改动**摘要完全不变,那道核验对它等于不存在(实测可零门上线)。
   一个只覆盖了少数字段的「内容核验」比没有更糟:它让人以为已经验过了。
   物化面 = i18n 三语 + site.json,与执行器写盘的那四个文件一一对应。 */
const MATERIALIZED_FILES = ['src/i18n/en.json', 'src/i18n/vi.json', 'src/i18n/zh.json', 'src/config/site.json'] as const;
async function expectedConfigSha(payload: string): Promise<string> {
  const cfg = SiteConfigSchema.parse(JSON.parse(payload));
  const parts = [
    ...LOCALES.map((loc) => materializeI18n(cfg, MANIFEST, loc)),
    materializeSiteJson(cfg),
  ];
  // 与 promote.mjs 同一拼接口径:路径 + NUL + 内容,顺序即 MATERIALIZED_FILES
  const joined = MATERIALIZED_FILES.map((f, i) => `${f}\0${parts[i]}`).join('\0');
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(joined));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** 线上快照实际是哪一版(据印记);与数据库记的 live 不一致 = 劈叉,必须让人看见 */
export async function liveSnapshotDrift(env: Env): Promise<{ dbLive: number; snapshot: number | null; tampered?: string[] } | null> {
  const [stamp, live] = await Promise.all([readLiveStamp(env), getLive(env)]);
  if (!live) return null;
  const snapVer = stamp?.versionId ?? null;
  if (snapVer === live.id) {
    /* 版本号对上了还不够:内容也可能被直接动过(第五轮 P1-4)。拿锚点摘要回核实物。 */
    const bad = await verifyAnchors(env, stamp);
    return bad && bad.length ? { dbLive: live.id, snapshot: snapVer, tampered: bad } : null;
  }
  /* 全新环境豁免:线上那一版是**初始种子**(= 上线前手工构建的站内容,从没走过流水线),
     快照自然没有上线印记。此时报劈叉是永久噪音,而永久红条只会训练人忽略红条。
     一旦真发布过一次,种子就不再是 live,这条豁免自动失效。 */
  if (snapVer === null) {
    const seed = await env.DB.prepare("SELECT created_by FROM config_versions WHERE id=?1").bind(live.id).first<{ created_by: string }>();
    if (seed?.created_by === 'system') return null;
  }
  return { dbLive: live.id, snapshot: snapVer };
}

/* 终态该带来的效果,做成**可重放**的一段:失败 → 版本 failed + 释放锁;swap 成功 → 核验后上线。
   🔴 为什么必须可重放(2026-09-01 第六轮 P1-1,第五次组合故障):
   幂等要保证的是**结果**,不是「记过一笔」。上一版对重复上报直接 return,于是 `swap ok` 的响应
   一旦在回程丢失,执行器重发时被当成「已经记过了」而**整个上线事务被跳过**——
   内容其实已经在线上,版本却永远不会被标 live,也不能重发;15 分钟后运营看到
   「执行器无响应」+「线上仍是上一版,未受影响」,**两句都是假话**。
   🔴 正常路径与重放路径**共用这一段**,不写两份:两份实现必然漂移,而漂移的那一天没人会发现。
   每条写操作都带条件(`WHERE status=...`),重复执行不会叠加副作用。 */
async function ensureTerminalEffect(
  env: Env,
  versionId: number,
  step: PublishStep,
  status: 'ok' | 'failed',
  gate: string | undefined,
  detail: string | undefined,
  now: number,
): Promise<{ ok: true; applied: boolean; reason?: string } | { ok: false; error: string; why: string }> {
  if (status === 'failed') {
    const reason = gate ? `${explainGate(gate)}(门:${gate})` : (detail ?? '执行器报告失败');
    const r = await env.DB.batch([
      env.DB.prepare("UPDATE config_versions SET status='failed', fail_reason=COALESCE(fail_reason, ?2) WHERE id=?1 AND status IN ('validating','publishing')").bind(versionId, reason),
      env.DB.prepare('DELETE FROM publish_lock WHERE id = 1 AND version_id = ?1').bind(versionId),
    ]);
    const applied = (r[0]?.meta?.changes ?? 0) > 0;
    if (applied) await writeAudit(env.DB, { action: 'config.publish.failed', target: `v${versionId}`, after: reason });
    return { ok: true, applied, reason };
  }

  if (step !== 'swap') return { ok: true, applied: false }; // 非最后一步的成功没有额外副作用

  const target = await env.DB.prepare('SELECT id, status, payload FROM config_versions WHERE id=?1').bind(versionId).first<{ id: number; status: string; payload: string }>();
  if (!target) return { ok: false, error: 'version-not-found', why: `v${versionId} 不存在` };
  if (target.status === 'live') return { ok: true, applied: false }; // 已经上线:重放收敛到同一终态

  /* 标 live 之前先核实线上快照(见文件上方 STAMP_WHY)。fail-closed:核不过就不上线。
     🔴 但要把「读不到」与「对不上」分开(第六轮 P1-5):资产层那一瞬读不到不等于有人动了文件,
     此前一律说成「有人绕过发布流程直接改了线上文件」,既是错诊断又不可重试。 */
  const stamp = await readLiveStamp(env);
  /* 口令从**版本行**读,不从锁读(2026-09-01 第六轮,192 格表抓出)。
     终态回报会删锁,所以在「回报丢了→重发」这个真实形态里,锁已经不在了;
     从锁读会让重放必然核验失败。口令属于「这一次发布」,载体是版本行,不是那把会被释放的锁。 */
  const nonceRow = await env.DB.prepare('SELECT claim_nonce FROM config_versions WHERE id=?1').bind(versionId).first<{ claim_nonce: string | null }>();
  const wantSha = await expectedConfigSha(target.payload).catch(() => null);
  const badAnchors = await verifyAnchors(env, stamp);
  const unreadable = (badAnchors ?? []).filter((x) => x.includes('取不到') || x.includes('读取失败'));
  if (unreadable.length) {
    // 环境问题,不改版本状态、不释放锁 → 执行器重试即可继续
    return { ok: false, error: 'live-check-unavailable', why: `暂时读不到线上快照(${unreadable.join('、')}),稍后重试;本次发布未判失败` };
  }
  const good =
    stamp && stamp.versionId === versionId && !!nonceRow?.claim_nonce && stamp.stamp === nonceRow.claim_nonce && !!wantSha && stamp.configSha === wantSha
    && !(badAnchors && badAnchors.length);
  if (!good) {
    const why = !stamp
      ? '线上快照里没有本次发布的上线印记(切换步没有真正搬运过产物)'
      : stamp.versionId !== versionId
        ? `线上快照的印记指向 v${stamp.versionId},不是本次要上线的 v${versionId}`
        : stamp.stamp !== nonceRow?.claim_nonce
          ? '线上快照的印记口令与本次发布不符'
          : stamp.configSha !== wantSha
            ? `线上快照不是照这一版的配置构建的(内容摘要对不上:期望 ${String(wantSha).slice(0, 12)}…,实际 ${String(stamp.configSha ?? '缺失').slice(0, 12)}…)`
            : `线上快照里这些文件已被改动过,与搬运时不符:${(badAnchors ?? []).join('、')}`;
    await env.DB.batch([
      env.DB.prepare("UPDATE config_versions SET status='failed', fail_reason=?2 WHERE id=?1").bind(versionId, `上线核验未通过:${why}`),
      env.DB.prepare("UPDATE publish_steps SET status='failed', detail=?3 WHERE version_id=?1 AND step=?2").bind(versionId, 'swap', why),
      env.DB.prepare('DELETE FROM publish_lock WHERE id = 1'),
    ]);
    await writeAudit(env.DB, { action: 'config.publish.failed', target: `v${versionId}`, after: `上线核验未通过:${why}` });
    return { ok: false, error: 'live-verification-failed', why };
  }

  const live = await getLive(env);
  const stmts = [
    env.DB.prepare("UPDATE config_versions SET status='live', published_at=?2 WHERE id=?1").bind(versionId, now),
    env.DB.prepare('DELETE FROM publish_lock WHERE id = 1'),
  ];
  if (live) stmts.unshift(env.DB.prepare("UPDATE config_versions SET status='archived' WHERE id=?1").bind(live.id));
  await env.DB.batch(stmts);
  await writeAudit(env.DB, { action: 'config.publish.live', target: `v${versionId}`, before: live ? `v${live.id}` : 'none' });
  return { ok: true, applied: true };
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
    /* 只能回滚到**真上线过**的版本(live / archived)。此前不限状态,于是一个门红过、从未上线的版本
       也能当回滚源——它仍走完整门链所以不算绕门,但「回滚」这个词在说假话:回到一个从没存在过的线上态。 */
    const src = await c.env.DB
      .prepare("SELECT id, payload, status FROM config_versions WHERE id = ?1 AND status IN ('live','archived')")
      .bind(body.fromVersion)
      .first<{ id: number; payload: string }>();
    if (!src) return c.json({ error: 'version-not-rollbackable(只能回滚到曾经上线过的版本)' }, 404);
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
    // 不留版本行,但要留审计:否则「谁在什么时候试图发布过、被并发挡了」在系统里查不到(第四轮 P2-4)
    await writeAudit(c.env.DB, { action: 'config.publish.rejected', target: `v${lock.heldBy} 正在发布`, after: '并发发布被拒,未建版本', reason: body?.reason?.trim() });
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

  /* ══════════ 第一层:幂等与转移合法性(与锁无关) ══════════
     🔴 结构性改动(2026-09-01 第五轮后,见 `docs/changes/2026-09-01-publish-step-structural-reflection.md`)。
     此前六道校验是四轮里一条条累加出来的**否决清单**,按固定顺序求值,而「幂等」排在最后一条——
     在锁归属之后。可每个**终态**回报都会先删锁,于是终态回报的重发**根本走不到幂等**,
     必然撞上 `not-current-job`;而「响应会丢」在当前配置下恰好只发生在 swap 那一拍
     (伺服目录是 dist-live,唯一写它的就是切换步,写入触发开发服务器重载)。
     结果:**一次完全成功的发布把常驻执行器打死了**。这是同一形态的第四次组合故障。

     根治不是再加一个 if,是把判断收成两层:
     **「这条回报有没有被记下」是一个关于记录的事实,与锁还在不在、谁持锁完全无关**——
     终态删锁不该让「我上次到底成功了没」变得无法回答。
     只有真的要**改变状态**时才需要授权;重发一条已经生效的回报不改变任何状态,不需要授权。
     转移表穷举 4(已记录)×3(本次上报)格,测试逐格断言,不抽样。 */
  const existing = await c.env.DB.prepare('SELECT status FROM publish_steps WHERE version_id=?1 AND step=?2').bind(b.versionId, b.step).first<{ status: string }>();
  const recorded = existing?.status ?? 'none';
  if (recorded === b.status) {
    /* 🔴 幂等要保证的是**结果**,不是「记过一笔」(2026-09-01 第六轮 P1-1,第五次组合故障)。
       上一版这里直接 return —— 于是 `swap ok` 的响应一旦在回程丢失,执行器重发时被当作
       「已经记过了」而**整个上线事务被跳过**:内容其实已经在线上,版本却永远不会被标 live,
       也不能重发;15 分钟后运营看到「执行器无响应」+「线上仍是上一版,未受影响」——**两句都是假话**。
       根因是我把一个**有副作用的事务的触发器**,当成了「记一笔事实」来做幂等。
       正确的幂等:重放要让系统**收敛到同一个终态**,该发生的副作用如果还没发生,就补上。
       所以这里只跳过「重复写步骤行」,终态该带来的效果仍然照走(下面 ensureTerminalEffect)。 */
    if (b.status === 'running') return c.json({ ok: true, idempotent: true }); // 非终态无副作用,直接受理
    const eff = await ensureTerminalEffect(c.env, b.versionId, b.step, b.status as 'ok' | 'failed', b.gate, b.detail, now);
    return eff.ok ? c.json({ ok: true, idempotent: true, effectEnsured: eff.applied }) : c.json({ error: eff.error, why: eff.why }, 409);
  }
  if (recorded === 'ok' || recorded === 'failed') {
    // 已收口的步骤不许改口(ok→failed / failed→ok / 终态→running 都在这里)
    return c.json({ error: 'step-already-done', recorded }, 409);
  }
  if (recorded === 'running' && b.status === 'running') {
    return c.json({ error: 'step-already-started', at: recorded }, 409); // 理论上被上面的幂等接住,留作兜底
  }

  /* ══════════ 第二层:授权与时序(仅当确实要写入时才求值) ══════════ */
  const lock = await c.env.DB
    .prepare('SELECT version_id, expires_at, claim_nonce, claimed_at FROM publish_lock WHERE id = 1')
    .first<{ version_id: number; expires_at: number; claim_nonce: string | null; claimed_at: number | null }>();
  if (!lock || lock.version_id !== b.versionId) return c.json({ error: 'not-current-job' }, 409);
  if (lock.expires_at <= now) return c.json({ error: 'lock-expired(发布已超时,请重新发起)' }, 409);
  /* 上报必须来自**领过单的那个执行器**:不领单也能一路上报的话,足以占住锁、制造一堆假步骤记录。 */
  if (!lock.claimed_at || !lock.claim_nonce || b.stamp !== lock.claim_nonce) {
    return c.json({ error: 'not-the-claimed-runner(请先领取任务)' }, 409);
  }
  // 前序步骤必须全部 ok —— 这是「不存在绕门上线」的实际承载点
  const idx = PUBLISH_STEPS.indexOf(b.step);
  const done = (
    await c.env.DB.prepare("SELECT step FROM publish_steps WHERE version_id=?1 AND status='ok'").bind(b.versionId).all<{ step: string }>()
  ).results.map((r) => r.step);
  const missing = PUBLISH_STEPS.slice(0, idx).filter((s) => !done.includes(s));
  if (missing.length) {
    return c.json({ error: 'step-out-of-order', missing, expected: PUBLISH_STEPS[done.length] ?? null }, 409);
  }
  if (b.status !== 'running' && recorded !== 'running') {
    return c.json({ error: 'step-not-running(先报 running 再报结果)' }, 409);
  }

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

  const eff = await ensureTerminalEffect(c.env, b.versionId, b.step, b.status as 'ok' | 'failed', b.gate, b.detail, now);
  if (!eff.ok) return c.json({ error: eff.error, why: eff.why }, 409);
  return c.json({ ok: true, ...(b.status === 'failed' ? { failed: true, reason: eff.reason } : {}) });
});

/** 版本列表 + 当前发布进度(UI 轮询用)。
    🔴 读时自愈:锁已过期(或根本没锁)却还挂在 validating/publishing 的版本,一律标 failed——
    否则执行器中途死掉后,界面会一直显示「正在发布」直到下一次有人发起发布才被顺手清理,
    那是「看起来在跑、其实早死了」的假状态(实测:执行器被开发服务器重启掐断后即如此)。 */
publishRoutes.get('/status', async (c) => {
  const lock = await c.env.DB.prepare('SELECT version_id, expires_at FROM publish_lock WHERE id = 1').first<{ version_id: number; expires_at: number }>();
  const now = Date.now();
  const active = lock && lock.expires_at > now ? lock.version_id : null;
  /* 自愈也要留痕、也要收口(第四轮 P2-5)。此前:标了 failed 却**不写审计**,
     且把步骤永远留在 running —— 版本说「失败」、步骤说「进行中」,两边自相矛盾,
     事后翻记录的人无从判断到底发生了什么。取消那条路径是会收口步骤的,自愈这条不会,
     同一件事两条路径两种处理,就是漏的来源。 */
  const stale = (
    await c.env.DB
      .prepare("SELECT id FROM config_versions WHERE status IN ('validating','publishing') AND id <> COALESCE(?1, -1)")
      .bind(active)
      .all<{ id: number }>()
  ).results;
  if (stale.length) {
    const reason = '发布中断(执行器无响应或超时),线上保持旧版';
    await c.env.DB.batch([
      c.env.DB.prepare(
        `UPDATE config_versions SET status='failed', fail_reason=COALESCE(fail_reason, ?1)
           WHERE status IN ('validating','publishing') AND id <> COALESCE(?2, -1)`,
      ).bind(reason, active),
      c.env.DB.prepare(
        `UPDATE publish_steps SET status='failed', detail=COALESCE(detail, ?1), ended_at=?2
           WHERE status='running' AND version_id IN (SELECT id FROM config_versions WHERE status='failed' AND fail_reason=?1)`,
      ).bind(reason, now),
    ]);
    for (const v of stale) {
      await writeAudit(c.env.DB, { action: 'config.publish.failed', target: `v${v.id}`, after: reason });
    }
  }
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
              ? '执行器已超过 12 分钟没有动静,可带 force 与理由强制中止'
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
    /* 🔴 取消记 'cancelled' 不记 'failed'(2026-09-01 第四轮 P1-5):按 PRD E4 正常取消一次,
       就会换来一条「上次发布失败」的红条常驻全站、只有下一次成功发布能清掉。
       取消是运营的主动决定,不是故障——把它记成故障,红条就在说假话。 */
    c.env.DB.prepare("UPDATE config_versions SET status='cancelled', fail_reason=?2 WHERE id=?1").bind(lock.version_id, why),
    c.env.DB.prepare("UPDATE publish_steps SET status='failed', detail=?2, ended_at=?3 WHERE version_id=?1 AND status='running'").bind(lock.version_id, why, Date.now()),
    c.env.DB.prepare('DELETE FROM publish_lock WHERE id = 1'),
  ]);
  await writeAudit(c.env.DB, { action: 'config.publish.cancel', target: `v${lock.version_id}`, after: why, reason: body?.reason?.trim() });
  return c.json({ ok: true, forced: !!started });
});
