import { Hono } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import type { Context, MiddlewareHandler } from 'hono';
import type { Env } from './env';
import { writeAudit } from './audit';

/* 区域屏蔽(PRD CON12)。两条通道原则(§2.3):规则走 KV 即时生效,不经发布链。
   自锁保护(E1):/admin 与 /api 前缀恒不拦(V1-dev 同域路径制;Phase C 子域后可收紧 /api 面);
   直通 cookie 放行且不计统计。兜底(E3):KV 读取异常 → 内置基线名单 CN 生效(不失守不误伤全站)。
   模拟(E4):x-geo-sim 头仅在非 production 环境生效。 */

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
let cache: { rules: GeoRules; degraded: boolean; ts: number } | null = null;
export function resetGeoCache(): void {
  cache = null;
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
async function hmacHex(secret: string, msg: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(msg));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
async function mintToken(secret: string, scope: string, ttlMs: number): Promise<string> {
  const exp = Date.now() + ttlMs;
  return `${exp}.${await hmacHex(secret, `${scope}.${exp}`)}`;
}
async function verifyToken(secret: string, scope: string, token: string | undefined): Promise<boolean> {
  if (!token) return false;
  const [expStr, sig] = token.split('.');
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || exp < Date.now() || !sig) return false;
  return (await hmacHex(secret, `${scope}.${exp}`)) === sig;
}

const BYPASS_COOKIE = 'gx_bypass';

async function hasValidBypass(c: Context<{ Bindings: Env }>): Promise<boolean> {
  return verifyToken(c.env.BYPASS_SECRET ?? '', 'bp', getCookie(c, BYPASS_COOKIE));
}

// ---------- 拦截页与统计 ----------

function pathClass(p: string): string {
  if (p === '/' || p === '') return 'home';
  const seg = p.split('/').filter(Boolean)[0] ?? 'other';
  return seg.slice(0, 24);
}

function blockPageHtml(r: GeoRules): string {
  const e = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${e(r.blockPage.title.en)}</title><style>html{background:#0a0a0b;color:#b9b9c0;font:15px/1.7 system-ui,sans-serif}body{display:flex;min-height:96vh;align-items:center;justify-content:center;margin:0;padding:20px}main{max-width:520px;text-align:center}h1{color:#f2f2f3;font-size:19px;margin:0 0 6px}p{margin:4px 0}</style></head><body><main><h1>${e(r.blockPage.title.zh)}</h1><p>${e(r.blockPage.body.zh)}</p><hr style="border:0;border-top:1px solid #232329;margin:14px 0"><h1 style="font-size:16px">${e(r.blockPage.title.en)}</h1><p>${e(r.blockPage.body.en)}</p></main></body></html>`;
}

/** 边缘拦截中间件——挂在一切路由之前(index.ts) */
export const geoMiddleware: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  const path = new URL(c.req.url).pathname;
  if (path === '/admin' || path.startsWith('/admin/') || path.startsWith('/api/')) return next(); // E1 自锁保护 + API 面
  const { rules } = await loadRules(c.env);
  if (!rules.enabled) return next();
  const sim = c.env.ENVIRONMENT !== 'production' ? c.req.header('x-geo-sim') : undefined; // E4:生产恒忽略
  const country = (sim || (c.req.raw.cf?.country as string | undefined) || c.req.header('cf-ipcountry') || 'XX').toUpperCase();
  if (!rules.countries.includes(country)) return next();
  if (await hasValidBypass(c)) return next(); // 直通放行且不计统计
  const wantsHtml = (c.req.header('accept') ?? '').includes('text/html');
  if (wantsHtml) {
    // 仅文档请求入统计分桶(CON12-③;资产噪声不计)
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
    return c.html(blockPageHtml(rules), 451);
  }
  return c.body(null, 451);
};

// ---------- 站域直通兑换(公开;令牌来自控制台签发) ----------

export const bypassExchange = new Hono<{ Bindings: Env }>();
bypassExchange.get('/', async (c) => {
  const ok = await verifyToken(c.env.BYPASS_SECRET ?? '', 'bt', c.req.query('t'));
  if (!ok) return c.text('bypass token invalid or expired', 403);
  setCookie(c, BYPASS_COOKIE, await mintToken(c.env.BYPASS_SECRET ?? '', 'bp', 30 * 24 * 3600_000), {
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    path: '/',
    maxAge: 30 * 24 * 3600,
  });
  return c.redirect('/');
});

// ---------- 控制台规则 API(requireAuth 由挂载处保证) ----------

const HIGH_TRAFFIC_SHARE = 0.05; // E2 护栏:新增国家近 7 天流量占比 ≥5% 须显式确认

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
    stats: {
      last7: last7.results,
      todayLive: todayLive?.n ?? 0,
      blocked7,
      shareOfRequests: blocked7 + (pv7?.pv ?? 0) > 0 ? blocked7 / (blocked7 + (pv7?.pv ?? 0)) : 0, // 口径:拦截文档数/(拦截+人类 pv)
    },
  });
});

geoRoutes.put('/', async (c) => {
  const body = await c.req
    .json<{ enabled?: boolean; countries?: string[]; blockPage?: GeoRules['blockPage']; reason?: string; confirmHighTraffic?: boolean }>()
    .catch(() => null);
  if (!body || typeof body.enabled !== 'boolean' || !Array.isArray(body.countries)) return c.json({ error: 'bad-request' }, 400);
  if (!body.reason || body.reason.trim().length < 8) return c.json({ error: 'reason-required(≥8 字)' }, 400);
  if (!body.countries.every((x) => /^[A-Z]{2}$/.test(x))) return c.json({ error: 'bad-country-code' }, 400);
  const page = body.blockPage ?? DEFAULT_PAGE;
  for (const loc of ['zh', 'en'] as const) {
    if (!page.title[loc]?.trim() || !page.body[loc]?.trim()) return c.json({ error: 'block-page-required(zh+en)' }, 400);
    if (page.title[loc].length > 120 || page.body[loc].length > 300) return c.json({ error: 'block-page-too-long' }, 400);
  }
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
  await writeAudit(c.env.DB, {
    action: 'geo.update',
    target: 'geo:rules',
    before: `enabled=${cur.enabled} [${cur.countries.join(',')}]`,
    after: `enabled=${next.enabled} [${next.countries.join(',')}]`,
    reason: body.reason.trim(),
  });
  return c.json({ ok: true, rules: next });
});

/** 直通令牌签发(登录态换 5 分钟令牌;审计留痕) */
geoRoutes.post('/bypass-token', async (c) => {
  const t = await mintToken(c.env.BYPASS_SECRET ?? '', 'bt', 5 * 60_000);
  await writeAudit(c.env.DB, { action: 'bypass.issue', target: 'admin' });
  return c.json({ url: `/api/bypass?t=${encodeURIComponent(t)}`, expiresInSec: 300 });
});
