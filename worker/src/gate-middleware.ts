/**
 * 挑战闸中间件与校验端点(规格 FEAT-ANTIBOT01 §3.3)。
 *
 * 挂在 locale → geo 之后、路由/静态之前。行为:
 *  - monitor:只记「会被拦 / 已降级」,不改响应;enforce:block → 403,challenge → 挑战壳。
 *  - 豁免路径(admin/api/robots/sitemap/.well-known/资产)直通,robots.txt 永不被拦。
 *  - 事件只写 block / degraded:匿名 challenge 是默认态,写它只会把 raw_events 刷爆。
 *  - 名单拦截不依赖通行证密钥;闸降级时按 failMode 放行(fail-open)或 503(fail-closed)。
 */
import { Hono } from 'hono';
import type { Context, MiddlewareHandler } from 'hono';
import { GATE_EVENT_TYPE, METRIC_TEXT_BYTES } from '../../schema/src/event-contract';
import { truncateUtf8 } from '../../schema/src/utf8';
import { classifyCrawler } from './aibot';
import type { Env } from './env';
import {
  GATE_COOKIE_NAME,
  challengeLimiter,
  challengePageHeaders,
  challengePageHtml,
  decideGate,
  gateCookieValue,
  isGateExemptPath,
  loadGatePolicy,
  readCookie,
  resolveGateSecret,
  resolveTurnstile,
  sanitizeReturnTo,
  signGateCookie,
  verifyGateCookie,
  verifyLimiter,
  verifyTurnstileToken,
  type GateDecision,
  type GateLocale,
  type GatePolicy,
  type GateReason,
  type GateVerdict,
} from './gate';
import { hasValidBypass, pathClass } from './geo';
import { pathLocale } from './published-locales';
import { createLimiter } from './ratelimit';

const SIM_ENVS = new Set(['dev', 'preview']);
/** 事件写入节流(与 geo/采集同档);计数因此为下限 */
const gateLogLimiter = createLimiter(60_000, 120);
/** cookie_valid 放行采样:1 次/5 分钟/IP(逐页写会把 raw_events 刷爆;真人流量另有 beacon 核对) */
const passLogLimiter = createLimiter(300_000, 1);

/** 测试缝:替换 Turnstile siteverify 的 fetch(生产恒为全局 fetch)。 */
let verifyFetch: typeof fetch = fetch;
export function setTurnstileFetchForTests(fetchImpl: typeof fetch | null): void {
  verifyFetch = fetchImpl ?? fetch;
}

function gateLocale(pathname: string, acceptLanguage: string | undefined): GateLocale {
  const fromPath = pathLocale(pathname);
  if (fromPath === 'vi' || fromPath === 'zh') return fromPath;
  const tag = (acceptLanguage ?? '').toLowerCase();
  if (tag.startsWith('vi')) return 'vi';
  if (tag.startsWith('zh')) return 'zh';
  return 'en';
}

interface GateLogInput {
  reason: GateReason;
  intent: GateVerdict;
  crawlerName: string | null;
  policy: GatePolicy;
  pathname: string;
  enforced: boolean;
}

async function logGateEvent(c: Context<{ Bindings: Env }>, input: GateLogInput): Promise<void> {
  const ip = c.req.header('cf-connecting-ip') ?? 'unknown';
  if (gateLogLimiter.hit(ip)) return;
  const cf = c.req.raw.cf as { asn?: number } | undefined;
  const payload = {
    t: GATE_EVENT_TYPE,
    v: input.intent,
    r: input.reason,
    ua: truncateUtf8(input.crawlerName ?? '', METRIC_TEXT_BYTES.short),
    asn: typeof cf?.asn === 'number' ? cf.asn : null,
    p: pathClass(input.pathname),
    lv: input.policy.listVersion,
    e: input.enforced ? 1 : 0,
  };
  const write = c.env.DB.prepare('INSERT INTO raw_events (ts, type, uid, payload) VALUES (?1, ?2, NULL, ?3)')
    .bind(Date.now(), 'gate', JSON.stringify(payload))
    .run()
    .then(() => {})
    .catch(() => {}); // 统计失败不影响闸本体
  try {
    c.executionCtx.waitUntil(write);
  } catch {
    await write;
  }
}

/** 观测口径(规格 §3.5):拦截/挑战/降级/社交/内部逐条(节流);cookie 放行按 1 次/5 分钟/IP 采样。 */
function shouldLogDecision(decision: GateDecision, ip: string): boolean {
  if (decision.intent === 'block' || decision.intent === 'challenge') return true;
  if (decision.reason === 'gate_degraded') return true;
  if (decision.reason === 'whitelist_social' || decision.reason === 'bypass_internal') return true;
  if (decision.reason === 'cookie_valid') return !passLogLimiter.hit(ip); // hit=true 表示已超采样额度 → 跳过
  return false;
}

