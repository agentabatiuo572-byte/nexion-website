import { Hono } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import { z } from 'zod';
import type { Context, MiddlewareHandler } from 'hono';
import type { Env } from './env';
import { prepareAuditAfterPreviousChange, writeAudit } from './audit';
import { timingSafeEqualHex } from './auth';
import { createLimiter } from './ratelimit';
import { isBotUserAgent } from './bot';
import { SENTINEL_COUNTRY, isRealCountryCode } from '../../schema/src/countries';
import { METRIC_TEXT_BYTES } from '../../schema/src/event-contract';
import { truncateUtf8 } from '../../schema/src/utf8';
import { LOCALES, SOURCE_LOCALE, type Locale } from '../../schema/src/locales';
import { pathLocale, publishedLocales } from './published-locales';

/* 区域屏蔽(PRD CON12)。两条通道原则(§2.3):规则由 D1 串行化、KV 边缘物化,不经发布链。
   自锁保护(E1):/admin 与 /api 前缀恒不拦(V1-dev 同域路径制;Phase C 子域后可收紧 /api 面);
   直通 cookie 放行且不计统计。兜底(E3):KV 读取异常 → 内置基线名单 CN 生效(不失守不误伤全站)。
   模拟(E4):x-geo-sim 头只在**显式声明的非生产环境**生效(白名单判据,见 SIM_ENVS)。

   🔴 安全评审(2026-08-31)两条 CRITICAL 的修法记录:
   C1 密钥 fail-closed:BYPASS_SECRET 缺失、或在非 dev 环境仍为仓库内 dev 默认值 → 直通链整体停用
      (签发 503 / 校验 false),不再用空串兜底;令牌另设有效期上限,伪造者无法自选遥远到期。
   C2 判据反转:模拟头改为「环境值 ∈ {dev, preview} 才允许」的白名单——配置漏设/拼错/未覆盖时
      默认拒绝模拟(fail-closed),而不是默认放行。原写法 `!== 'production'` 在漏配时是不安全的。 */

export interface GeoRules {
  enabled: boolean;
  countries: string[];
  blockPage: { title: { zh: string } & Partial<Record<Locale, string>>; body: { zh: string } & Partial<Record<Locale, string>> };
  updatedAt?: number;
  updatedBy?: string;
  updateOperationId?: string;
  updateRequestFingerprint?: string;
}

const DEFAULT_PAGE: GeoRules['blockPage'] = {
  title: { zh: '服务在您所在的地区不可用', en: 'Service unavailable in your region' },
  body: {
    zh: '本服务目前不向您所在的地区提供。感谢理解。',
    en: 'This service is currently not offered in your region. Thank you for your understanding.',
  },
};
/** KV 未配置时的初始态:关闭(上线切换清单强制开启并演练,PRD CON12-③) */
const INITIAL: GeoRules = { enabled: false, countries: ['CN'], blockPage: DEFAULT_PAGE };
/** KV 读取异常时的兜底基线(E3):启用 + CN */
const BASELINE: GeoRules = { enabled: true, countries: ['CN'], blockPage: DEFAULT_PAGE };

const KV_KEY = 'geo:rules';
const materializedKey = (version: number): string => `${KV_KEY}:v${version}`;
const CACHE_MS = 60_000;
/** 模拟头允许生效的环境白名单(C2:未列入者一律拒绝模拟) */
const SIM_ENVS = new Set(['dev', 'preview']);
/** 仓库内公开的 dev 默认密钥——出现在非 dev 环境即视为「未轮换」,直通停用(C1) */
const DEV_DEFAULT_SECRET = 'dev-bypass-secret';
const BYPASS_TOKEN_TTL_MS = 5 * 60_000;
const BYPASS_COOKIE_TTL_MS = 30 * 24 * 3600_000;
const BYPASS_COOKIE = 'gx_bypass';

let cache: { rules: GeoRules; degraded: boolean; ts: number } | null = null;
export function resetGeoCache(): void {
  cache = null;
}

const bypassLimiter = createLimiter(60_000, 20); // 兑换端点:20 次/分/IP(M1)
/* 拦截统计写入节流(M4:防单源高频把 raw_events 写爆)。阈值取 120/分/IP,与采集接口同档:
   正常人类浏览远够不到,只有洪水级来源会被削顶。⚠️ 代价必须如实呈现:被削顶时「今日拦截」
   是**下限**而非精确值——面板与 PRD 都标注,不做「看起来精确」的假数字(数字可信不自曝)。 */
const blockedLogLimiter = createLimiter(60_000, 120);
export function resetGeoLimiters(): void {
  bypassLimiter.reset();
  blockedLogLimiter.reset();
}

export async function loadRules(env: Env): Promise<{ rules: GeoRules; degraded: boolean }> {
  const now = Date.now();
  if (cache && now - cache.ts < CACHE_MS) return cache;
  try {
    const row = await readGeoStateRow(env.DB);
    if (!row) {
      // 仅迁移前兼容旧部署；空 D1 时普通写入被禁，旧 KV 只能作为 bootstrap 候选。
      const raw = await env.KV.get(KV_KEY);
      cache = { rules: raw ? parseStoredRules(raw) : INITIAL, degraded: false, ts: now };
      return cache;
    }
    const state = await decodeGeoState(row);
    try {
      const raw = await env.KV.get(materializedKey(row.version));
      if (raw !== null) {
        const serialized = serializeRules(parseStoredRules(raw));
        if (await fingerprintSerializedRules(serialized) === row.current_fingerprint) {
          cache = { rules: state.rules, degraded: row.status === 'pending', ts: now };
          return cache;
        }
      }
      // 缺失、陈旧或损坏的 KV 永远不会降格为权威；直接使用 D1 当前版本。
      cache = { rules: state.rules, degraded: true, ts: now };
    } catch {
      cache = { rules: state.rules, degraded: true, ts: now };
    }
  } catch {
    cache = { rules: BASELINE, degraded: true, ts: now }; // E3:失联即基线,不失守
  }
  return cache;
}

// ---------- 直通(E1):控制台签发短时令牌 → 站域换 30 天 cookie;server 权威,client 禁造 ----------

const enc = new TextEncoder();

/** 密钥闸(C1):不可用则返回 null,调用方一律 fail-closed */
function bypassSecret(env: Env): string | null {
  const s = env.BYPASS_SECRET ?? '';
  if (!s) return null; // 未配置 → 直通停用(而非空串验签)
  if (!SIM_ENVS.has(env.ENVIRONMENT) && s === DEV_DEFAULT_SECRET) return null; // 未轮换的 dev 默认值上了非 dev 环境
  return s;
}

async function hmacHex(secret: string, msg: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(msg));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
async function mintToken(secret: string, scope: string, ttlMs: number): Promise<string> {
  const exp = Date.now() + ttlMs;
  const jti = crypto.randomUUID();
  return `v2.${exp}.${jti}.${await hmacHex(secret, `${scope}.v2.${exp}.${jti}`)}`;
}
/** 校验:签名(常数时间)+ 未过期 + **有效期不超过该 scope 的上限**(C1:封死自选遥远 exp) */
type TokenVerification = { ok: false } | {
  ok: true;
  sig: string;
  exp: number;
  jti: string;
  format: 'legacy' | 'v2';
};

