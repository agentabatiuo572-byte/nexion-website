import { Hono } from 'hono';
import { LOCALES, MATERIALIZED_FILES, SiteConfigSchema, addLegacyLocaleFields, classifyChangedPaths, diffPaths, materializeI18n, materializeSiteJson, sensitivePaths, validateConfig, type CopyManifest, type PublishChangeTier, type SiteConfig } from '../../schema/src/index.js';
import manifestJson from '../seed/copy-manifest.json';
import type { Env } from './env';
import { prepareAuditAfterPreviousChange, writeAudit, type AuditEntry } from './audit';
import { ensureInit } from './config';
import { adaptLegacyConfig, ensureDraftUpgrade, validateUpgradeResolution } from './config-upgrade';
import { executorState, dispatchPending, RUNNER_ID } from './publish-executor';
import { translationFreshness } from './translation-state';

/* 发布流水线(PRD CON13)。核心承诺:**不存在绕门发布的路径**——
   上新只经本文件的状态机,而状态机必然经过「前置校验 → 物化 → 站上全部机器门 → 构建 → 原子切换」。
   门红 → 版本标 failed、线上保持旧版、草稿原样保留(改动不丢)。回滚 = 以旧版内容发起新发布,同样走完整门链。
   执行器(materialize/gates/build/swap 的真正执行方)在 worker 之外:
   V1-dev = 本机脚本 runner,Phase C = CI runner,同一 §5.4 契约,worker 只做编排与状态机。 */

const MANIFEST = manifestJson as unknown as CopyManifest;
const LOCK_TTL_MS = 15 * 60_000;
/** 执行器失联判据:最长门链仍要留余量，同时必须短于租约。 */
const RUNNER_SILENT_MS = 12 * 60_000;
const UNKNOWN_DETAIL = '切换结果待核实，系统会继续核对已发布内容；核实前暂停新发布。';
const UNKNOWN_REASON = '恢复阶段无法确认线上快照与本次发布一致';
export const PUBLISH_STEPS = ['materialize', 'gates', 'build', 'swap'] as const;
export type PublishStep = (typeof PUBLISH_STEPS)[number];

/** 门名 → 大白话(CON13-③;缺映射时显门名原文,绝不隐藏) */
export const GATE_REASONS: Record<string, string> = {
  'forbidden-words': '文案里有合规禁用词',
  'i18n-parity': '各语言文案对不齐(有缺译或多余的键)',
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
  'console-copy': '控制台界面文案有问题(markdown 记号会原样印出 / 机器状态词直出给人看)',
};
export const explainGate = (name: string): string => GATE_REASONS[name] ?? name;

interface LockRow { id: number; version_id: number; expires_at: number; claim_nonce: string | null; claimed_at: number | null }
interface RecoveryClaim { observedAt: number }

/** 超时恢复必须在最终事务里重新确认：没有任何锁，或本版本的任务租约仍然过期。
 * publish_runner 只证明进程在线；空闲心跳没有版本/口令，不能替某个旧任务续命。 */
const recoveryGuard = (observedAt: string) => `(
  ${observedAt} IS NULL
  OR NOT EXISTS(SELECT 1 FROM publish_lock)
  OR EXISTS(
    SELECT 1 FROM publish_lock l
    WHERE l.id=1 AND l.version_id=?1 AND l.expires_at<=${observedAt}
  )
)`;

const recoveryTime = (claim?: RecoveryClaim): number | null => claim?.observedAt ?? null;

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

type PublicationSource = { kind: 'draft'; draftRev: number } | { kind: 'snapshot'; payload: string };
type CreatePublicationResult =
  | { ok: true; versionId: number }
  | { ok: false; error: 'blocked'; heldBy: number | null }
  | { ok: false; error: 'draft-changed'; draftRev: number };

/** 旧锁先恢复；确认的草稿快照、新版本、锁、派发记录和审计只在同一事务中出现。 */
async function createPublication(env: Env, source: PublicationSource, reason: string | null, audit: AuditEntry): Promise<CreatePublicationResult> {
  const uncertain = await env.DB.prepare("SELECT id FROM config_versions WHERE status='unknown' LIMIT 1").first<{id:number}>();
  if (uncertain) return {ok:false,error:'blocked',heldBy:uncertain.id};
  const observedAt = Date.now();
  const cur = await env.DB.prepare('SELECT id, version_id, expires_at, claim_nonce, claimed_at FROM publish_lock WHERE id = 1').first<LockRow>();
  if (cur && cur.expires_at > observedAt) return { ok: false, error:'blocked', heldBy: cur.version_id };
  if (cur) {
    const recovery = await recoverInterrupted(env,cur.version_id,'发布超时，草稿已保留，可重新发布。',{observedAt});
    if (!recovery.terminal || ('unknown' in recovery && recovery.unknown)) return {ok:false,error:'blocked',heldBy:cur.version_id};
    await releaseExpiredTerminalLock(env,cur.version_id,observedAt);
  }
  const nonce = randomHex(16);
  const now = Date.now();
  const insertVersion = source.kind === 'draft'
    ? env.DB.prepare(`INSERT INTO config_versions (status, payload, reason, created_by, created_at, claim_nonce, source_draft_rev)
        SELECT 'validating',d.payload,?1,'admin',?2,?3,d.draft_rev FROM config_draft d
        WHERE d.id=1 AND d.draft_rev=?4
          AND NOT EXISTS(SELECT 1 FROM publish_lock)
          AND NOT EXISTS(SELECT 1 FROM config_versions WHERE status='unknown' OR claim_nonce=?3)
        RETURNING id`).bind(reason,now,nonce,source.draftRev)
    : env.DB.prepare(`INSERT INTO config_versions (status, payload, reason, created_by, created_at, claim_nonce)
        SELECT 'validating',?1,?2,'admin',?3,?4
        WHERE NOT EXISTS(SELECT 1 FROM publish_lock)
          AND NOT EXISTS(SELECT 1 FROM config_versions WHERE status='unknown' OR claim_nonce=?4)
        RETURNING id`).bind(source.payload,reason,now,nonce);
  const auditValues = [now, audit.actor ?? 'admin', audit.action, audit.before ?? null, audit.after ?? null, audit.reason ?? null, nonce];
  const committed = await env.DB.batch([
    insertVersion,
    // changes() 仅承接本事务前一句的真实插入；新 id 从 nonce 定位，绝不复用连接上的历史 last_insert_rowid。
    env.DB.prepare(`INSERT INTO publish_lock (id,version_id,acquired_at,expires_at,claim_nonce)
      SELECT 1,id,?2,?3,claim_nonce FROM config_versions WHERE claim_nonce=?1 AND changes()=1`).bind(nonce,now,now+LOCK_TTL_MS),
    ...(env.PUBLISH_EXECUTION_MODE==='github' ? [env.DB.prepare(`INSERT INTO publish_dispatch(version_id,next_attempt_at)
      SELECT version_id,?2 FROM publish_lock WHERE claim_nonce=?1 AND changes()=1`).bind(nonce,now)] : []),
    env.DB.prepare(`INSERT INTO audit (ts,actor,action,target,before_summary,after_summary,reason)
      SELECT ?1,?2,?3,'v'||v.id,?4,?5,?6 FROM config_versions v JOIN publish_lock l ON l.version_id=v.id
      WHERE v.claim_nonce=?7 AND l.claim_nonce=?7`).bind(...auditValues),
  ]);
  const version = committed[0]?.results?.[0] as {id:number} | undefined;
  if (!version) {
    const held = await env.DB.prepare('SELECT version_id FROM publish_lock WHERE id=1').first<{version_id:number}>();
    const blocked = held ? null : await env.DB.prepare("SELECT id FROM config_versions WHERE status='unknown' LIMIT 1").first<{id:number}>();
    if (held || blocked) return {ok:false,error:'blocked',heldBy:held?.version_id ?? blocked?.id ?? null};
    if (source.kind === 'draft') {
      const current = await env.DB.prepare('SELECT draft_rev FROM config_draft WHERE id=1').first<{draft_rev:number}>();
      return {ok:false,error:'draft-changed',draftRev:current?.draft_rev ?? source.draftRev};
    }
    return {ok:false,error:'blocked',heldBy:null};
  }
  return { ok: true, versionId: version.id };
}
/* 🔴 释放锁一律**按版本、观察到的过期时间和版本终态限定**:`publish_lock` 是单例表(id=1),
   无条件 `DELETE WHERE id=1` 的语义是「把当下那把锁删掉,不管它属于谁」。
   在并发下这就是「我以为我在清自己那把过期锁,实际清掉了别人刚建的新锁」。
   调用方手上都拿着 version_id,不传是白白丢掉一层保护。 */
