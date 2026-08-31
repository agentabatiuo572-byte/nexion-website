import { Hono } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import { z } from 'zod';
import type { Context, MiddlewareHandler } from 'hono';
import type { Env } from './env';
import { writeAudit } from './audit';
import { timingSafeEqualHex } from './auth';
import { createLimiter } from './ratelimit';

/* 区域屏蔽(PRD CON12)。两条通道原则(§2.3):规则走 KV 即时生效,不经发布链。
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
  blockPage: { title: { zh: string; en: string }; body: { zh: string; en: string } };
  updatedAt?: number;
  updatedBy?: string;
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
    const raw = await env.KV.get(KV_KEY);
    const rules = raw ? (JSON.parse(raw) as GeoRules) : INITIAL;
    cache = { rules, degraded: false, ts: now };
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
  return `${exp}.${await hmacHex(secret, `${scope}.${exp}`)}`;
}
/** 校验:签名(常数时间)+ 未过期 + **有效期不超过该 scope 的上限**(C1:封死自选遥远 exp) */
async function verifyToken(secret: string | null, scope: string, token: string | undefined, maxTtlMs: number): Promise<{ ok: boolean; sig?: string }> {
  if (!secret || !token) return { ok: false };
  const [expStr, sig] = token.split('.');
  const exp = Number(expStr);
  const now = Date.now();
  if (!Number.isFinite(exp) || !sig) return { ok: false };
  if (exp < now || exp > now + maxTtlMs + 60_000) return { ok: false }; // 上限 + 60s 时钟宽容
  return { ok: timingSafeEqualHex(await hmacHex(secret, `${scope}.${exp}`), sig), sig };
}

async function hasValidBypass(c: Context<{ Bindings: Env }>): Promise<boolean> {
  const r = await verifyToken(bypassSecret(c.env), 'bp', getCookie(c, BYPASS_COOKIE), BYPASS_COOKIE_TTL_MS);
  return r.ok;
}

// ---------- 拦截页与统计 ----------

function pathClass(p: string): string {
  if (p === '/' || p === '') return 'home';
  const seg = p.split('/').filter(Boolean)[0] ?? 'other';
  return seg.slice(0, 24);
}

/** HTML 文本转义;引号一并转(L1:防未来搬进属性上下文时静默变成注入点) */
const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