async function verifyToken(secret: string | null, scope: string, token: string | undefined, maxTtlMs: number): Promise<TokenVerification> {
  if (!secret || !token) return { ok: false };
  const parts = token.split('.');
  const isV2 = parts.length === 4 && parts[0] === 'v2';
  const isLegacy = parts.length === 2;
  if (!isV2 && !isLegacy) return { ok: false };
  const expStr = isV2 ? parts[1] : parts[0];
  const jti = isV2 ? parts[2] : parts[1];
  const sig = isV2 ? parts[3] : parts[1];
  const exp = Number(expStr);
  const now = Date.now();
  if (!Number.isFinite(exp) || !sig || !jti) return { ok: false };
  if (exp < now || exp > now + maxTtlMs + 60_000) return { ok: false }; // 上限 + 60s 时钟宽容
  const signed = isV2 ? `${scope}.v2.${exp}.${jti}` : `${scope}.${exp}`;
  if (!timingSafeEqualHex(await hmacHex(secret, signed), sig)) return { ok: false };
  return { ok: true, sig, exp, jti: isV2 ? `v2:${jti}` : `legacy:${sig}`, format: isV2 ? 'v2' : 'legacy' };
}

export async function hasValidBypass(c: Context<{ Bindings: Env }>): Promise<boolean> {
  const r = await verifyToken(bypassSecret(c.env), 'bp', getCookie(c, BYPASS_COOKIE), BYPASS_COOKIE_TTL_MS);
  return r.ok;
}

// ---------- 拦截页与统计 ----------

export function pathClass(p: string): string {
  if (p === '/' || p === '') return 'home';
  const encodedSegment = p.split('/').filter(Boolean)[0] ?? 'other';
  let segment = encodedSegment;
  try {
    segment = decodeURIComponent(encodedSegment);
  } catch {
    // 畸形百分号序列保留原文，随后仍按共享 UTF-8 字节上限截断。
  }
  return truncateUtf8(segment, METRIC_TEXT_BYTES.blockedPathClass);
}

/** HTML 文本转义;引号一并转(L1:防未来搬进属性上下文时静默变成注入点) */
const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

function blockPageHtml(r: GeoRules, requested: Locale): string {
  /* 回退链:请求语言 → 撰写源语言 → 英语(历史存量只有英文时仍可渲染,不空白)。 */
  const candidates = [requested, SOURCE_LOCALE, 'en' as Locale].filter((l, i, a) => a.indexOf(l) === i);
  const locale = candidates.find((l) => r.blockPage.title[l]?.trim() && r.blockPage.body[l]?.trim()) ?? SOURCE_LOCALE;
  return `<!doctype html><html lang="${locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(r.blockPage.title[locale] ?? '')}</title><style>html{background:#0a0a0b;color:#b9b9c0;font:15px/1.7 system-ui,sans-serif}body{display:flex;min-height:96vh;align-items:center;justify-content:center;margin:0;padding:20px}main{max-width:520px;text-align:center}h1{color:#f2f2f3;font-size:19px;margin:0 0 6px}p{margin:4px 0}</style></head><body><main><h1>${esc(r.blockPage.title[locale] ?? '')}</h1><p>${esc(r.blockPage.body[locale] ?? '')}</p></main></body></html>`;
}

/** 边缘拦截中间件——挂在一切路由之前(index.ts) */
export const geoMiddleware: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  const path = new URL(c.req.url).pathname;
  if (path === '/admin' || path.startsWith('/admin/') || path.startsWith('/api/')) return next(); // E1 自锁保护 + API 面
  const { rules } = await loadRules(c.env);
  if (!rules.enabled) return next();
  const sim = SIM_ENVS.has(c.env.ENVIRONMENT) ? c.req.header('x-geo-sim') : undefined; // C2:白名单判据,漏配即拒绝模拟
  const country = (sim || (c.req.raw.cf?.country as string | undefined) || c.req.header('cf-ipcountry') || 'XX').toUpperCase();
  if (!rules.countries.includes(country)) return next();
  if (await hasValidBypass(c)) return next(); // 直通放行且不计统计
  const wantsHtml = (c.req.header('accept') ?? '').includes('text/html');
  if (wantsHtml) {
    // 仅文档请求入统计分桶(CON12-③;资产噪声不计),且按 IP 节流防写放大(M4)
    const ip = c.req.header('cf-connecting-ip') ?? 'unknown';
    if (!blockedLogLimiter.hit(ip)) {
      const bot = isBotUserAgent(c.req.header('user-agent') ?? '') ? 1 : 0;
      const log = c.env.DB.prepare('INSERT INTO raw_events (ts, type, uid, payload) VALUES (?1, ?2, NULL, ?3)')
        .bind(Date.now(), 'blocked', JSON.stringify({ t: 'blocked', c: country, p: pathClass(path), bot }))
        .run()
        .then(() => {})
        .catch(() => {}); // 统计失败不影响拦截本体
      try {
        c.executionCtx.waitUntil(log); // 生产:后台落库不拖响应
      } catch {
        await log; // 测试环境无 ExecutionContext:同步等待
      }
    }
    const enabled = await publishedLocales(c.env);
    const requested = pathLocale(path);
    return c.html(blockPageHtml(rules, enabled.includes(requested) ? requested : 'en'), 451);
  }
  return c.body(null, 451);
};

// ---------- 站域直通兑换(公开;令牌来自控制台签发) ----------

export const bypassExchange = new Hono<{ Bindings: Env }>();
bypassExchange.get('/', async (c) => {
  const ip = c.req.header('cf-connecting-ip') ?? 'unknown';
  if (bypassLimiter.hit(ip)) return c.text('too many attempts', 429); // M1
  const secret = bypassSecret(c.env);
  const r = await verifyToken(secret, 'bt', c.req.query('t'), BYPASS_TOKEN_TTL_MS);
  if (!r.ok || !secret) return c.text('bypass token invalid or expired', 403);
  /* 部署切换即退役旧两段式兑换链接。旧版 bp cookie 仍由 hasValidBypass 接受，
     但旧 bt 链接一律不能再兑换，因此最终一致的 bp:used:<sig> KV 标记不会留下重放窗。 */
  if (r.format === 'legacy') return c.text('bypass token retired by security upgrade', 403);
  /* M2 一次性兑换必须依赖强一致唯一写。Cloudflare KV 的 get -> put 没有 CAS，
     两个 isolate 可同时读到“未使用”后都放行；D1 主键冲突才是原子裁决点。 */
  try {
    const redeemed = await c.env.DB.batch([
      c.env.DB.prepare('DELETE FROM geo_bypass_redemptions WHERE expires_at < ?1').bind(Date.now()),
      c.env.DB.prepare(
        'INSERT INTO geo_bypass_redemptions (jti, redeemed_at, expires_at) VALUES (?1, ?2, ?3) ON CONFLICT(jti) DO NOTHING',
      ).bind(r.jti, Date.now(), r.exp),
    ]);
    if (!(redeemed[1]?.meta.changes ?? 0)) return c.text('bypass token already used', 403);
  } catch (error) {
    console.error('bypass redemption ledger unavailable', { error });
    return c.text('bypass redemption unavailable', 503);
  }
  setCookie(c, BYPASS_COOKIE, await mintToken(secret, 'bp', BYPASS_COOKIE_TTL_MS), {
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    path: '/',
    maxAge: BYPASS_COOKIE_TTL_MS / 1000,
  });
  return c.redirect('/');
});

// ---------- 控制台规则 API(requireAuth 由挂载处保证) ----------

const HIGH_TRAFFIC_SHARE = 0.05; // E2 护栏:本次变为被拦的国家近 7 天流量占比 ≥5% 须显式确认