const releaseExpiredTerminalLock = (env: Env, versionId: number, observedAt: number) =>
  env.DB.prepare(`DELETE FROM publish_lock WHERE id=1 AND version_id=?1 AND expires_at<=?2
    AND NOT EXISTS(SELECT 1 FROM config_versions WHERE id=?1 AND status IN ('validating','publishing','unknown'))`)
    .bind(versionId,observedAt).run();

/** 某个任务的最后活性只能来自版本绑定事件：领取、步骤、或带版本+口令的租约续期。
 * expires_at 每次任务心跳都会写成 now+LOCK_TTL_MS，因此可无损还原该次续期时间。 */
async function lastJobActivity(env: Env, versionId: number, fallback: number | null) {
  const lease = await env.DB.prepare('SELECT claimed_at,expires_at FROM publish_lock WHERE version_id=?1')
    .bind(versionId).first<{claimed_at:number | null;expires_at:number}>();
  const renewedAt = lease ? lease.expires_at - LOCK_TTL_MS : 0;
  return Math.max(fallback ?? 0, lease?.claimed_at ?? 0, renewedAt);
}

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
   物化面 = 全部 i18n 语言 + site.json,与执行器写盘的共享清单一一对应。 */
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
  recovering = false,
  recoveryClaim?: RecoveryClaim,
  auditActor?: AuditEntry['actor'],
): Promise<{ ok: true; applied: boolean; reason?: string } | { ok: false; error: string; why: string }> {
  if (status === 'failed') {
    const reason = gate ? `${explainGate(gate)}(门:${gate})` : (detail ?? '执行器报告失败');
    const applied = await commitPublishFailure(env, versionId, reason, now, detail ?? reason, false, recoveryClaim, auditActor);
    return { ok: true, applied, reason };
  }

  if (step !== 'swap') return { ok: true, applied: false }; // 非最后一步的成功没有额外副作用

  const target = await env.DB.prepare('SELECT id, status, payload, claim_nonce FROM config_versions WHERE id=?1').bind(versionId).first<{ id: number; status: string; payload: string; claim_nonce: string | null }>();
  if (!target) return { ok: false, error: 'version-not-found', why: `v${versionId} 不存在` };
  if (!['validating', 'publishing', 'unknown'].includes(target.status)) return { ok: true, applied: false };

  /* 标 live 之前先核实线上快照(见文件上方 STAMP_WHY)。fail-closed:核不过就不上线。
     🔴 但要把「读不到」与「对不上」分开(第六轮 P1-5):资产层那一瞬读不到不等于有人动了文件,
     此前一律说成「有人绕过发布流程直接改了线上文件」,既是错诊断又不可重试。 */
  const stamp = await readLiveStamp(env);
  /* 口令从**版本行**读,不从锁读(2026-09-01 第六轮,192 格表抓出)。
     终态回报会删锁,所以在「回报丢了→重发」这个真实形态里,锁已经不在了;
     从锁读会让重放必然核验失败。口令属于「这一次发布」,载体是版本行,不是那把会被释放的锁。 */
  const wantSha = await expectedConfigSha(target.payload).catch(() => null);
  const badAnchors = await verifyAnchors(env, stamp);
  const unreadable = (badAnchors ?? []).filter((x) => x.includes('取不到') || x.includes('读取失败'));
  if (unreadable.length && !recovering) {
    // 环境问题,不改版本状态、不释放锁 → 执行器重试即可继续
    return { ok: false, error: 'live-check-unavailable', why: `暂时读不到线上快照(${unreadable.join('、')}),稍后重试;本次发布未判失败` };
  }
  const good =
    stamp && stamp.versionId === versionId && !!target.claim_nonce && stamp.stamp === target.claim_nonce && !!wantSha && stamp.configSha === wantSha
    && (recovering ? badAnchors !== null && badAnchors.length === 0 : !(badAnchors && badAnchors.length));
  if (!good) {
    if (recovering) {
      const applied = await markPublishUnknown(env, versionId, target.claim_nonce, recoveryClaim);
      return { ok: true, applied };
    }
    const why = !stamp
      ? '线上快照里没有本次发布的上线印记(切换步没有真正搬运过产物)'
      : stamp.versionId !== versionId
        ? `线上快照的印记指向 v${stamp.versionId},不是本次要上线的 v${versionId}`
        : stamp.stamp !== target.claim_nonce
          ? '线上快照的印记口令与本次发布不符'
          : stamp.configSha !== wantSha
            ? `线上快照不是照这一版的配置构建的(内容摘要对不上:期望 ${String(wantSha).slice(0, 12)}…,实际 ${String(stamp.configSha ?? '缺失').slice(0, 12)}…)`
            : `线上快照里这些文件已被改动过,与搬运时不符:${(badAnchors ?? []).join('、')}`;
    /* 🔴 两条纵深(第十轮 P0):即使身份校验将来又被谁绕开,这两句也不该殃及别人。
       ① 只把**还在跑的**版本判失败 —— 已经 live/archived/failed 的版本不该被一条回报改写
          (实测:归档版本被翻成 failed 并写下不实审计,而审计只增不改);
       ② 删锁**按 version_id 限定** —— `publish_lock` 是单例表(id=1),无条件删就是
          「谁来都能把当前那把锁删掉」,哪怕那把锁属于另一次进行中的发布。 */
    const applied = await commitPublishFailure(env, versionId, `上线核验未通过:${why}`, now, why, true);
    if (!applied) return { ok: true, applied: false }; // 资产核验期间已收口，不改历史步骤、不造失败审计。
    return { ok: false, error: 'live-verification-failed', why };
  }

  // D1 batch 是事务。前三步使用同一资格条件，最后才改变目标版本状态；
  // 因而并发请求若已收口目标版本，步骤、旧 live 和锁都会一起保持原状。
  const observedAt = recoveryTime(recoveryClaim);
  const eligible = `EXISTS(SELECT 1 FROM config_versions target WHERE target.id=?1 AND target.claim_nonce=?2
    AND target.status IN ('validating','publishing','unknown')
    AND NOT EXISTS(SELECT 1 FROM config_versions newer WHERE newer.status='live' AND newer.id>target.id))
    AND ${recoveryGuard('?4')}`;
  const args = [versionId,target.claim_nonce,now,observedAt];
  const previousLive = await getLive(env);
  const committed = await env.DB.batch([
    env.DB.prepare(`UPDATE publish_steps SET status='ok',ended_at=?3 WHERE version_id=?1 AND step='swap' AND ${eligible}`).bind(...args),
    env.DB.prepare(`UPDATE config_versions SET status='archived' WHERE status='live' AND id<?1 AND ${eligible} RETURNING id`).bind(...args),
    env.DB.prepare(`UPDATE config_versions SET status='live',published_at=?3,fail_reason=NULL WHERE id=?1 AND ${eligible}`).bind(...args),
    prepareAuditAfterPreviousChange(env.DB, {
      actor: auditActor,
      action: 'config.publish.live',
      target: `v${versionId}`,
      before: previousLive ? `v${previousLive.id}` : 'none',
    }),
    env.DB.prepare('DELETE FROM publish_lock WHERE version_id=?1 AND changes()>0').bind(versionId),
  ]);
  const applied = (committed[2]?.meta.changes ?? 0)>0;
  if (!applied && recovering) {
    await markPublishUnknown(env, versionId, target.claim_nonce, recoveryClaim);
  }
  return { ok: true, applied };
}