export const gateMiddleware: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  const url = new URL(c.req.url);
  const pathname = url.pathname;
  if (isGateExemptPath(pathname)) return next();

  const { policy, degraded: policyDegraded } = await loadGatePolicy(c.env.KV);
  if (policy.mode === 'off') return next();

  const ua = c.req.header('user-agent') ?? '';
  const ip = c.req.header('cf-connecting-ip') ?? 'unknown';
  const { secret } = resolveGateSecret(c.env);
  const turnstile = resolveTurnstile(c.env);
  const degraded = !secret || turnstile.degraded || policyDegraded;

  let cookieValid = false;
  if (secret) {
    const result = await verifyGateCookie(secret, readCookie(c.req.header('cookie'), GATE_COOKIE_NAME), {
      ua,
      ip,
      bindMode: policy.bindMode,
      ttlMs: policy.cookieTtlMs,
    });
    cookieValid = result.ok;
  }

  const bypass = await hasValidBypass(c);
  const crawler = classifyCrawler(ua);
  const decision = decideGate({
    klass: crawler.klass,
    socialAllow: policy.socialAllow,
    cookieValid,
    bypass,
    degraded,
  });

  const enforced = policy.mode === 'enforce';
  // e = 服务端实际执行了拦截/挑战(monitor 或降级放行都是 0)
  const enforcedAction = enforced && (decision.intent === 'block' || decision.intent === 'challenge');
  if (shouldLogDecision(decision, ip)) {
    await logGateEvent(c, {
      reason: decision.reason,
      intent: decision.intent,
      crawlerName: crawler.name,
      policy,
      pathname,
      enforced: enforcedAction,
    });
  }

  if (!enforced) return next();
  if (decision.intent === 'block') return c.body(null, 403);
  if (degraded) {
    return policy.failMode === 'closed'
      ? c.text('Service temporarily unavailable', 503, { 'Cache-Control': 'no-store' })
      : next();
  }
  if (decision.intent === 'challenge') {
    const locale = gateLocale(pathname, c.req.header('accept-language'));
    const returnTo = sanitizeReturnTo(pathname + url.search);
    if (challengeLimiter.hit(ip)) {
      return c.html(challengePageHtml({ locale, returnTo, siteKey: turnstile.siteKey, coolingSeconds: 60 }), 429, {
        ...challengePageHeaders(),
        'Retry-After': '60',
      });
    }
    return c.html(challengePageHtml({ locale, returnTo, siteKey: turnstile.siteKey }), 200, challengePageHeaders());
  }
  return next();
};

export const gateRoutes = new Hono<{ Bindings: Env }>();

gateRoutes.post('/verify', async (c) => {
  const ip = c.req.header('cf-connecting-ip') ?? 'unknown';
  const { policy } = await loadGatePolicy(c.env.KV);
  if (verifyLimiter.hit(ip)) {
    await logGateEvent(c, { reason: 'rate_limited', intent: 'challenge', crawlerName: null, policy, pathname: '/__gate/verify', enforced: true });
    return c.json({ ok: false, code: 'rate_limited', retryAfter: 60 }, 429, { 'Retry-After': '60', 'Cache-Control': 'no-store' });
  }

  const { secret } = resolveGateSecret(c.env);
  const turnstile = resolveTurnstile(c.env);
  if (!secret || !turnstile.secret) return c.json({ ok: false, code: 'gate_degraded' }, 503);

  let body: { token?: unknown; returnTo?: unknown };
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    return c.json({ ok: false, code: 'bad_request' }, 400);
  }
  const token = typeof body?.token === 'string' ? body.token : '';
  if (!token || token.length > 4096) return c.json({ ok: false, code: 'bad_request' }, 400);

  const result = await verifyTurnstileToken(turnstile.secret, token, ip === 'unknown' ? null : ip, verifyFetch);
  if (!result.ok) {
    await logGateEvent(c, { reason: 'turnstile_failed', intent: 'challenge', crawlerName: null, policy, pathname: '/__gate/verify', enforced: false });
    return c.json({ ok: false, code: result.code ?? 'turnstile_failed' }, 403);
  }

  const ua = c.req.header('user-agent') ?? '';
  const value = await signGateCookie(secret, { ua, ip, bindMode: policy.bindMode, ttlMs: policy.cookieTtlMs });
  return c.json({ ok: true, returnTo: sanitizeReturnTo(body.returnTo) }, 200, {
    'Set-Cookie': gateCookieValue(value, policy.cookieTtlMs, !SIM_ENVS.has(c.env.ENVIRONMENT)),
    'Cache-Control': 'no-store',
  });
});