/** PUT body 契约(L2:按 §3「一切写接口 zod 校验」补) */
const pageLanguages = (max: number) => z.object({
  // Keep the historical property order: stored D1/KV fingerprints bind these exact bytes.
  // 撰写源语言必填(SOURCE_LOCALE=zh),其余可选 —— 与后台_geo页“中文必填”一致。
  zh: z.string().min(1).max(max), en: z.string().max(max).optional(),
  ...Object.fromEntries(LOCALES.filter((locale) => locale !== 'zh' && locale !== 'en').map((locale) => [locale, z.string().max(max).optional()])) as Record<Exclude<Locale, 'zh' | 'en'>, z.ZodOptional<z.ZodString>>,
}).strict();
const TriPage = z.object({ title: pageLanguages(120), body: pageLanguages(300) }).strict();
const GeoPutSchema = z.object({
  enabled: z.boolean(),
  /* 🔴 必须是真实 ISO 码且非兜底哨兵 XX(2026-08-31 第二路验收 P2):
     只校验「两个大写字母」时,ZZ 这类假码可入名单形同噪声,而 XX 会把所有
     「拿不到国家信息」的访客一并拦掉——那是误伤,不是屏蔽策略。面板与此处同表。 */
  countries: z.array(z.string().refine(isRealCountryCode, '必须是真实 ISO 国家/地区码(且不得为兜底值 XX)')).max(249),
  blockPage: TriPage.optional(),
  reason: z.string().trim().min(8),
  operationId: z.string().uuid(),
  expectedVersion: z.number().int().positive(),
  expectedFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  highTrafficConfirmation: z.object({
    operationId: z.string().uuid(),
    fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  }).optional(),
});

/* 存量读取容忍历史数据(写时只有英文必填)：中英任一必填，渲染侧回退链兜底。
   属性顺序与 TriPage 一致，序列化指纹口径不变。 */
const StoredPageLanguages = (max: number) => z.object({
  zh: z.string().max(max).optional(), en: z.string().max(max).optional(),
  ...Object.fromEntries(LOCALES.filter((locale) => locale !== 'zh' && locale !== 'en').map((locale) => [locale, z.string().max(max).optional()])) as Record<Exclude<Locale, 'zh' | 'en'>, z.ZodOptional<z.ZodString>>,
}).strict().refine((p) => Boolean(p.zh?.trim() || p.en?.trim()), '拦截页至少保留一种语言正文');
const StoredTriPage = z.object({ title: StoredPageLanguages(120), body: StoredPageLanguages(300) }).strict();
const StoredGeoRulesSchema = z.object({
  enabled: z.boolean(),
  countries: z.array(z.string().refine(isRealCountryCode)).max(249),
  blockPage: StoredTriPage,
  updatedAt: z.number().finite().optional(),
  updatedBy: z.string().optional(),
  updateOperationId: z.string().optional(),
  updateRequestFingerprint: z.string().regex(/^[0-9a-f]{64}$/).optional(),
}).passthrough();

interface GeoStateRow {
  status: 'ready' | 'pending';
  current_rules: string;
  current_fingerprint: string;
  version: number;
  pending_kind: 'bootstrap' | 'update' | null;
  pending_operation_id: string | null;
  pending_previous_rules: string | null;
  pending_previous_fingerprint: string | null;
  pending_started_at: number | null;
  pending_before_summary: string | null;
  pending_after_summary: string | null;
  pending_reason: string | null;
}

interface DecodedGeoState {
  row: GeoStateRow;
  rules: GeoRules;
  previousRules: GeoRules | null;
}

interface GeoRuleOperationRow {
  operation_id: string;
  request_fingerprint: string;
  result_rules: string;
  result_fingerprint: string;
  result_version: number;
  status: 'pending' | 'applied';
}

interface DecodedGeoRuleOperation {
  row: GeoRuleOperationRow;
  rules: GeoRules;
}

type MaterializationObservation = 'target' | 'current' | 'unknown' | 'unavailable';

const summary = (r: GeoRules): string =>
  `enabled=${r.enabled} [${r.countries.join(',')}] page=${JSON.stringify(r.blockPage).length}B`;

function parseStoredRules(serialized: string): GeoRules {
  const parsedJson: unknown = JSON.parse(serialized);
  const parsed = StoredGeoRulesSchema.safeParse(parsedJson);
  if (!parsed.success) throw new Error(`stored geo rules invalid: ${parsed.error.issues[0]?.message ?? 'unknown'}`);
  return parsed.data as GeoRules;
}

function serializeRules(rules: GeoRules): string {
  return JSON.stringify(StoredGeoRulesSchema.parse(rules));
}

async function fingerprintSerializedRules(serialized: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(serialized));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function sameRequestedRules(
  current: GeoRules,
  requested: Pick<z.infer<typeof GeoPutSchema>, 'enabled' | 'countries'>,
  blockPage: GeoRules['blockPage'],
): boolean {
  return current.enabled === requested.enabled
    && current.countries.length === requested.countries.length
    && current.countries.every((country, index) => country === requested.countries[index])
    && JSON.stringify(current.blockPage) === JSON.stringify(blockPage);
}

/** 二次确认只对这次操作、这份权威基线和这份完整规则快照有效。 */
async function highTrafficConfirmationFingerprint(
  body: z.infer<typeof GeoPutSchema>,
  blockPage: GeoRules['blockPage'],
  hot: ReadonlyArray<{ country: string; share: number }>,
): Promise<string> {
  return fingerprintSerializedRules(JSON.stringify({
    operationId: body.operationId,
    expectedVersion: body.expectedVersion,
    expectedFingerprint: body.expectedFingerprint,
    rules: { enabled: body.enabled, countries: body.countries, blockPage },
    hot,
  }));
}

/** operationId 只允许重放同一份规范化完整请求；任何字段漂移都必须冲突。 */
async function updateRequestFingerprint(
  body: z.infer<typeof GeoPutSchema>,
  blockPage: GeoRules['blockPage'],
): Promise<string> {
  const confirmation = body.highTrafficConfirmation
    ? {
        operationId: body.highTrafficConfirmation.operationId,
        fingerprint: body.highTrafficConfirmation.fingerprint,
      }
    : null;
  return fingerprintSerializedRules(JSON.stringify({
    operationId: body.operationId,
    expectedVersion: body.expectedVersion,
    expectedFingerprint: body.expectedFingerprint,
    rules: { enabled: body.enabled, countries: body.countries, blockPage },
    reason: body.reason.trim(),
    highTrafficConfirmation: confirmation,
  }));
}

async function readGeoStateRow(db: D1Database): Promise<GeoStateRow | null> {
  return db.prepare(
    `SELECT status, current_rules, current_fingerprint, version,
            pending_kind, pending_operation_id, pending_previous_rules,
            pending_previous_fingerprint, pending_started_at,
            pending_before_summary, pending_after_summary, pending_reason
       FROM geo_rule_state WHERE id=1`,
  ).first<GeoStateRow>();
}

async function decodeGeoState(row: GeoStateRow): Promise<DecodedGeoState> {
  const rules = parseStoredRules(row.current_rules);
  if (await fingerprintSerializedRules(row.current_rules) !== row.current_fingerprint) {
    throw new Error('geo D1 authority fingerprint mismatch');
  }
  let previousRules: GeoRules | null = null;
  if (row.status === 'pending') {
    if (!row.pending_previous_rules || !row.pending_previous_fingerprint) {
      throw new Error('geo D1 pending state incomplete');
    }
    previousRules = parseStoredRules(row.pending_previous_rules);
    if (await fingerprintSerializedRules(row.pending_previous_rules) !== row.pending_previous_fingerprint) {
      throw new Error('geo D1 previous fingerprint mismatch');
    }
  }
  return { row, rules, previousRules };
}