async function commitPublishFailure(env: Env, versionId: number, reason: string, now: number, stepDetail = reason, failedSwap = false, recoveryClaim?: RecoveryClaim, auditActor?: AuditEntry['actor']) {
  const observedAt = recoveryTime(recoveryClaim);
  const stepEligible = `EXISTS(SELECT 1 FROM config_versions WHERE id=?1 AND status IN ('validating','publishing'))
    AND ${recoveryGuard('?5')}`;
  const versionEligible = recoveryGuard('?3');
  const committed = await env.DB.batch([
    // 恢复只结束正在执行的步骤；仅上线核验明确失败可纠正旧式分步提交留下的 swap ok。
    env.DB.prepare(`UPDATE publish_steps SET status='failed',detail=?2,ended_at=?3 WHERE version_id=?1 AND (status='running' OR (?4=1 AND step='swap')) AND ${stepEligible}`).bind(versionId,stepDetail,now,failedSwap ? 1 : 0,observedAt),
    env.DB.prepare(`UPDATE config_versions SET status='failed',fail_reason=COALESCE(fail_reason,?2) WHERE id=?1
      AND status IN ('validating','publishing') AND ${versionEligible}`).bind(versionId,reason,observedAt),
    prepareAuditAfterPreviousChange(env.DB,{actor:auditActor,action:'config.publish.failed',target:`v${versionId}`,after:reason}),
    env.DB.prepare('DELETE FROM publish_lock WHERE version_id=?1 AND changes()>0').bind(versionId),
  ]);
  const applied = (committed[1]?.meta.changes ?? 0)>0;
  return applied;
}

async function markPublishUnknown(env: Env, versionId: number, nonce: string | null, recoveryClaim?: RecoveryClaim): Promise<boolean> {
  const observedAt = recoveryTime(recoveryClaim);
  const committed = await env.DB.batch([
    env.DB.prepare(`UPDATE config_versions SET status='unknown',fail_reason=?3 WHERE id=?1 AND claim_nonce=?2
      AND status IN ('validating','publishing') AND ${recoveryGuard('?4')}`)
      .bind(versionId,nonce,UNKNOWN_DETAIL,observedAt),
    prepareAuditAfterPreviousChange(env.DB, {
      actor: 'system',
      action: 'config.publish.unknown',
      target: `v${versionId}`,
      before: 'validating/publishing',
      after: UNKNOWN_DETAIL,
      reason: UNKNOWN_REASON,
    }),
  ]);
  return (committed[0]?.meta.changes ?? 0)>0;
}

async function getDraft(env: Env) {
  return (await env.DB.prepare('SELECT payload, draft_rev FROM config_draft WHERE id = 1').first<{ payload: string; draft_rev: number }>())!;
}
async function getLive(env: Env) {
  return env.DB.prepare("SELECT id, payload FROM config_versions WHERE status='live' ORDER BY id DESC LIMIT 1").first<{ id: number; payload: string }>();
}

type DraftUpgradeStatus = Awaited<ReturnType<typeof ensureInit>>;
export const publishRoutes = new Hono<{ Bindings: Env; Variables: { draftUpgrade: DraftUpgradeStatus } }>();

// 全新安装保障:任何发布相关入口先确保种子已就位(见 config.ts ensureInit 注释)
publishRoutes.use('*', async (c, next) => {
  c.set('draftUpgrade', await ensureInit(c.env.DB));
  await next();
});

function upgradeProblem(upgrade: DraftUpgradeStatus) {
  if (upgrade.status === 'blocked') {
    const conflicts = upgrade.conflicts ?? [{path:'$',reason:'旧配置有无法自动合并的修改。'}];
    return {status:409 as const,body:{error:'config-upgrade-conflict',message:'旧配置有需要保留并处理的修改，请先处理列出的冲突字段再发布。',conflicts,paths:conflicts.map(item=>item.path)}};
  }
  if (upgrade.status === 'retry') {
    const message = '草稿正在同步新版配置，请稍后重试发布。';
    return {status:503 as const,body:{error:'config-upgrade-retry',message,conflicts:[{path:'$',reason:message}],paths:['$']}};
  }
  return null;
}