function blockPageHtml(r: GeoRules): string {
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(r.blockPage.title.en)}</title><style>html{background:#0a0a0b;color:#b9b9c0;font:15px/1.7 system-ui,sans-serif}body{display:flex;min-height:96vh;align-items:center;justify-content:center;margin:0;padding:20px}main{max-width:520px;text-align:center}h1{color:#f2f2f3;font-size:19px;margin:0 0 6px}p{margin:4px 0}</style></head><body><main><h1>${esc(r.blockPage.title.zh)}</h1><p>${esc(r.blockPage.body.zh)}</p><hr style="border:0;border-top:1px solid #232329;margin:14px 0"><h1 style="font-size:16px">${esc(r.blockPage.title.en)}</h1><p>${esc(r.blockPage.body.en)}</p></main></body></html>`;
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
      const log = c.env.DB.prepare('INSERT INTO raw_events (ts, type, uid, payload) VALUES (?1, ?2, NULL, ?3)')
        .bind(Date.now(), 'blocked', JSON.stringify({ t: 'blocked', c: country, p: pathClass(path) }))
        .run()
        .then(() => {})
        .catch(() => {}); // 统计失败不影响拦截本体
      try {
        c.executionCtx.waitUntil(log); // 生产:后台落库不拖响应
      } catch {
        await log; // 测试环境无 ExecutionContext:同步等待
      }
    }
    return c.html(blockPageHtml(rules), 451);
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
  // M2 一次性:兑换后标记 jti(= 签名),重放即拒
  const jti = `bp:used:${r.sig}`;
  try {
    if (await c.env.KV.get(jti)) return c.text('bypass token already used', 403);
    await c.env.KV.put(jti, '1', { expirationTtl: 600 }); // > 令牌 5 分钟窗口
  } catch {
    /* KV 异常不阻断兑换(签名与时效仍在);重放窗口退化为 5 分钟 */
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

const HIGH_TRAFFIC_SHARE = 0.05; // E2 护栏:新增国家近 7 天流量占比 ≥5% 须显式确认

/** PUT body 契约(L2:按 §3「一切写接口 zod 校验」补) */
const TriPage = z.object({
  title: z.object({ zh: z.string().min(1).max(120), en: z.string().min(1).max(120) }),
  body: z.object({ zh: z.string().min(1).max(300), en: z.string().min(1).max(300) }),
});
const GeoPutSchema = z.object({
  enabled: z.boolean(),
  countries: z.array(z.string().regex(/^[A-Z]{2}$/)).max(249),
  blockPage: TriPage.optional(),
  reason: z.string().trim().min(8),
  confirmHighTraffic: z.boolean().optional(),
});

async function trafficShares(db: D1Database): Promise<Map<string, number>> {
  const rows = await db
    .prepare("SELECT country, SUM(pv) AS pv FROM daily_traffic WHERE date >= date('now', '-7 day') GROUP BY country")
    .all<{ country: string; pv: number }>();
  const total = rows.results.reduce((s, r) => s + r.pv, 0);
  return new Map(rows.results.map((r) => [r.country, total ? r.pv / total : 0]));
}

export const geoRoutes = new Hono<{ Bindings: Env }>();

geoRoutes.get('/', async (c) => {
  const { rules, degraded } = await loadRules(c.env);
  const last7 = await c.env.DB
    .prepare("SELECT country, SUM(hits) AS hits FROM daily_blocked WHERE date >= date('now', '-7 day') GROUP BY country ORDER BY hits DESC LIMIT 20")
    .all<{ country: string; hits: number }>();
  const pv7 = await c.env.DB
    .prepare("SELECT COALESCE(SUM(pv),0) AS pv FROM daily_traffic WHERE date >= date('now', '-7 day')")
    .first<{ pv: number }>();
  const todayLive = await c.env.DB
    .prepare("SELECT COUNT(*) AS n FROM raw_events WHERE type='blocked' AND ts >= ?1")
    .bind(Date.parse(new Date().toISOString().slice(0, 10) + 'T00:00:00Z'))
    .first<{ n: number }>();
  const blocked7 = last7.results.reduce((s, r) => s + r.hits, 0);
  return c.json({
    rules,
    degraded,
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
  const page = body.blockPage ?? DEFAULT_PAGE;
  const { rules: cur } = await loadRules(c.env);
  const added = body.countries.filter((x) => !cur.countries.includes(x));
  if (!body.confirmHighTraffic) {
    const shares = await trafficShares(c.env.DB);
    const hot = added.filter((x) => (shares.get(x) ?? 0) >= HIGH_TRAFFIC_SHARE).map((x) => ({ country: x, share: shares.get(x)! }));
    if (hot.length) return c.json({ error: 'need-confirm-high-traffic', hot }, 409); // E2 误伤护栏
  }
  const next: GeoRules = { enabled: body.enabled, countries: body.countries, blockPage: page, updatedAt: Date.now(), updatedBy: 'admin' };
  await c.env.KV.put(KV_KEY, JSON.stringify(next));
  resetGeoCache();
  const back = await c.env.KV.get(KV_KEY); // 回读确认(⑤:写失败不装成功)
  if (back !== JSON.stringify(next)) return c.json({ error: 'kv-readback-mismatch(线上仍为旧规则)' }, 500);
  // M3:拦截页文案变化也要进审计摘要——否则「只改文案」的变更在审计里看起来什么都没变
  const pageChanged = JSON.stringify(cur.blockPage) !== JSON.stringify(page);
  const summary = (r: GeoRules) => `enabled=${r.enabled} [${r.countries.join(',')}] page=${JSON.stringify(r.blockPage).length}B`;
  await writeAudit(c.env.DB, {
    action: 'geo.update',
    target: 'geo:rules',
    before: summary(cur),
    after: `${summary(next)}${pageChanged ? ' (拦截页文案已改)' : ''}`,
    reason: body.reason.trim(),
  });
  return c.json({ ok: true, rules: next });
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