async function readGeoRuleOperation(db: D1Database, operationId: string): Promise<DecodedGeoRuleOperation | null> {
  const row = await db.prepare(
    `SELECT operation_id,request_fingerprint,result_rules,result_fingerprint,result_version,status
       FROM geo_rule_operations WHERE operation_id=?1`,
  ).bind(operationId).first<GeoRuleOperationRow>();
  if (!row) return null;
  const rules = parseStoredRules(row.result_rules);
  if (
    await fingerprintSerializedRules(row.result_rules) !== row.result_fingerprint
    || rules.updateOperationId !== row.operation_id
    || rules.updateRequestFingerprint !== row.request_fingerprint
  ) throw new Error('geo operation ledger result mismatch');
  return { row, rules };
}

async function generateUnreservedGeoOperationId(db: D1Database): Promise<string> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const operationId = crypto.randomUUID();
    if (!(await readGeoRuleOperation(db, operationId))) return operationId;
  }
  throw new Error('unable to allocate an unreserved geo operation id');
}

function operationAuthority(operation: DecodedGeoRuleOperation) {
  return {
    status: 'ready' as const,
    source: 'd1' as const,
    version: operation.row.result_version,
    currentFingerprint: operation.row.result_fingerprint,
  };
}

function authorityView(state: DecodedGeoState) {
  const { row } = state;
  if (row.status === 'ready') {
    return { status: 'ready' as const, source: 'd1' as const, version: row.version, currentFingerprint: row.current_fingerprint };
  }
  return {
    status: 'pending' as const,
    source: 'd1' as const,
    kind: row.pending_kind!,
    operationId: row.pending_operation_id!,
    version: row.version,
    currentFingerprint: row.current_fingerprint,
    targetFingerprint: row.current_fingerprint,
    previousFingerprint: row.pending_previous_fingerprint!,
    startedAt: row.pending_started_at!,
  };
}

/**
 * 仅用于一次性迁移界面。这里返回的是“旧 KV 候选”，绝不把普通 KV.get
 * 描述成权威读；D1 插入事务才是首次权威版本的线性化点。
 */
async function readLegacyCandidate(env: Env): Promise<{
  rules: GeoRules;
  serialized: string;
  fingerprint: string | null;
  degraded: boolean;
}> {
  try {
    return { ...(await readLegacyCandidateStrict(env)), degraded: false };
  } catch (error) {
    console.error('legacy geo KV candidate unavailable', { error });
    const serialized = serializeRules(BASELINE);
    return { rules: BASELINE, serialized, fingerprint: null, degraded: true };
  }
}

async function readLegacyCandidateStrict(env: Env): Promise<{
  rules: GeoRules;
  serialized: string;
  fingerprint: string;
}> {
  const raw = await env.KV.get(KV_KEY);
  const rules = raw === null ? INITIAL : parseStoredRules(raw);
  const serialized = serializeRules(rules);
  return { rules, serialized, fingerprint: await fingerprintSerializedRules(serialized) };
}

interface PendingGeoUpdate {
  operationId: string;
  kind: 'bootstrap' | 'update';
  startedAt: number;
  previousRules: GeoRules;
  previousSerialized: string;
  previousFingerprint: string;
  nextRules: GeoRules;
  nextSerialized: string;
  nextFingerprint: string;
  target: string;
  before: string;
  after: string;
  reason: string;
}

function decodedPending(update: PendingGeoUpdate, version: number): DecodedGeoState {
  return {
    row: {
      status: 'pending',
      current_rules: update.nextSerialized,
      current_fingerprint: update.nextFingerprint,
      version,
      pending_kind: update.kind,
      pending_operation_id: update.operationId,
      pending_previous_rules: update.previousSerialized,
      pending_previous_fingerprint: update.previousFingerprint,
      pending_started_at: update.startedAt,
      pending_before_summary: update.before,
      pending_after_summary: update.after,
      pending_reason: update.reason,
    },
    rules: update.nextRules,
    previousRules: update.previousRules,
  };
}

/**
 * D1 条件更新与 attempt 审计在同一事务。命中时 current_* 立即推进为目标，
 * 这一步就是规则写入的线性化点；pending 只表示边缘 KV 尚未确认物化。
 */
async function claimGeoUpdate(
  db: D1Database,
  current: DecodedGeoState,
  update: PendingGeoUpdate,
  requestFingerprint: string,
): Promise<boolean> {
  const committed = await db.batch([
    db.prepare(
      `UPDATE geo_rule_state
          SET status='pending', current_rules=?1, current_fingerprint=?2, version=version+1,
              pending_kind='update', pending_operation_id=?3,
              pending_previous_rules=?4, pending_previous_fingerprint=?5,
              pending_started_at=?6, pending_before_summary=?7,
              pending_after_summary=?8, pending_reason=?9
        WHERE id=1 AND status='ready' AND version=?10 AND current_fingerprint=?11
          AND NOT EXISTS (SELECT 1 FROM geo_rule_operations WHERE operation_id=?12)`,
    ).bind(
      update.nextSerialized,
      update.nextFingerprint,
      update.operationId,
      update.previousSerialized,
      update.previousFingerprint,
      update.startedAt,
      update.before,
      update.after,
      update.reason,
      current.row.version,
      current.row.current_fingerprint,
      update.operationId,
    ),
    db.prepare(
      `INSERT INTO geo_rule_operations (
         operation_id,request_fingerprint,result_rules,result_fingerprint,
         result_version,status,created_at,applied_at
       )
       SELECT ?1,?2,?3,?4,?5,'pending',?6,NULL WHERE changes() > 0`,
    ).bind(
      update.operationId,
      requestFingerprint,
      update.nextSerialized,
      update.nextFingerprint,
      current.row.version + 1,
      update.startedAt,
    ),
    prepareAuditAfterPreviousChange(db, {
      action: 'geo.update.attempt',
      target: update.target,
      before: update.before,
      after: update.after,
      reason: update.reason,
    }),
  ]);
  return (committed[0]?.meta.changes ?? 0) > 0 && (committed[1]?.meta.changes ?? 0) > 0;
}

/** ready+degraded 的修复不推进规则版本，但必须先把可恢复意图与 attempt 原子落进 D1。 */
async function claimGeoReadyRematerialization(
  db: D1Database,
  current: DecodedGeoState,
  update: PendingGeoUpdate,
): Promise<boolean> {
  const committed = await db.batch([
    db.prepare(
      `UPDATE geo_rule_state
          SET status='pending', pending_kind='update', pending_operation_id=?1,
              pending_previous_rules=?2, pending_previous_fingerprint=?3,
              pending_started_at=?4, pending_before_summary=?5,
              pending_after_summary=?6, pending_reason=?7
        WHERE id=1 AND status='ready' AND version=?8 AND current_fingerprint=?9
          AND NOT EXISTS (SELECT 1 FROM geo_rule_operations WHERE operation_id=?1)`,
    ).bind(
      update.operationId,
      update.previousSerialized,
      update.previousFingerprint,
      update.startedAt,
      update.before,
      update.after,
      update.reason,
      current.row.version,
      current.row.current_fingerprint,
    ),
    prepareAuditAfterPreviousChange(db, {
      action: 'geo.update.attempt',
      target: update.target,
      before: update.before,
      after: update.after,
      reason: update.reason,
    }),
  ]);
  return (committed[0]?.meta.changes ?? 0) > 0;
}