/** 发布前置校验(CON13-E1 的唯一判据源;UI 的「去修复」清单也读它) */
publishRoutes.get('/preflight', async (c) => {
  const draft = await getDraft(c.env);
  const upgrade = upgradeProblem(c.get('draftUpgrade'));
  if (upgrade) return c.json({ready:false,errors:upgrade.body.conflicts.map(item=>({path:item.path,rule:'structure',message:item.reason})),warnings:[],changedPaths:[],changed:0,sensitiveChanged:[],reasonRequired:false,draftRev:draft.draft_rev,message:upgrade.body.message});
  const live = await getLive(c.env);
  const cfg = SiteConfigSchema.parse(JSON.parse(draft.payload));
  const { errors, warnings } = validateConfig(cfg, MANIFEST);
  errors.push(...await translationFreshness(c.env.DB, cfg, MANIFEST));
  const changed = live ? diffPaths(addLegacyLocaleFields(JSON.parse(live.payload), MANIFEST.editable) as SiteConfig, cfg) : [];
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

/** 发起发布(CON13-A1):原子建立版本和执行凭据 → 交执行器;不做任何「跳过门」的分支 */
publishRoutes.post('/', async (c) => {
  const body = await c.req.json<{ reason?: string; fromVersion?: number; draftRev?: number }>().catch(() => null);
  const upgrade = upgradeProblem(c.get('draftUpgrade'));
  if (upgrade) return c.json(upgrade.body,upgrade.status);
  const now = Date.now();
  const live = await getLive(c.env);

  // 回滚(A2):以指定旧版内容为发布内容,同样走完整门链
  let payload: string;
  let source: PublicationSource;
  let rollbackFrom: number | null = null;
  if (body?.fromVersion) {
    /* 只能回滚到**真上线过**的版本(live / archived)。此前不限状态,于是一个门红过、从未上线的版本
       也能当回滚源——它仍走完整门链所以不算绕门,但「回滚」这个词在说假话:回到一个从没存在过的线上态。 */
    const src = await c.env.DB
      .prepare("SELECT id, payload, status FROM config_versions WHERE id = ?1 AND status IN ('live','archived')")
      .bind(body.fromVersion)
      .first<{ id: number; payload: string }>();
    if (!src) return c.json({ error: 'version-not-rollbackable(只能回滚到曾经上线过的版本)' }, 404);
    let historical: unknown;
    try { historical = JSON.parse(src.payload); } catch { historical = null; }
    const adapted = adaptLegacyConfig(historical);
    if (!adapted.ok) return c.json({error:'config-upgrade-conflict',message:'所选历史版本有无法自动保留的配置修改，请先处理冲突字段。',conflicts:adapted.conflicts,paths:adapted.conflicts.map(item=>item.path)},409);
    payload = JSON.stringify(adapted.config); // 只升级新发布副本，历史版本正文永不改写。
    source = { kind: 'snapshot', payload };
    rollbackFrom = src.id;
  } else {
    if (!Number.isInteger(body?.draftRev) || body!.draftRev! < 1) return c.json({error:'draft-revision-required'},400);
    const draft = await getDraft(c.env);
    if (draft.draft_rev !== body!.draftRev) return c.json({error:'draft-changed',draftRev:draft.draft_rev},409);
    payload = draft.payload;
    source = { kind: 'draft', draftRev: body!.draftRev! };
  }

  const cfg = SiteConfigSchema.safeParse(JSON.parse(payload));
  if (!cfg.success) return c.json({ error: 'bad-structure' }, 400);
  const { errors } = validateConfig(cfg.data, MANIFEST);
  if (source.kind === 'draft') errors.push(...await translationFreshness(c.env.DB, cfg.data, MANIFEST));
  if (errors.length) return c.json({ error: 'preflight-failed', errors: errors.slice(0, 50) }, 409); // E1:不进流水线

  const changed = live ? diffPaths(addLegacyLocaleFields(JSON.parse(live.payload), MANIFEST.editable) as SiteConfig, cfg.data) : [];
  if (!rollbackFrom && changed.length === 0) return c.json({ error: 'no-changes' }, 409);
  const sensitive = sensitivePaths(changed);
  if ((sensitive.length > 0 || rollbackFrom) && (body?.reason ?? '').trim().length < 8) {
    return c.json({ error: 'reason-required', sensitiveChanged: sensitive }, 400); // 高敏/回滚须理由
  }

  const executor = await executorState(c.env, now);
  if (!executor.ready) return c.json({error:'executor-unavailable', message:executor.reason, executor}, 503);

  const audit: AuditEntry = {
    action: rollbackFrom ? 'config.rollback' : 'config.publish',
    before: live ? `live=v${live.id}` : 'live=none',
    after: rollbackFrom ? `内容取自 v${rollbackFrom}` : `${changed.length} 处改动`,
    reason: body?.reason?.trim(),
  };
  const created = await createPublication(c.env,source,body?.reason?.trim() ?? null,audit);
  if (!created.ok) {
    if (created.error === 'draft-changed') return c.json({error:'draft-changed',draftRev:created.draftRev},409);
    // 未取得执行资格的请求从不落版本行，避免并发双击留下假失败历史。
    await writeAudit(c.env.DB, { action: 'config.publish.rejected', target: `v${created.heldBy} 正在发布`, after: '并发发布被拒,未建版本', reason: body?.reason?.trim() });
    return c.json({ error: 'publish-in-progress', heldBy: created.heldBy }, 409);
  }
  const versionId = created.versionId;
  // Persist before dispatch: closing the browser cannot lose the job.
  if (executor.mode === 'github') {
    await dispatchPending(c.env);
  }
  return c.json({ ok: true, versionId, rollbackFrom, steps: PUBLISH_STEPS });
});

publishRoutes.get('/executor', async (c) => c.json(await executorState(c.env)));

publishRoutes.get('/runner-state', async (c) => {
  const runnerId = c.req.query('runnerId') ?? '';
  const lock = RUNNER_ID.test(runnerId)
    ? await c.env.DB.prepare('SELECT version_id,expires_at FROM publish_lock WHERE claimed_by=?1 AND expires_at>?2').bind(runnerId,Date.now()).first<{version_id:number;expires_at:number}>()
    : null;
  return c.json({activeVersion:lock?.version_id ?? null, expiresAt:lock?.expires_at ?? null, environment:c.env.ENVIRONMENT, executor:await executorState(c.env)});
});

publishRoutes.post('/heartbeat', async (c) => {
  const b = await c.req.json<{runnerId?:string;versionId?:number;stamp?:string}>().catch(() => null);
  if (!b?.runnerId || !RUNNER_ID.test(b.runnerId)) return c.json({error:'bad-runner-id'},400);
  const now = Date.now();
  if (b.versionId !== undefined) {
    const committed = await c.env.DB.batch([
      c.env.DB.prepare(
        `UPDATE publish_lock SET expires_at=?4 WHERE version_id=?1 AND claimed_by=?2 AND claim_nonce=?3 AND expires_at>?5
         AND EXISTS(SELECT 1 FROM config_versions WHERE id=?1 AND status IN ('validating','publishing'))`,
      ).bind(b.versionId,b.runnerId,b.stamp ?? '',now + LOCK_TTL_MS,now),
      c.env.DB.prepare(`INSERT INTO publish_runner(runner_id,last_seen_at)
        SELECT ?1,?2 WHERE changes()>0
        ON CONFLICT(runner_id) DO UPDATE SET last_seen_at=excluded.last_seen_at`).bind(b.runnerId,now),
      c.env.DB.prepare('DELETE FROM publish_runner WHERE last_seen_at<?1').bind(now-86400000),
    ]);
    if (!committed[0]?.meta.changes) return c.json({error:'not-current-job'},409);
  } else {
    // A daemon or CI run must reach an existing immutable job even if today's draft needs repair.
    const active = await c.env.DB.prepare("SELECT id FROM config_versions WHERE status IN ('validating','publishing','unknown') LIMIT 1").first();
    if (!active) {
      const configUpgrade = await ensureDraftUpgrade(c.env.DB);
      const problem = upgradeProblem(configUpgrade);
      if (problem) return c.json({ ...problem.body, configUpgrade }, problem.status);
    }
    await c.env.DB.batch([
      c.env.DB.prepare('INSERT INTO publish_runner(runner_id,last_seen_at) VALUES(?1,?2) ON CONFLICT(runner_id) DO UPDATE SET last_seen_at=excluded.last_seen_at').bind(b.runnerId,now),
      c.env.DB.prepare('DELETE FROM publish_runner WHERE last_seen_at<?1').bind(now-86400000),
    ]);
  }
  return c.json({ok:true,expiresAt:b.versionId ? now+LOCK_TTL_MS : null});
});

/** Crash recovery cannot claim the old process never deployed. Resolve a swap from served
 * evidence; otherwise retain an explicit unknown state and forbid another publication. */
async function recoverInterrupted(env: Env, versionId: number, detail: string, recoveryClaim?: RecoveryClaim) {
  const v = await env.DB.prepare('SELECT status FROM config_versions WHERE id=?1').bind(versionId).first<{status:string}>();
  if (!v || ['live','archived','failed','cancelled'].includes(v.status)) return {ok:true,terminal:true,live:v?.status==='live',status:v?.status ?? null};
  const swap = await env.DB.prepare("SELECT status FROM publish_steps WHERE version_id=?1 AND step='swap'").bind(versionId).first<{status:string}>();
  if (swap) {
    // 同一份资产只核验一次，步骤与版本由同一个条件事务提交。
    await ensureTerminalEffect(env,versionId,'swap','ok',undefined,undefined,Date.now(),true,recoveryClaim,'system');
  } else {
    await ensureTerminalEffect(env,versionId,'materialize','failed',undefined,detail,Date.now(),false,recoveryClaim,'system');
  }
  const current = await env.DB.prepare('SELECT status FROM config_versions WHERE id=?1').bind(versionId).first<{status:string}>();
  return {ok:true,terminal:!current || ['live','archived','failed','cancelled'].includes(current.status),live:current?.status==='live',status:current?.status ?? null,...(current?.status==='unknown' ? {unknown:true} : {})};
}

export async function maintainPublishing(env: Env) {
  const observedAt = Date.now();
  const expired = await env.DB.prepare(
    "SELECT v.id FROM config_versions v JOIN publish_lock l ON l.version_id=v.id WHERE l.expires_at<=?1 AND v.status IN ('validating','publishing')",
  ).bind(observedAt).all<{id:number}>();
  for (const v of expired.results) await recoverInterrupted(env,v.id,'发布服务中断或超时，草稿已保留，可重新发布。',{observedAt});
  const uncertain = await env.DB.prepare("SELECT id FROM config_versions WHERE status='unknown'").all<{id:number}>();
  for (const v of uncertain.results) await recoverInterrupted(env,v.id,'切换结果待核实');
  // Production has no idle daemon: the existing minute maintenance prepares a deployed schema.
  // Recovery runs first and must still finish if preparation fails; active snapshots are untouched.
  if (env.ENVIRONMENT === 'production' && env.PUBLISH_EXECUTION_MODE === 'github') {
    const active = await env.DB.prepare("SELECT id FROM config_versions WHERE status IN ('validating','publishing','unknown') LIMIT 1").first();
    if (!active) {
      try {
        await ensureInit(env.DB);
        await ensureDraftUpgrade(env.DB);
      } catch {
        console.error('Configuration preparation failed; the original draft was retained.');
      }
    }
  }
  await dispatchPending(env);
}

publishRoutes.post('/runner-fail', async(c) => {
  const b = await c.req.json<{runnerId?:string;versionId?:number;stamp?:string;detail?:string}>().catch(()=>null);
  if (!b?.versionId || !b.runnerId || (b.detail != null && typeof b.detail !== 'string')) return c.json({error:'bad-request'},400);
  const owner = await c.env.DB.prepare('SELECT runner_id,claim_nonce FROM config_versions WHERE id=?1').bind(b.versionId).first<{runner_id:string;claim_nonce:string}>();
  if (!owner || owner.runner_id!==b.runnerId || owner.claim_nonce!==b.stamp) return c.json({error:'not-current-job'},409);
  // Match runner.mjs: retain the bounded diagnostic tail, where process failures appear.
  return c.json(await recoverInterrupted(c.env,b.versionId,(b.detail ?? '发布服务已重启，本次构建中断，草稿保留，可重新发布。').slice(-6000)));
});

/** 执行器领取任务(§5.4 契约;dev 本机 runner / Phase C CI runner 共用)。
    已有步骤开始的任务不再派发:防两个执行器领到同一单各干各的(验收 P1「/next 无租约」)。
    执行器崩溃后的续跑走「锁过期 → 自愈标 failed → 重新发起」,不靠二次派发同一单。 */
/* 用 POST:领单会**写库**(原子占位),不该是 GET。
   带副作用的 GET 在 SameSite=Lax 下是会被跨站顶层导航触发的那一类(复验 P2)。 */
publishRoutes.post('/next', async (c) => {
  const b = await c.req.json<{runnerId?:string;versionId?:number}>().catch(()=>null);
  if (!b?.runnerId || !RUNNER_ID.test(b.runnerId)) return c.json({error:'bad-runner-id'},400);
  if (c.env.ENVIRONMENT==='production' && !Number.isSafeInteger(b.versionId)) return c.json({error:'version-required'},400);
  const lock = await c.env.DB.prepare('SELECT version_id, expires_at FROM publish_lock WHERE id = 1').first<{ version_id: number; expires_at: number }>();
  if (!lock || lock.expires_at < Date.now()) return c.json({ job: null });
  if (b.versionId !== undefined && b.versionId!==lock.version_id) return c.json({job:null});
  const v = await c.env.DB.prepare('SELECT id, status, payload, source_draft_rev FROM config_versions WHERE id = ?1').bind(lock.version_id).first<{ id: number; status: string; payload: string; source_draft_rev: number | null }>();
  if (!v || !['validating', 'publishing'].includes(v.status)) return c.json({ job: null });
  let snapshot: unknown;
  try { snapshot = JSON.parse(v.payload); } catch { snapshot = null; }
  const config = validateUpgradeResolution(snapshot);
  if (!config.ok) return c.json({error:'config-upgrade-conflict',message:'排队版本与当前代码不兼容，原版本未修改，请等待本次任务收口后重新发布。',
    conflicts:config.issues.map((issue)=>({path:issue.path,reason:issue.message})),paths:config.issues.map((issue)=>issue.path)},409);

  /* claim、版本 owner、durable dispatch 必须是同一事务。旧实现先占锁再分两次写：
     任一后写失败都会留下「锁已领、owner/dispatch 未落」的半套状态，重试还只补 owner。
     这批语句同时支持首次领取与同 runner 的响应丢失重试；历史半套状态也会被补齐。 */
  const claimAt = Date.now();
  const dispatchClaim = c.env.PUBLISH_EXECUTION_MODE === 'github'
    ? c.env.DB.prepare(`INSERT INTO publish_dispatch(version_id,state,next_attempt_at)
        SELECT ?1,'claimed',?3
        WHERE EXISTS(SELECT 1 FROM config_versions v WHERE v.id=?1 AND v.runner_id=?2 AND v.status IN ('validating','publishing'))
          AND EXISTS(SELECT 1 FROM publish_lock l WHERE l.id=1 AND l.version_id=?1 AND l.claimed_by=?2
            AND l.claimed_at IS NOT NULL AND l.expires_at>?3)
          AND NOT EXISTS(SELECT 1 FROM publish_steps WHERE version_id=?1)
        ON CONFLICT(version_id) DO UPDATE SET state='claimed'`).bind(v.id,b.runnerId,claimAt)
    : c.env.DB.prepare(`UPDATE publish_dispatch SET state='claimed' WHERE version_id=?1
        AND EXISTS(SELECT 1 FROM config_versions v WHERE v.id=?1 AND v.runner_id=?2 AND v.status IN ('validating','publishing'))
        AND EXISTS(SELECT 1 FROM publish_lock l WHERE l.id=1 AND l.version_id=?1 AND l.claimed_by=?2
          AND l.claimed_at IS NOT NULL AND l.expires_at>?3)
        AND NOT EXISTS(SELECT 1 FROM publish_steps WHERE version_id=?1)`).bind(v.id,b.runnerId,claimAt);
  const committed = await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE publish_lock SET claimed_at=COALESCE(claimed_at,?1),claimed_by=?2,expires_at=?5
      WHERE id=1 AND version_id=?3 AND expires_at>?4
        AND ((claimed_at IS NULL AND claimed_by IS NULL) OR (claimed_at IS NOT NULL AND claimed_by=?2))
        AND EXISTS(SELECT 1 FROM config_versions cv WHERE cv.id=?3 AND cv.status IN ('validating','publishing')
          AND (cv.runner_id IS NULL OR cv.runner_id=?2))
        AND NOT EXISTS(SELECT 1 FROM publish_steps WHERE version_id=?3)
      RETURNING claim_nonce`).bind(claimAt,b.runnerId,v.id,claimAt,claimAt+LOCK_TTL_MS),
    c.env.DB.prepare(`UPDATE config_versions SET runner_id=?2 WHERE id=?1 AND status IN ('validating','publishing')
      AND (runner_id IS NULL OR runner_id=?2)
      AND EXISTS(SELECT 1 FROM publish_lock l WHERE l.id=1 AND l.version_id=?1 AND l.claimed_by=?2
        AND l.claimed_at IS NOT NULL AND l.expires_at>?3)
      AND NOT EXISTS(SELECT 1 FROM publish_steps WHERE version_id=?1)`).bind(v.id,b.runnerId,claimAt),
    dispatchClaim,
    c.env.DB.prepare(`SELECT l.claim_nonce FROM publish_lock l JOIN config_versions v ON v.id=l.version_id
      WHERE l.id=1 AND l.version_id=?1 AND l.claimed_by=?2 AND l.claimed_at IS NOT NULL AND l.expires_at>?3
        AND v.runner_id=?2 AND v.status IN ('validating','publishing')
        AND NOT EXISTS(SELECT 1 FROM publish_steps WHERE version_id=?1)
        AND (?4=0 OR EXISTS(SELECT 1 FROM publish_dispatch d WHERE d.version_id=?1 AND d.state='claimed'))`)
      .bind(v.id,b.runnerId,claimAt,c.env.PUBLISH_EXECUTION_MODE === 'github' ? 1 : 0),
  ]);
  const receipt = committed[3]?.results?.[0] as {claim_nonce:string | null} | undefined;
  if (!receipt?.claim_nonce) return c.json({ job: null, note: 'already-claimed' });

  /* 增量分级:领单时按「本版 vs 当前线上」的配置 diff 定档,执行器据此跳过源码静态门。
     算不出(线上无版本/解析失败)一律按全量,不降档。 */
  let changeTier: PublishChangeTier = 'config-shape';
  try {
    const live = await c.env.DB.prepare("SELECT payload FROM config_versions WHERE status='live' ORDER BY id DESC LIMIT 1").first<{ payload: string }>();
    if (live) changeTier = classifyChangedPaths(diffPaths(JSON.parse(live.payload), JSON.parse(v.payload)));
  } catch { changeTier = 'config-shape'; }
  return c.json({
    job: { versionId: v.id, draftRev: v.source_draft_rev, source: v.source_draft_rev === null ? 'snapshot' : 'draft', config: config.config, steps: PUBLISH_STEPS, stamp: receipt.claim_nonce, runnerId: b.runnerId, changeTier },
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
  const b = await c.req.json<{ versionId?: number; step?: PublishStep; status?: string; detail?: string; gate?: string; stamp?: string; runnerId?:string }>().catch(() => null);
  if (!b?.versionId || !b.step || !PUBLISH_STEPS.includes(b.step) || !['running', 'ok', 'failed'].includes(b.status ?? '') || (b.detail != null && typeof b.detail !== 'string')) {
    return c.json({ error: 'bad-request' }, 400);
  }
  const detail = b.detail?.slice(-6000);
  const now = Date.now();

  /* ══════════ 第零层:身份 —— 这条回报是不是这一版的执行器发的 ══════════
     🔴 2026-09-01 第十轮(独立验收 P1-1,我回源核实后上抬为 P0)。第六次「两个各自正确的修法
     合起来造出新故障」:
       修法 A(第五轮):把幂等挪到锁检查**之前** —— 因为终态回报会删锁,从锁后面判会永远判错;
       修法 B(第六轮):重放不能只跳过记录、还要把该做的副作用补上 —— 否则响应一丢整个上线被跳过。
     合起来:**一个不检查授权的分支,调用了一个有副作用的事务**。实测攻击序列:
     任一已登录用户对着一个**早已归档**的旧版本报 `swap ok` + 垃圾口令 → 走进幂等分支 →
     `ensureTerminalEffect` 核验线上印记(当然对不上)→ 把那个旧版本改成 failed、写下不实审计、
     **并删掉当时属于另一次进行中发布的锁**。非攻击也会中招:一条迟到的正常重发若在该版本被取代后到达,
     同样误删别人的锁。

     根治不是再往幂等分支里补一个 if,是把**身份**从「锁」上摘下来:
     口令的载体本来就是版本行(`config_versions.claim_nonce`,`ensureTerminalEffect` 第 204 行
     早就是这么读的),而锁只是「谁在跑」的临时凭据。身份先验、且与锁无关,于是
     **重放(锁已删但口令仍在)与冒充(口令对不上)第一次被分开**,幂等分支不必再自带授权。 */
  const versionNonce = await c.env.DB
    .prepare('SELECT claim_nonce, status, runner_id FROM config_versions WHERE id=?1')
    .bind(b.versionId)
    .first<{ claim_nonce: string | null; status: string; runner_id:string | null }>();
  if (!versionNonce) return c.json({ error: 'no-such-version' }, 404);
  if (!versionNonce.claim_nonce || b.stamp !== versionNonce.claim_nonce || b.runnerId!==versionNonce.runner_id) {
    return c.json({ error: 'not-the-claimed-runner(请先领取任务)' }, 409);
  }

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
    if (b.status === 'running') {
      if (detail === undefined) return c.json({ ok: true, idempotent: true });
      // 子命令进度只改说明；计时与租约仍由步骤开始和任务心跳负责。
      const updated = await c.env.DB.prepare(`UPDATE publish_steps SET detail=?6
        WHERE version_id=?1 AND step=?2 AND status='running'
          AND EXISTS(SELECT 1 FROM config_versions v JOIN publish_lock l ON l.version_id=v.id
            WHERE v.id=?1 AND v.status IN ('validating','publishing') AND v.claim_nonce=?3 AND v.runner_id=?4
              AND l.id=1 AND l.claim_nonce=?3 AND l.claimed_by=?4 AND l.claimed_at IS NOT NULL AND l.expires_at>?5)`)
        .bind(b.versionId,b.step,b.stamp!,b.runnerId!,Date.now(),detail).run();
      return updated.meta.changes ? c.json({ ok: true, idempotent: true }) : c.json({ error: 'not-current-job' }, 409);
    }
    const eff = await ensureTerminalEffect(c.env, b.versionId, b.step, b.status as 'ok' | 'failed', b.gate, detail, now);
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
  /* 口令已在第零层按**版本行**验过(与锁无关,重放时锁可能已经不在)。这里只需确认这把锁
     确实被领取过 —— 未领取的锁不该有人在上报进度。口令本身不再重复比对:
     锁上那份与版本行那份同源(`claimJob` 一次写两处),再比一次不增加保证,却会让
     「重放」在锁已删时无从通过(第五轮踩过的那个洞)。 */
  if (!lock.claimed_at || !lock.claim_nonce) {
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
    const committingAt = Date.now();
    const eligible = `EXISTS(SELECT 1 FROM config_versions v JOIN publish_lock l ON l.version_id=v.id
      WHERE v.id=?1 AND v.status IN ('validating','publishing') AND v.claim_nonce=?3 AND v.runner_id=?4
        AND l.id=1 AND l.claim_nonce=?3 AND l.claimed_by=?4 AND l.claimed_at IS NOT NULL AND l.expires_at>?5)
      AND NOT EXISTS(SELECT 1 FROM publish_steps WHERE version_id=?1 AND step=?2)
      ${idx ? `AND (SELECT COUNT(DISTINCT step) FROM publish_steps WHERE version_id=?1 AND status='ok'
        AND step IN (${PUBLISH_STEPS.slice(0,idx).map(step=>`'${step}'`).join(',')}))=${idx}` : ''}`;
    const args = [b.versionId,b.step,b.stamp!,b.runnerId!,committingAt];
    const committed = await c.env.DB.batch([
      c.env.DB.prepare(`UPDATE config_versions SET status='publishing' WHERE id=?1 AND ${eligible}`).bind(...args),
      c.env.DB.prepare(`UPDATE publish_lock SET expires_at=?6 WHERE id=1 AND version_id=?1 AND ${eligible}`).bind(...args,committingAt+LOCK_TTL_MS),
      // 最后写步骤，前三句始终共用「本步尚未存在」的资格；迟到回报不能复活终态或续错锁。
      c.env.DB.prepare(`INSERT INTO publish_steps (version_id,step,status,started_at,detail)
        SELECT ?1,?2,'running',?5,?6 WHERE ${eligible}`).bind(...args,detail ?? null),
    ]);
    if (!committed[2]?.meta.changes) return c.json({error:'not-current-job'},409);
    return c.json({ ok: true });
  }

  // 终态的步骤与版本必须共用条件事务，不能先把步骤写好再异步核验资产。
  if (b.status === 'failed' || b.step === 'swap') {
    const eff = await ensureTerminalEffect(c.env,b.versionId,b.step,b.status as 'ok'|'failed',b.gate,detail,now);
    if (!eff.ok) return c.json({error:eff.error,why:eff.why},409);
    return c.json({ok:true,...(b.status==='failed' ? {failed:true,reason:eff.reason} : {})});
  }
  // ③ 非终态成功也不能改写已经被并发请求收口的版本。
  const upd = await c.env.DB
    .prepare("UPDATE publish_steps SET status=?3, detail=?4, ended_at=?5 WHERE version_id=?1 AND step=?2 AND status='running' AND EXISTS(SELECT 1 FROM config_versions WHERE id=?1 AND status IN ('validating','publishing'))")
    .bind(b.versionId, b.step, b.status, detail ?? null, now)
    .run();
  if ((upd.meta.changes ?? 0) === 0) return c.json({ error: 'step-not-running(先报 running 再报结果)' }, 409);

  const eff = await ensureTerminalEffect(c.env, b.versionId, b.step, b.status as 'ok' | 'failed', b.gate, detail, now);
  if (!eff.ok) return c.json({ error: eff.error, why: eff.why }, 409);
  return c.json({ ok: true, ...(b.status === 'failed' ? { failed: true, reason: eff.reason } : {}) });
});

/** 版本列表 + 当前发布进度(UI 轮询用)。
    🔴 读时自愈:锁已过期(或根本没锁)却还挂在 validating/publishing 的版本,一律标 failed——
    否则执行器中途死掉后,界面会一直显示「正在发布」直到下一次有人发起发布才被顺手清理,
    那是「看起来在跑、其实早死了」的假状态(实测:执行器被开发服务器重启掐断后即如此)。 */
publishRoutes.get('/status', async (c) => {
  await maintainPublishing(c.env);
  const lock = await c.env.DB.prepare('SELECT version_id, expires_at FROM publish_lock WHERE id = 1').first<{ version_id: number; expires_at: number }>();
  const now = Date.now();
  const active = lock && lock.expires_at > now ? lock.version_id : null;
  /* 自愈也要留痕、也要收口(第四轮 P2-5)。此前:标了 failed 却**不写审计**,
     且把步骤永远留在 running —— 版本说「失败」、步骤说「进行中」,两边自相矛盾,
     事后翻记录的人无从判断到底发生了什么。取消那条路径是会收口步骤的,自愈这条不会,
     同一件事两条路径两种处理,就是漏的来源。 */
  const stale = (
    await c.env.DB
      .prepare(`SELECT id FROM config_versions v WHERE status IN ('validating','publishing')
        AND NOT EXISTS(SELECT 1 FROM publish_lock l WHERE l.version_id=v.id AND l.expires_at>?1)`)
      .bind(now)
      .all<{ id: number }>()
  ).results;
  if (stale.length) {
    for (const v of stale) {
      // 恢复函数区分未切换的失败与待核实的切换，并且只给真正提交的失败写审计。
      await recoverInterrupted(c.env,v.id,'发布服务中断或超时，草稿已保留，可重新发布。',{observedAt:now});
    }
  }
  if (!active && lock) await releaseExpiredTerminalLock(c.env, lock.version_id, now);
  /* 步骤日志:进行中看当前版本;没有进行中时回**最近一次**的步骤日志——
     否则失败态下「查看原始日志」永远没有数据可渲染(验收 P1:日志存了却取不回)。 */
  const stepsOf = active ?? (await c.env.DB.prepare('SELECT version_id FROM publish_steps ORDER BY id DESC LIMIT 1').first<{ version_id: number }>())?.version_id ?? null;
  const steps = stepsOf
    ? (await c.env.DB.prepare('SELECT version_id, step, status, detail, started_at, ended_at FROM publish_steps WHERE version_id=?1 ORDER BY id').bind(stepsOf).all()).results
    : [];
  /* 🔴 截断要说出来,而且**当前线上那一版必须在**(2026-09-01 实景走查 P1)。
     此前固定取最近 30 条,46 个版本时线上那一行直接消失,而表头写着「只增不删」——
     界面在说一句它自己正在违反的话。现在:多取一条用来判断有没有截断,并单独把 live 行捞回来。 */
  const PAGE = 30;
  const rowsRaw = (
    await c.env.DB
      .prepare(`SELECT id, status, reason, fail_reason, created_by, created_at, published_at FROM config_versions ORDER BY id DESC LIMIT ${PAGE + 1}`)
      .all<{ id: number; status: string; reason: string | null; fail_reason: string | null; created_by: string; created_at: number; published_at: number | null }>()
  ).results;
  const truncated = rowsRaw.length > PAGE;
  const versions: Array<(typeof rowsRaw)[number] & { changed?: number }> = rowsRaw.slice(0, PAGE);
  // 线上那一版不在这一页里就单独捞回来:它是这张表最不能缺的一行
  const liveRow = await c.env.DB
    .prepare("SELECT id, status, reason, fail_reason, created_by, created_at, published_at FROM config_versions WHERE status='live' ORDER BY id DESC LIMIT 1")
    .first<{ id: number; status: string; reason: string | null; fail_reason: string | null; created_by: string; created_at: number; published_at: number | null }>();
  if (liveRow && !versions.some((v) => v.id === liveRow.id)) versions.push(liveRow);

  /* PRD ⑤ 的「改动数」列(实景走查 P2-1,六轮同条)。
     每一版相对**它上线时的前一版**改了多少处——这是运营翻历史时最想知道的一个数。
     只对有内容的版本算(种子行与空壳行跳过);算不出来就留空,不编。 */
  {
    /* 🔴 基线必须是**这一版真正的前一版**,不是「本页里排在它前面的那一行」(2026-09-01 第八轮 P2)。
       第一版拿窗口内相邻两行相减,于是:① 窗口最旧那行拿了个不相干的版本当基线,**编出一个不对的数**;
       ② 被单独捞回来的线上行排到最前,自己永远算不出。
       「算不出来就留空」这条承诺,只有在基线正确时才成立——**基线错了,留空与否都不重要,数已经是假的**。
       改成逐行去库里取「id 比它小的最近一版」,窗口外也取得到。 */
    for (const v of versions) {
      const pair = await c.env.DB
        .prepare(
          `SELECT (SELECT payload FROM config_versions WHERE id < ?1 ORDER BY id DESC LIMIT 1) AS prev,
                  (SELECT payload FROM config_versions WHERE id = ?1) AS cur`,
        )
        .bind(v.id)
        .first<{ prev: string | null; cur: string | null }>();
      if (!pair?.prev || !pair.cur || pair.prev === '{}' || pair.cur === '{}') continue; // 没有前一版 / 空壳 → 留空
      try {
        v.changed = diffPaths(addLegacyLocaleFields(JSON.parse(pair.prev), MANIFEST.editable) as SiteConfig, addLegacyLocaleFields(JSON.parse(pair.cur), MANIFEST.editable) as SiteConfig).length;
      } catch { /* 结构对不上就留空,不编一个数出来 */ }
    }
  }

  /* 🔴 劈叉自查(2026-09-01 复验 P1-3):切换脚本先落盘、再回报,所以「盘上已经换了、回报没送到」
     是一个不需要攻击者就会发生的形态(执行器死在这一拍即可)。此前没有任何一处会发现它——
     界面说「线上保持旧版」,而站上早就是新内容了。现在每次读状态都拿线上快照的印记与
     数据库记的 live 对一次,不一致就明说,让人能看见并重发一次把两边对齐。 */
  const drift = await liveSnapshotDrift(c.env).catch(() => null);

  /* 取消能力直接告诉界面,别让它靠**发一个注定失败的请求**去试探(2026-09-01 实景走查 P2-10):
     此前界面先打一次 /cancel,拿 409 里的 canForce 决定要不要展示强制面——行为正确,
     但正常操作路径每次都在浏览器控制台留一条红。判据与 /cancel 完全一致,不另造一套。 */
  const lastStep = active
    ? await c.env.DB.prepare('SELECT MAX(COALESCE(ended_at, started_at)) AS t, COUNT(*) AS n FROM publish_steps WHERE version_id=?1').bind(active).first<{ t: number | null; n: number }>()
    : null;
  const started = (lastStep?.n ?? 0) > 0;
  const lastSeen = active ? await lastJobActivity(c.env,active,lastStep?.t ?? null) : 0;
  const silentMs = lastSeen ? now-lastSeen : 0;
  const swapping = steps.some((s) => s.step==='swap');
  const cancelable = active ? (swapping ? 'no' : started ? (silentMs >= RUNNER_SILENT_MS ? 'force' : 'no') : 'yes') : 'none';

  return c.json({
    activeVersion: active, stepsOfVersion: stepsOf, steps, versions, versionsTruncated: truncated,
    stepNames: PUBLISH_STEPS, drift, cancelable, silentMs,
    executor:await executorState(c.env),
  });
});

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
  const swapping = await c.env.DB.prepare("SELECT id FROM publish_steps WHERE version_id=?1 AND step='swap'").bind(lock.version_id).first();
  if (swapping) return c.json({error:'swap-in-progress',hint:'已开始切换，需等待系统核实结果，不能中止后覆盖发布。'},409);
  const last = await c.env.DB
    .prepare('SELECT MAX(COALESCE(ended_at, started_at)) AS t, COUNT(*) AS n FROM publish_steps WHERE version_id=?1')
    .bind(lock.version_id)
    .first<{ t: number | null; n: number }>();
  const started = (last?.n ?? 0) > 0;
  const lastSeen = await lastJobActivity(c.env,lock.version_id,last?.t ?? null);
  const silentMs = lastSeen ? Date.now()-lastSeen : 0;

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

  const now = Date.now();
  const cutoff = now - RUNNER_SILENT_MS;
  const why = started ? `强制中止(执行器失联 ${Math.round(silentMs / 60_000)} 分钟):${body!.reason!.trim()}` : '已取消(执行器未上线)';
  const modeEligibility = started
    ? `EXISTS(SELECT 1 FROM publish_steps s WHERE s.version_id=?1)
       AND COALESCE((SELECT MAX(COALESCE(s.ended_at,s.started_at)) FROM publish_steps s WHERE s.version_id=?1),0)<=?3
       AND COALESCE((SELECT MAX(COALESCE(l.claimed_at,0),l.expires_at-${LOCK_TTL_MS}) FROM publish_lock l WHERE l.version_id=?1),0)<=?3`
    : `NOT EXISTS(SELECT 1 FROM publish_steps s WHERE s.version_id=?1) AND ?3 IS NOT NULL`;
  const committed = await c.env.DB.batch([
    /* 🔴 取消记 'cancelled' 不记 'failed'(2026-09-01 第四轮 P1-5):按 PRD E4 正常取消一次,
       就会换来一条「上次发布失败」的红条常驻全站、只有下一次成功发布能清掉。
       取消是运营的主动决定,不是故障——把它记成故障,红条就在说假话。 */
    c.env.DB.prepare(`UPDATE config_versions SET status='cancelled',fail_reason=?2 WHERE id=?1
      AND status IN ('validating','publishing')
      AND EXISTS(SELECT 1 FROM publish_lock l WHERE l.id=1 AND l.version_id=?1)
      AND NOT EXISTS(SELECT 1 FROM publish_steps s WHERE s.version_id=?1 AND s.step='swap')
      AND ${modeEligibility}`).bind(lock.version_id,why,cutoff),
    prepareAuditAfterPreviousChange(c.env.DB,{action:'config.publish.cancel',target:`v${lock.version_id}`,after:why,reason:body?.reason?.trim()}),
    c.env.DB.prepare('DELETE FROM publish_lock WHERE id=1 AND version_id=?1 AND changes()>0').bind(lock.version_id),
    c.env.DB.prepare(`UPDATE publish_steps SET status='failed',detail=?2,ended_at=?3 WHERE version_id=?1 AND status='running'
      AND EXISTS(SELECT 1 FROM config_versions WHERE id=?1 AND status='cancelled' AND fail_reason=?2)
      AND NOT EXISTS(SELECT 1 FROM publish_lock WHERE version_id=?1)`).bind(lock.version_id,why,now),
  ]);
  if ((committed[0]?.meta.changes ?? 0)===0) return c.json({error:'cancel-conflict',hint:'发布状态已变化，请刷新后重试。'},409);
  return c.json({ ok: true, forced: !!started });
});