async function claimGeoBootstrap(db: D1Database, update: PendingGeoUpdate): Promise<boolean> {
  const committed = await db.batch([
    db.prepare(
      `INSERT INTO geo_rule_state (
         id, status, current_rules, current_fingerprint, version,
         pending_kind, pending_operation_id, pending_previous_rules,
         pending_previous_fingerprint, pending_started_at,
         pending_before_summary, pending_after_summary, pending_reason
       )
       SELECT 1, 'pending', ?1, ?2, 1, 'bootstrap', ?3, ?1, ?2, ?4, ?5, ?6, ?7
        WHERE NOT EXISTS (SELECT 1 FROM geo_rule_state WHERE id=1)
          AND NOT EXISTS (SELECT 1 FROM geo_rule_operations WHERE operation_id=?3)`,
    ).bind(
      update.nextSerialized,
      update.nextFingerprint,
      update.operationId,
      update.startedAt,
      update.before,
      update.after,
      update.reason,
    ),
    prepareAuditAfterPreviousChange(db, {
      action: 'geo.update.attempt',
      target: update.target,
      before: update.before,
      after: update.after,
      reason: update.reason,
    }),
  ]);
  return (committed[0]?.meta.changes ?? 0) > 0;
}

/** 状态清 pending 与 applied 审计同一事务；并发恢复只会有一个调用写入 applied。 */
async function finalizeGeoUpdate(db: D1Database, pending: DecodedGeoState, reasonSuffix = ''): Promise<boolean> {
  const { row } = pending;
  const reason = `${row.pending_reason ?? ''}${reasonSuffix}`;
  const operationId = row.pending_operation_id;
  if (!operationId) throw new Error('geo pending operation id missing');
  const ledger = await db.prepare(
    'SELECT status,result_version,result_fingerprint FROM geo_rule_operations WHERE operation_id=?1',
  ).bind(operationId).first<{
    status: 'pending' | 'applied';
    result_version: number;
    result_fingerprint: string;
  }>();

  if (ledger) {
    const committed = await db.batch([
      db.prepare(
        `UPDATE geo_rule_state
            SET status='ready', pending_kind=NULL, pending_operation_id=NULL,
                pending_previous_rules=NULL, pending_previous_fingerprint=NULL,
                pending_started_at=NULL, pending_before_summary=NULL,
                pending_after_summary=NULL, pending_reason=NULL
          WHERE id=1 AND status='pending' AND pending_operation_id=?1 AND current_fingerprint=?2
            AND EXISTS (
              SELECT 1 FROM geo_rule_operations
               WHERE operation_id=?1 AND status='pending'
                 AND result_version=geo_rule_state.version
                 AND result_fingerprint=geo_rule_state.current_fingerprint
            )`,
      ).bind(operationId, row.current_fingerprint),
      db.prepare(
        `UPDATE geo_rule_operations SET status='applied',applied_at=?2
          WHERE operation_id=?1 AND status='pending' AND changes() > 0`,
      ).bind(operationId, Date.now()),
      prepareAuditAfterPreviousChange(db, {
        action: 'geo.update.applied',
        target: `geo:rules#${operationId}`,
        before: row.pending_before_summary ?? undefined,
        after: row.pending_after_summary ?? undefined,
        reason,
      }),
    ]);
    if (
      (committed[0]?.meta.changes ?? 0) > 0
      && (committed[1]?.meta.changes ?? 0) > 0
    ) return true;
    const [latestState, latestOperation] = await Promise.all([
      readGeoStateRow(db),
      db.prepare('SELECT status,result_version,result_fingerprint FROM geo_rule_operations WHERE operation_id=?1')
        .bind(operationId)
        .first<{ status: string; result_version: number; result_fingerprint: string }>(),
    ]);
    if (!latestState || !latestOperation) return false;
    return latestState.status === 'ready'
      && latestState.version === latestOperation.result_version
      && latestState.current_fingerprint === latestOperation.result_fingerprint
      && latestOperation.status === 'applied';
  }

  const committed = await db.batch([
    db.prepare(
      `UPDATE geo_rule_state
          SET status='ready', pending_kind=NULL, pending_operation_id=NULL,
              pending_previous_rules=NULL, pending_previous_fingerprint=NULL,
              pending_started_at=NULL, pending_before_summary=NULL,
              pending_after_summary=NULL, pending_reason=NULL
        WHERE id=1 AND status='pending' AND pending_operation_id=?1 AND current_fingerprint=?2`,
    ).bind(operationId, row.current_fingerprint),
    prepareAuditAfterPreviousChange(db, {
      action: 'geo.update.applied',
      target: `geo:rules#${operationId}`,
      before: row.pending_before_summary ?? undefined,
      after: row.pending_after_summary ?? undefined,
      reason,
    }),
  ]);
  if ((committed[0]?.meta.changes ?? 0) > 0) return true;
  const latest = await readGeoStateRow(db);
  return latest?.status === 'ready' && latest.current_fingerprint === row.current_fingerprint;
}

async function observeKvMaterialization(env: Env, state: DecodedGeoState): Promise<MaterializationObservation> {
  try {
    const targetRaw = await env.KV.get(materializedKey(state.row.version));
    if (targetRaw !== null) {
      const targetFingerprint = await fingerprintSerializedRules(serializeRules(parseStoredRules(targetRaw)));
      return targetFingerprint === state.row.current_fingerprint ? 'target' : 'unknown';
    }
    if (state.row.pending_kind === 'bootstrap') {
      const legacyRaw = await env.KV.get(KV_KEY);
      if (legacyRaw === null) return state.rules.enabled === INITIAL.enabled
        && JSON.stringify(state.rules.countries) === JSON.stringify(INITIAL.countries)
        && JSON.stringify(state.rules.blockPage) === JSON.stringify(INITIAL.blockPage) ? 'current' : 'unknown';
      const legacyFingerprint = await fingerprintSerializedRules(serializeRules(parseStoredRules(legacyRaw)));
      return legacyFingerprint === state.row.current_fingerprint ? 'current' : 'unknown';
    }
    const previousRaw = await env.KV.get(materializedKey(state.row.version - 1));
    if (previousRaw === null) return 'unknown';
    const previousFingerprint = await fingerprintSerializedRules(serializeRules(parseStoredRules(previousRaw)));
    return previousFingerprint === state.row.pending_previous_fingerprint ? 'current' : 'unknown';
  } catch {
    return 'unavailable';
  }
}

async function materializePending(env: Env, state: DecodedGeoState, reasonSuffix = ''): Promise<boolean> {
  // 每个 D1 版本写独立不可变 key。迟到的旧 Worker 最多重写旧版本，无法覆盖新规则。
  await env.KV.put(materializedKey(state.row.version), state.row.current_rules);
  resetGeoCache();
  return finalizeGeoUpdate(env.DB, state, reasonSuffix);
}

function readyAuthorityFromPending(state: DecodedGeoState) {
  return {
    status: 'ready' as const,
    source: 'd1' as const,
    version: state.row.version,
    currentFingerprint: state.row.current_fingerprint,
  };
}

async function trafficShares(db: D1Database): Promise<Map<string, number>> {
  const rows = await db
    .prepare("SELECT country, SUM(pv) AS pv FROM daily_traffic WHERE date >= date('now', '-7 day') GROUP BY country")
    .all<{ country: string; pv: number }>();
  const total = rows.results.reduce((s, r) => s + r.pv, 0);
  return new Map(rows.results.map((r) => [r.country, total ? r.pv / total : 0]));
}

export const geoRoutes = new Hono<{ Bindings: Env }>();

geoRoutes.get('/', async (c) => {
  let rules: GeoRules;
  let degraded: boolean;
  let authority:
    | ReturnType<typeof authorityView>
    | { status: 'bootstrap-required'; source: 'legacy-kv-candidate'; candidateFingerprint: string | null };
  try {
    const row = await readGeoStateRow(c.env.DB);
    if (row) {
      const state = await decodeGeoState(row);
      rules = state.rules;
      authority = authorityView(state);
      // 这次 KV 读取只探测物化通道是否可达；值即使陈旧也不参与权威判断。
      try {
        const raw = await c.env.KV.get(materializedKey(row.version));
        degraded = row.status === 'pending'
          || raw === null
          || await fingerprintSerializedRules(serializeRules(parseStoredRules(raw))) !== row.current_fingerprint;
      } catch {
        degraded = true;
      }
    } else {
      const candidate = await readLegacyCandidate(c.env);
      rules = candidate.rules;
      degraded = candidate.degraded;
      authority = {
        status: 'bootstrap-required',
        source: 'legacy-kv-candidate',
        candidateFingerprint: candidate.fingerprint,
      };
    }
  } catch (error) {
    console.error('geo D1 authority unavailable', { error });
    return c.json({ error: 'geo-authority-unavailable' }, 503);
  }
  const last7 = await c.env.DB
    .prepare("SELECT country, SUM(hits) AS hits FROM daily_blocked WHERE date >= date('now', '-7 day') GROUP BY country ORDER BY hits DESC LIMIT 20")
    .all<{ country: string; hits: number }>();
  const pv7 = await c.env.DB
    .prepare("SELECT COALESCE(SUM(pv),0) AS pv FROM daily_traffic WHERE date >= date('now', '-7 day')")
    .first<{ pv: number }>();
  const todayLive = await c.env.DB
    .prepare(`SELECT COUNT(*) AS n
                FROM raw_events
               WHERE type='blocked' AND ts >= ?1
                 AND json_valid(payload)=1
                 AND json_type(payload)='object'
                 AND (
                   json_type(payload,'$.bot') IS NULL
                   OR (
                     json_type(payload,'$.bot') IN ('integer','real')
                     AND json_extract(payload,'$.bot')=0
                   )
                 )`)
    .bind(Date.parse(new Date().toISOString().slice(0, 10) + 'T00:00:00Z'))
    .first<{ n: number }>();
  const blocked7 = last7.results.reduce((s, r) => s + r.hits, 0);
  return c.json({
    rules,
    degraded,
    authority,
    /** 直通链是否可用(密钥闸;false=未轮换/未配置,面板须提示而不是给个坏按钮) */
    bypassAvailable: bypassSecret(c.env) !== null,
    stats: {
      last7: last7.results,
      todayLive: todayLive?.n ?? 0,
      blocked7,
      shareOfRequests: blocked7 + (pv7?.pv ?? 0) > 0 ? blocked7 / (blocked7 + (pv7?.pv ?? 0)) : 0, // 口径:拦截文档数/(拦截+人类 pv)
    },
  });
});

geoRoutes.put('/', async (c) => {
  const parsed = GeoPutSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return c.json({ error: 'bad-request', detail: `${first?.path.join('.') || ''} ${first?.message || ''}`.trim() }, 400);
  }
  const body = parsed.data;
  let current: DecodedGeoState;
  try {
    const row = await readGeoStateRow(c.env.DB);
    if (!row) {
      return c.json({ error: 'geo-bootstrap-required' }, 409);
    }
    current = await decodeGeoState(row);
  } catch (error) {
    console.error('geo update D1 authority read failed', { error });
    return c.json({ error: 'geo-authority-unavailable' }, 503);
  }
  const cur = current.rules;
  const operationId = body.operationId;
  let existingOperation: DecodedGeoRuleOperation | null;
  try {
    existingOperation = await readGeoRuleOperation(c.env.DB, operationId);
  } catch (error) {
    console.error('geo operation ledger read failed', { operationId, error });
    return c.json({ error: 'geo-operation-ledger-unavailable', operationId }, 503);
  }
  const page = body.blockPage ?? existingOperation?.rules.blockPage ?? cur.blockPage;
  const requestFingerprint = await updateRequestFingerprint(body, page);

  if (existingOperation) {
    if (existingOperation.row.request_fingerprint !== requestFingerprint) {
      return c.json({ error: 'geo-operation-id-conflict', operationId, authority: authorityView(current) }, 409);
    }
    if (existingOperation.row.status === 'pending') {
      if (current.row.status !== 'pending' || current.row.pending_operation_id !== operationId) {
        return c.json({ error: 'geo-operation-ledger-state-mismatch', operationId }, 503);
      }
      return c.json({ error: 'geo-update-pending', operationId, authority: authorityView(current) }, 409);
    }
    const superseded = current.row.version !== existingOperation.row.result_version
      || current.row.current_fingerprint !== existingOperation.row.result_fingerprint;
    return c.json({
      ok: true,
      idempotent: true,
      superseded,
      operationId,
      rules: existingOperation.rules,
      authority: operationAuthority(existingOperation),
      ...(superseded ? { currentAuthority: authorityView(current) } : {}),
    });
  }

  /* 客户端重试沿用同一 operationId。D1 已经持久化该 id 时，只接受完全相同的
     基线推进和规则意图；绝不再生成版本或审计。 */
  const sameOperation = cur.updateOperationId === operationId;
  if (sameOperation) {
    if (
      cur.updateRequestFingerprint !== requestFingerprint
      || current.row.version !== body.expectedVersion + 1
      || !sameRequestedRules(cur, body, page)
    ) {
      return c.json({ error: 'geo-operation-id-conflict', operationId, authority: authorityView(current) }, 409);
    }
    if (current.row.status === 'pending') {
      return c.json({ error: 'geo-update-pending', operationId, authority: authorityView(current) }, 409);
    }
    return c.json({ ok: true, idempotent: true, operationId, rules: cur, authority: authorityView(current) });
  }
  if (current.row.status === 'pending') {
    return c.json({ error: 'geo-update-pending', operationId: current.row.pending_operation_id, authority: authorityView(current) }, 409);
  }
  if (
    current.row.version !== body.expectedVersion
    || current.row.current_fingerprint !== body.expectedFingerprint
  ) {
    return c.json({ error: 'geo-update-conflict', operationId, authority: authorityView(current) }, 409);
  }

  const becomingBlocked = !body.enabled
    ? []
    : cur.enabled
      ? body.countries.filter((country) => !cur.countries.includes(country))
      : body.countries;
  if (becomingBlocked.length) {
    const shares = await trafficShares(c.env.DB);
    const hot = becomingBlocked
      .filter((country) => (shares.get(country) ?? 0) >= HIGH_TRAFFIC_SHARE)
      .map((country) => ({ country, share: shares.get(country) ?? 0 }))
      .sort((a, b) => a.country < b.country ? -1 : a.country > b.country ? 1 : 0);
    if (hot.length) {
      const confirmationFingerprint = await highTrafficConfirmationFingerprint(body, page, hot);
      const confirmation = body.highTrafficConfirmation;
      if (
        !confirmation
        || confirmation.operationId !== operationId
        || confirmation.fingerprint !== confirmationFingerprint
      ) {
        return c.json({
          error: 'need-confirm-high-traffic',
          hot,
          operationId,
          confirmationFingerprint,
        }, 409); // E2 误伤护栏
      }
    }
  }
  const next: GeoRules = {
    ...cur,
    enabled: body.enabled,
    countries: body.countries,
    blockPage: page,
    updatedAt: Date.now(),
    updatedBy: 'admin',
    updateOperationId: operationId,
    updateRequestFingerprint: requestFingerprint,
  };
  // M3:拦截页文案变化也要进审计摘要——否则「只改文案」的变更在审计里看起来什么都没变
  const pageChanged = JSON.stringify(cur.blockPage) !== JSON.stringify(page);
  const target = `geo:rules#${operationId}`;
  const before = summary(cur);
  const after = `${summary(next)}${pageChanged ? ' (拦截页文案已改)' : ''}`;
  const reason = body.reason.trim();
  const serialized = serializeRules(next);
  const nextFingerprint = await fingerprintSerializedRules(serialized);
  const coordinated: PendingGeoUpdate = {
    operationId,
    kind: 'update',
    startedAt: Date.now(),
    previousRules: cur,
    previousSerialized: current.row.current_rules,
    previousFingerprint: current.row.current_fingerprint,
    nextRules: next,
    nextSerialized: serialized,
    nextFingerprint,
    target,
    before,
    after,
    reason,
  };

  /* D1 是唯一权威。条件事务同时推进规则版本并写 attempt；旧 isolate 的
     version/fingerprint 条件不再命中，因此绝不可能用陈旧整对象覆盖。 */
  let claimed: boolean;
  try {
    claimed = await claimGeoUpdate(c.env.DB, current, coordinated, requestFingerprint);
  } catch (error) {
    console.error('geo update attempt audit failed', { operationId, error });
    return c.json({ error: 'geo-update-audit-unavailable', operationId }, 500);
  }
  if (!claimed) {
    const latestRow = await readGeoStateRow(c.env.DB).catch(() => null);
    const latest = latestRow ? await decodeGeoState(latestRow).catch(() => null) : null;
    if (
      latest
      && latest.rules.updateOperationId === operationId
    ) {
      const latestPage = body.blockPage ?? latest.rules.blockPage;
      const latestRequestFingerprint = await updateRequestFingerprint(body, latestPage);
      if (
        latest.rules.updateRequestFingerprint !== latestRequestFingerprint
        || latest.row.version !== body.expectedVersion + 1
        || !sameRequestedRules(latest.rules, body, latestPage)
      ) {
        return c.json({ error: 'geo-operation-id-conflict', operationId, authority: authorityView(latest) }, 409);
      }
      if (latest.row.status === 'pending') {
        return c.json({ error: 'geo-update-pending', operationId, authority: authorityView(latest) }, 409);
      }
      return c.json({ ok: true, idempotent: true, operationId, rules: latest.rules, authority: authorityView(latest) });
    }
    return c.json({ error: 'geo-update-conflict', operationId, authority: latest ? authorityView(latest) : undefined }, 409);
  }

  const pending = decodedPending(coordinated, current.row.version + 1);
  try {
    if (!(await materializePending(c.env, pending))) {
      return c.json({ error: 'geo-update-recovery-required', operationId, authority: authorityView(pending) }, 503);
    }
  } catch (error) {
    // D1 目标已经线性化。KV 失败或响应丢失只留下可重放的 pending 物化任务。
    resetGeoCache();
    console.error('geo update materialization pending recovery', { operationId, error });
    return c.json({ error: 'geo-update-recovery-required', operationId, authority: authorityView(pending) }, 503);
  }
  return c.json({ ok: true, operationId, rules: next, authority: readyAuthorityFromPending(pending) });
});

const GeoRecoverySchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('bootstrap'),
    rules: StoredGeoRulesSchema,
    candidateFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
    reason: z.string().trim().min(8),
  }),
  z.object({
    action: z.literal('reconcile'),
    operationId: z.string().uuid(),
    reason: z.string().trim().min(8),
  }),
  z.object({
    action: z.literal('rematerialize-ready'),
    operationId: z.string().uuid(),
    version: z.number().int().positive(),
    currentFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
    reason: z.string().trim().min(8),
  }),
]);

/**
 * 部署顺序：先发布此 Worker/0010 并停止旧写入方（空表时新 Worker 的普通 PUT 会被拦）
 * → 管理员读取并确认 legacy-kv-candidate → 本端点的 D1 INSERT 成为首次权威版本
 * → 同值物化到按版本命名的 KV key。旧写入方未静止时，不存在能从最终一致 KV
 * 判定“最后一次旧写”的算法，因此静止是迁移前置条件而非代码里的假 CAS。
 * KV 快照只是一份待确认候选；系统从不声称一次普通 KV.get 能找出“最新”旧版本。
 */
geoRoutes.post('/recovery', async (c) => {
  const parsed = GeoRecoverySchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'bad-request', detail: parsed.error.issues[0]?.message }, 400);

  if (parsed.data.action === 'bootstrap') {
    const candidateRules = parsed.data.rules as GeoRules;
    const serialized = serializeRules(candidateRules);
    const fingerprint = await fingerprintSerializedRules(serialized);
    if (fingerprint !== parsed.data.candidateFingerprint) {
      return c.json({ error: 'geo-bootstrap-candidate-mismatch' }, 409);
    }

    /* 页面 GET 只展示当时看到的 legacy KV 候选。最终确认必须在 D1 INSERT
       之前再次读取并用同一套规范化序列化比较；否则旧页面可把随后出现的新候选
       固化成 D1。旧 writer 静止仍是部署前提，这次重读封住的是确认窗口内漂移。 */
    let currentCandidate: Awaited<ReturnType<typeof readLegacyCandidateStrict>>;
    try {
      currentCandidate = await readLegacyCandidateStrict(c.env);
    } catch (error) {
      console.error('geo bootstrap legacy candidate confirmation failed', { error });
      return c.json({ error: 'geo-bootstrap-candidate-unavailable' }, 503);
    }
    if (
      currentCandidate.fingerprint !== parsed.data.candidateFingerprint
      || currentCandidate.serialized !== serialized
    ) {
      return c.json({ error: 'geo-bootstrap-candidate-changed' }, 409);
    }
    let operationId: string;
    try {
      operationId = await generateUnreservedGeoOperationId(c.env.DB);
    } catch (error) {
      console.error('geo bootstrap operation id allocation failed', { error });
      return c.json({ error: 'geo-operation-ledger-unavailable' }, 503);
    }
    const candidateSummary = summary(candidateRules);
    const pendingUpdate: PendingGeoUpdate = {
      operationId,
      kind: 'bootstrap',
      startedAt: Date.now(),
      previousRules: candidateRules,
      previousSerialized: serialized,
      previousFingerprint: fingerprint,
      nextRules: candidateRules,
      nextSerialized: serialized,
      nextFingerprint: fingerprint,
      target: `geo:rules#${operationId}`,
      before: `legacy KV candidate ${candidateSummary}`,
      after: `D1 authority ${candidateSummary}`,
      reason: parsed.data.reason.trim(),
    };
    let claimed: boolean;
    try {
      claimed = await claimGeoBootstrap(c.env.DB, pendingUpdate);
    } catch (error) {
      console.error('geo bootstrap transaction failed', { operationId, error });
      return c.json({ error: 'geo-bootstrap-unavailable', operationId }, 503);
    }
    if (!claimed) {
      const row = await readGeoStateRow(c.env.DB).catch(() => null);
      const state = row ? await decodeGeoState(row).catch(() => null) : null;
      return c.json({ error: 'geo-bootstrap-conflict', authority: state ? authorityView(state) : undefined }, 409);
    }
    const pending = decodedPending(pendingUpdate, 1);
    try {
      if (!(await materializePending(c.env, pending))) {
        return c.json({ error: 'geo-update-recovery-required', operationId, authority: authorityView(pending) }, 503);
      }
    } catch (error) {
      console.error('geo bootstrap materialization pending recovery', { operationId, error });
      return c.json({ error: 'geo-update-recovery-required', operationId, authority: authorityView(pending) }, 503);
    }
    return c.json({
      ok: true,
      recovery: 'bootstrap' as const,
      operationId,
      rules: candidateRules,
      authority: readyAuthorityFromPending(pending),
    });
  }

  if (parsed.data.action === 'rematerialize-ready') {
    const operationId = parsed.data.operationId;
    try {
      if (await readGeoRuleOperation(c.env.DB, operationId)) {
        return c.json({ error: 'geo-operation-id-conflict', operationId }, 409);
      }
    } catch (error) {
      console.error('geo ready rematerialization operation ledger read failed', { operationId, error });
      return c.json({ error: 'geo-operation-ledger-unavailable', operationId }, 503);
    }
    let current: DecodedGeoState;
    try {
      const row = await readGeoStateRow(c.env.DB);
      if (!row) return c.json({ error: 'geo-bootstrap-required' }, 409);
      current = await decodeGeoState(row);
    } catch (error) {
      console.error('geo ready rematerialization D1 authority read failed', { error });
      return c.json({ error: 'geo-authority-unavailable' }, 503);
    }
    if (current.row.status !== 'ready') {
      if (
        current.row.pending_operation_id === operationId
        && current.row.version === parsed.data.version
        && current.row.current_fingerprint === parsed.data.currentFingerprint
      ) {
        return c.json({ error: 'geo-update-pending', operationId, authority: authorityView(current) }, 409);
      }
      return c.json({ error: 'geo-ready-rematerialization-not-ready', authority: authorityView(current) }, 409);
    }
    if (
      current.row.version !== parsed.data.version
      || current.row.current_fingerprint !== parsed.data.currentFingerprint
    ) {
      return c.json({ error: 'geo-ready-rematerialization-conflict', authority: authorityView(current) }, 409);
    }

    const target = `geo:rules#${operationId}`;
    const before = `ready D1 authority v${current.row.version} ${current.row.current_fingerprint}`;
    const after = `re-materialize ${materializedKey(current.row.version)} from current D1 authority`;
    const reason = parsed.data.reason.trim();
    try {
      const history = await c.env.DB.prepare(
        `SELECT action,before_summary,after_summary,reason
           FROM audit WHERE target=?1 AND action IN ('geo.update.attempt','geo.update.applied')`,
      ).bind(target).all<{
        action: string;
        before_summary: string | null;
        after_summary: string | null;
        reason: string | null;
      }>();
      if (history.results.length) {
        const exactAttempt = history.results.some((entry) =>
          entry.action === 'geo.update.attempt'
          && entry.before_summary === before
          && entry.after_summary === after
          && entry.reason === reason);
        const applied = history.results.some((entry) => entry.action === 'geo.update.applied');
        if (exactAttempt && applied) {
          return c.json({
            ok: true,
            idempotent: true,
            recovery: 'rematerialize-ready' as const,
            operationId,
            rules: current.rules,
            authority: authorityView(current),
          });
        }
        return c.json({ error: 'geo-operation-id-conflict', operationId, authority: authorityView(current) }, 409);
      }
    } catch (error) {
      console.error('geo ready rematerialization audit history read failed', { operationId, error });
      return c.json({ error: 'geo-update-audit-unavailable', operationId }, 503);
    }

    const pendingUpdate: PendingGeoUpdate = {
      operationId,
      kind: 'update',
      startedAt: Date.now(),
      previousRules: current.rules,
      previousSerialized: current.row.current_rules,
      previousFingerprint: current.row.current_fingerprint,
      nextRules: current.rules,
      nextSerialized: current.row.current_rules,
      nextFingerprint: current.row.current_fingerprint,
      target,
      before,
      after,
      reason,
    };
    let claimed: boolean;
    try {
      claimed = await claimGeoReadyRematerialization(c.env.DB, current, pendingUpdate);
    } catch (error) {
      console.error('geo ready rematerialization attempt audit failed', { operationId, error });
      return c.json({ error: 'geo-update-audit-unavailable', operationId }, 503);
    }
    if (!claimed) {
      const row = await readGeoStateRow(c.env.DB).catch(() => null);
      const latest = row ? await decodeGeoState(row).catch(() => null) : null;
      if (
        latest?.row.status === 'pending'
        && latest.row.pending_operation_id === operationId
        && latest.row.version === parsed.data.version
        && latest.row.current_fingerprint === parsed.data.currentFingerprint
      ) {
        return c.json({ error: 'geo-update-pending', operationId, authority: authorityView(latest) }, 409);
      }
      return c.json({ error: 'geo-ready-rematerialization-conflict', operationId, authority: latest ? authorityView(latest) : undefined }, 409);
    }

    const pending = decodedPending(pendingUpdate, current.row.version);
    try {
      if (!(await materializePending(c.env, pending))) {
        return c.json({ error: 'geo-update-recovery-required', operationId, authority: authorityView(pending) }, 503);
      }
    } catch (error) {
      resetGeoCache();
      console.error('geo ready rematerialization pending recovery', { operationId, error });
      return c.json({ error: 'geo-update-recovery-required', operationId, authority: authorityView(pending) }, 503);
    }
    return c.json({
      ok: true,
      recovery: 'rematerialize-ready' as const,
      operationId,
      rules: current.rules,
      authority: readyAuthorityFromPending(pending),
    });
  }

  let pending: DecodedGeoState;
  try {
    const row = await readGeoStateRow(c.env.DB);
    if (!row) return c.json({ error: 'geo-bootstrap-required' }, 409);
    pending = await decodeGeoState(row);
  } catch (error) {
    console.error('geo recovery D1 authority read failed', { error });
    return c.json({ error: 'geo-authority-unavailable' }, 503);
  }
  if (pending.row.status !== 'pending' || pending.row.pending_operation_id !== parsed.data.operationId) {
    return c.json({ error: 'geo-recovery-not-pending', authority: authorityView(pending) }, 409);
  }

  const observed = await observeKvMaterialization(c.env, pending);
  try {
    await writeAudit(c.env.DB, {
      action: 'geo.update',
      target: `geo:rules#${parsed.data.operationId}`,
      before: `pending ${pending.row.pending_kind}; observed=${observed}`,
      after: 're-materialize D1 authority and finalize',
      reason: parsed.data.reason.trim(),
    });
  } catch (error) {
    console.error('geo recovery audit unavailable', { operationId: parsed.data.operationId, error });
    return c.json({ error: 'geo-recovery-audit-unavailable', operationId: parsed.data.operationId, observed }, 503);
  }
  try {
    if (!(await materializePending(c.env, pending, ` [recovery observed=${observed}]`))) {
      return c.json({ error: 'geo-update-recovery-required', operationId: parsed.data.operationId, observed, authority: authorityView(pending) }, 503);
    }
  } catch (error) {
    console.error('geo recovery materialization still pending', { operationId: parsed.data.operationId, observed, error });
    return c.json({ error: 'geo-update-recovery-required', operationId: parsed.data.operationId, observed, authority: authorityView(pending) }, 503);
  }
  return c.json({
    ok: true,
    recovery: 'reconcile' as const,
    observed,
    operationId: parsed.data.operationId,
    rules: pending.rules,
    authority: readyAuthorityFromPending(pending),
  });
});

/** 直通令牌签发(登录态换 5 分钟令牌;审计留痕)。密钥闸不通过 → 503 明说原因,不发坏令牌。 */
geoRoutes.post('/bypass-token', async (c) => {
  const secret = bypassSecret(c.env);
  if (!secret) {
    return c.json({ error: 'bypass-disabled(BYPASS_SECRET 未配置或仍为默认值,请先轮换密钥)' }, 503);
  }
  const t = await mintToken(secret, 'bt', BYPASS_TOKEN_TTL_MS);
  await writeAudit(c.env.DB, { action: 'bypass.issue', target: 'admin' });
  return c.json({ url: `/api/bypass?t=${encodeURIComponent(t)}`, expiresInSec: BYPASS_TOKEN_TTL_MS / 1000 });
});
