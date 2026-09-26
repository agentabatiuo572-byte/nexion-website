/**
 * 挑战闸核心(规格 FEAT-ANTIBOT01 §3.3)。
 *
 * 纯逻辑 + 可注入依赖:不直接依赖 Hono / 路由,判定与签发在这里,动作由中间件执行。
 * 三条纪律:
 *  1. 挑战未通过永不签 cookie;cookie 只由服务端签发,客户端不可自造。
 *  2. 密钥缺失或在生产仍为仓库内 dev 默认值 → 视为 degraded,由 failMode 决定放行/拦截。
 *  3. 挑战页不含任何站点正文;`returnTo` 只接受同源相对路径。
 */
import type { CrawlerClass } from './aibot';
import { isBlockedClass } from './aibot';
import { timingSafeEqualHex } from './auth';
import { createLimiter } from './ratelimit';
import { GATE_LIST_VERSION_MAX, GATE_REASONS, GATE_VERDICTS } from '../../schema/src/event-contract';

export const GATE_COOKIE_NAME = 'ng_gate';
export const GATE_POLICY_KEY = 'gate:policy';
export const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

const COOKIE_VERSION = 'v1';
const DEV_GATE_SECRET = 'dev-gate-secret';
const SIM_ENVS = new Set(['dev', 'preview']);
const CLOCK_SKEW_MS = 5 * 60_000;

export type GateMode = 'monitor' | 'enforce' | 'off';
export type GateFailMode = 'open' | 'closed';
export type GateBindMode = 'ua' | 'ua+subnet' | 'none';
export type GateLocale = 'en' | 'vi' | 'zh';
/** 判定与原因单源在 schema 事件契约(rollup 形状校验同源)。 */
export type GateVerdict = (typeof GATE_VERDICTS)[number];
export type GateReason = (typeof GATE_REASONS)[number];

export interface GatePolicy {
  mode: GateMode;
  failMode: GateFailMode;
  cookieTtlMs: number;
  bindMode: GateBindMode;
  socialAllow: boolean;
  listVersion: number;
}

export const DEFAULT_GATE_POLICY: GatePolicy = {
  mode: 'monitor',
  failMode: 'open',
  cookieTtlMs: 7 * 24 * 3_600_000,
  bindMode: 'ua+subnet',
  socialAllow: true,
  listVersion: 1,
};

// ---------- 策略装载(KV 可覆盖;读失败回默认值并标 degraded) ----------

let policyCache: { policy: GatePolicy; degraded: boolean; ts: number } | null = null;
const POLICY_CACHE_MS = 30_000;

export function resetGatePolicyCache(): void {
  policyCache = null;
}

function normalizePolicy(raw: unknown): GatePolicy {
  const source = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const policy: GatePolicy = { ...DEFAULT_GATE_POLICY };
  if (source.mode === 'monitor' || source.mode === 'enforce' || source.mode === 'off') policy.mode = source.mode;
  if (source.failMode === 'open' || source.failMode === 'closed') policy.failMode = source.failMode;
  if (typeof source.cookieTtlMs === 'number' && Number.isFinite(source.cookieTtlMs) && source.cookieTtlMs >= 60_000 && source.cookieTtlMs <= 90 * 24 * 3_600_000) policy.cookieTtlMs = Math.floor(source.cookieTtlMs);
  if (source.bindMode === 'ua' || source.bindMode === 'ua+subnet' || source.bindMode === 'none') policy.bindMode = source.bindMode;
  if (typeof source.socialAllow === 'boolean') policy.socialAllow = source.socialAllow;
  if (typeof source.listVersion === 'number' && Number.isSafeInteger(source.listVersion) && source.listVersion > 0 && source.listVersion <= GATE_LIST_VERSION_MAX) policy.listVersion = source.listVersion;
  return policy;
}

export async function loadGatePolicy(kv: KVNamespace | undefined): Promise<{ policy: GatePolicy; degraded: boolean }> {
  const now = Date.now();
  if (policyCache && now - policyCache.ts < POLICY_CACHE_MS) return { policy: policyCache.policy, degraded: policyCache.degraded };
  let policy = DEFAULT_GATE_POLICY;
  let degraded = false;
  try {
    const raw = kv ? await kv.get(GATE_POLICY_KEY) : null;
    if (raw) policy = normalizePolicy(JSON.parse(raw));
  } catch {
    degraded = true;
  }
  policyCache = { policy, degraded, ts: now };
  return { policy, degraded };
}

// ---------- 密钥 ----------

/** 生产环境仍使用仓库内 dev 默认密钥 = 未轮换 → 不可信,走 degraded。 */
export function resolveGateSecret(env: { GATE_SECRET?: string; ENVIRONMENT: string }): { secret: string | null; degraded: boolean } {
  const secret = env.GATE_SECRET ?? '';
  if (!secret) return { secret: null, degraded: true };
  if (!SIM_ENVS.has(env.ENVIRONMENT) && secret === DEV_GATE_SECRET) return { secret: null, degraded: true };
  return { secret, degraded: false };
}

/** Cloudflare 官方测试密钥(永远通过);出现在非 dev/preview 环境 = 未轮换 → degraded。 */
const DEV_TURNSTILE_SECRET = '1x0000000000000000000000000000000AA';

export function resolveTurnstile(env: {
  TURNSTILE_SECRET?: string;
  TURNSTILE_SITE_KEY?: string;
  ENVIRONMENT: string;
}): { secret: string | null; siteKey: string; degraded: boolean } {
  const secret = env.TURNSTILE_SECRET ?? '';
  const siteKey = env.TURNSTILE_SITE_KEY ?? '';
  if (!secret || !siteKey) return { secret: null, siteKey, degraded: true };
  if (!SIM_ENVS.has(env.ENVIRONMENT) && secret === DEV_TURNSTILE_SECRET) return { secret: null, siteKey, degraded: true };
  return { secret, siteKey, degraded: false };
}

// ---------- 通行证 cookie ----------

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function hmacHex(secret: string, input: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(input));
  return [...new Uint8Array(signature)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** IPv4 取 /24,IPv6 取前 48 位(展开 `::` 后前三段,跨写法归一);非法值给稳定占位。 */
export function ipSubnet(ip: string): string {
  const value = ip.trim().toLowerCase();
  if (!value) return 'unknown';
  // IPv4-mapped IPv6(::ffff:1.2.3.4)按 IPv4 处理,否则绑定退化成同一子网
  const mapped = value.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (mapped) return ipSubnet(mapped[1]);
  if (value.includes(':')) {
    const groups = expandIpv6(value);
    if (!groups) return 'unknown';
    return `v6:${groups.slice(0, 3).join(':')}`;
  }
  const parts = value.split('.');
  if (parts.length === 4 && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255)) return `${parts[0]}.${parts[1]}.${parts[2]}.0/24`;
  return 'unknown';
}

/** 展开 IPv6 为 8 段并去前导零;非法返回 null。 */
function expandIpv6(value: string): string[] | null {
  const [head, tail, ...rest] = value.split('::');
  if (rest.length > 0) return null;
  const headGroups = head ? head.split(':').filter(Boolean) : [];
  const tailGroups = tail !== undefined && tail !== '' ? tail.split(':').filter(Boolean) : [];
  let groups: string[];
  if (tail === undefined) {
    groups = value.split(':').filter(Boolean);
    if (groups.length !== 8) return null;
  } else {
    const fill = 8 - headGroups.length - tailGroups.length;
    if (fill < 0) return null;
    groups = [...headGroups, ...Array(fill).fill('0'), ...tailGroups];
  }
  if (groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return null;
  return groups.map((group) => group.replace(/^0+(?=.)/, ''));
}

export async function computeBinding(bindMode: GateBindMode, ua: string, ip: string): Promise<string> {
  if (bindMode === 'none') return 'none';
  const uaHash = (await sha256Hex(ua)).slice(0, 16);
  if (bindMode === 'ua') return uaHash;
  return (await sha256Hex(`${uaHash}|${ipSubnet(ip)}`)).slice(0, 16);
}

export interface GateCookieContext {
  ua: string;
  ip: string;
  bindMode: GateBindMode;
  ttlMs: number;
  now?: number;
}

export async function signGateCookie(secret: string, ctx: GateCookieContext): Promise<string> {
  const issuedAt = ctx.now ?? Date.now();
  const binding = await computeBinding(ctx.bindMode, ctx.ua, ctx.ip);
  const signature = await hmacHex(secret, `${COOKIE_VERSION}|${issuedAt}|${binding}`);
  return `${COOKIE_VERSION}.${issuedAt}.${binding}.${signature}`;
}

export type GateCookieFailure = 'malformed' | 'expired' | 'mismatch' | 'bad_signature';

export async function verifyGateCookie(
  secret: string,
  value: string | null | undefined,
  ctx: GateCookieContext,
): Promise<{ ok: true } | { ok: false; reason: GateCookieFailure }> {
  if (!value) return { ok: false, reason: 'malformed' };
  const parts = value.split('.');
  if (parts.length !== 4 || parts[0] !== COOKIE_VERSION) return { ok: false, reason: 'malformed' };
  const issuedAt = Number(parts[1]);
  const now = ctx.now ?? Date.now();
  if (!Number.isFinite(issuedAt) || issuedAt <= 0 || !Number.isSafeInteger(issuedAt)) return { ok: false, reason: 'malformed' };
  if (now - issuedAt > ctx.ttlMs) return { ok: false, reason: 'expired' };
  if (issuedAt - now > CLOCK_SKEW_MS) return { ok: false, reason: 'malformed' };
  const binding = await computeBinding(ctx.bindMode, ctx.ua, ctx.ip);
  if (parts[2] !== binding) return { ok: false, reason: 'mismatch' };
  const expected = await hmacHex(secret, `${COOKIE_VERSION}|${parts[1]}|${parts[2]}`);
  if (!timingSafeEqualHex(parts[3], expected)) return { ok: false, reason: 'bad_signature' };
  return { ok: true };
}

/** 只读 cookie 头;不解析其它 cookie 语义。 */
export function readCookie(header: string | null | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    return part.slice(separator + 1).trim() || null;
  }
  return null;
}

export function gateCookieValue(value: string, ttlMs: number, secure: boolean): string {
  const maxAge = Math.floor(ttlMs / 1000);
  return `${GATE_COOKIE_NAME}=${value}; Path=/; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}; Max-Age=${maxAge}`;
}

// ---------- 判定 ----------

export interface GateDecisionInput {
  klass: CrawlerClass;
  socialAllow: boolean;
  cookieValid: boolean;
  bypass: boolean;
  degraded: boolean;
}

export interface GateDecision {
  intent: GateVerdict;
  reason: GateReason;
}

export function decideGate(input: GateDecisionInput): GateDecision {
  if (input.bypass) return { intent: 'pass', reason: 'bypass_internal' };
  // 名单拦截不依赖通行证密钥:即使闸降级,已知 AI/搜索引擎仍不放行。
  if (isBlockedClass(input.klass)) {
    return { intent: 'block', reason: input.klass === 'search_engine' ? 'search_engine_ua' : 'ai_bot_ua' };
  }
  if (input.degraded) return { intent: 'pass', reason: 'gate_degraded' };
  if (input.cookieValid) return { intent: 'pass', reason: 'cookie_valid' };
  if (input.klass === 'social_preview' && input.socialAllow) return { intent: 'pass', reason: 'whitelist_social' };
  return { intent: 'challenge', reason: 'challenge_issued' };
}

/** 豁免路径不进闸(自锁保护 / 声明文件 / 资产)。🔴 文档类(pdf)是正文内容,不豁免。 */
const ASSET_EXTENSION = /\.(?:js|mjs|css|map|json|webp|png|jpg|jpeg|gif|svg|ico|woff2?|ttf|otf|mp4|webm|avif|zip)$/i;

export function isGateExemptPath(pathname: string): boolean {
  if (pathname === '/admin' || pathname.startsWith('/admin/')) return true;
  if (pathname === '/api' || pathname.startsWith('/api/')) return true;
  if (pathname === '/robots.txt') return true;
  if (pathname.startsWith('/sitemap')) return true;
  if (pathname.startsWith('/.well-known/')) return true;
  if (pathname.startsWith('/__gate/')) return true;
  return ASSET_EXTENSION.test(pathname);
}

// ---------- returnTo 消毒 ----------

export function sanitizeReturnTo(value: unknown): string {
  if (typeof value !== 'string') return '/';
  if (value.length === 0 || value.length > 512) return '/';
  if (!value.startsWith('/') || value.startsWith('//')) return '/';
  if (value.includes('\\')) return '/';
  if (/[\u0000-\u001f\u007f]/.test(value)) return '/';
  return value;
}

// ---------- Turnstile ----------

export async function verifyTurnstileToken(
  secret: string,
  token: string,
  ip: string | null,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 5_000,
): Promise<{ ok: boolean; code?: string }> {
  try {
    const body = new URLSearchParams({ secret, response: token });
    if (ip) body.set('remoteip', ip);
    const response = await fetchImpl(TURNSTILE_VERIFY_URL, { method: 'POST', body, signal: AbortSignal.timeout(timeoutMs) });
    const data = (await response.json()) as { success?: boolean; 'error-codes'?: string[] };
    return data.success ? { ok: true } : { ok: false, code: data['error-codes']?.[0] ?? 'unknown' };
  } catch {
    return { ok: false, code: 'network' };
  }
}

// ---------- 限速(每 isolate 近似值,与采集同语义) ----------

export const challengeLimiter = createLimiter(60_000, 30);
export const verifyLimiter = createLimiter(60_000, 10);

export function resetGateLimiters(): void {
  challengeLimiter.reset();
  verifyLimiter.reset();
}

// ---------- 挑战页(不含站点正文;自包含,只依赖 Turnstile 脚本域) ----------

interface ChallengeStrings {
  title: string;
  why: string;
  checking: string;
  verifying: string;
  failed: string;
  network: string;
  cooling: string;
  retry: string;
  hint: string;
  noscript: string;
}

const STRINGS: Record<GateLocale, ChallengeStrings> = {
  en: {
    title: 'Verifying your browser',
    why: 'Why am I seeing this?',
    checking: 'Just a moment…',
    verifying: 'Almost done…',
    failed: 'Verification failed. Please try again.',
    network: 'Network error. Please check your connection and retry.',
    cooling: 'Too many attempts. Please try again in a little while.',
    retry: 'Retry',
    hint: 'This quick check helps us block automated traffic. It only takes a moment.',
    noscript: 'JavaScript is required to verify your browser. Enable JavaScript and reload this page.',
  },
  vi: {
    title: 'Đang xác minh trình duyệt',
    why: 'Tại sao tôi thấy trang này?',
    checking: 'Vui lòng chờ trong giây lát…',
    verifying: 'Sắp xong…',
    failed: 'Xác minh không thành công. Vui lòng thử lại.',
    network: 'Lỗi mạng. Vui lòng kiểm tra kết nối và thử lại.',
    cooling: 'Quá nhiều lần thử. Vui lòng thử lại sau ít phút.',
    retry: 'Thử lại',
    hint: 'Bước kiểm tra nhanh này giúp chúng tôi chặn lưu lượng tự động. Chỉ mất một lát.',
    noscript: 'Cần bật JavaScript để xác minh trình duyệt. Hãy bật JavaScript và tải lại trang.',
  },
  zh: {
    title: '正在验证您的浏览器',
    why: '为什么看到这个页面?',
    checking: '请稍候…',
    verifying: '即将完成…',
    failed: '验证失败,请重试。',
    network: '网络异常,请检查网络后重试。',
    cooling: '尝试次数过多,请稍后再试。',
    retry: '重试',
    hint: '这是一道用于拦截自动化流量的快速校验,只需片刻。',
    noscript: '需要启用 JavaScript 才能完成浏览器验证,请启用后刷新页面。',
  },
};

const escapeHtml = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const json = (value: string): string => JSON.stringify(value).replace(/</g, '\\u003c');

export interface ChallengePageOptions {
  locale: GateLocale;
  returnTo: string;
  siteKey: string;
  /** 挑战签发被限速时的冷却开场(秒);页面以倒计时开场,结束后自动重试 */
  coolingSeconds?: number;
}

export function challengePageHtml(options: ChallengePageOptions): string {
  const t = STRINGS[options.locale] ?? STRINGS.en;
  const returnTo = sanitizeReturnTo(options.returnTo);
  const coolingSeconds = typeof options.coolingSeconds === 'number' && Number.isFinite(options.coolingSeconds) && options.coolingSeconds > 0 ? Math.floor(options.coolingSeconds) : 0;
  return `<!doctype html><html lang="${options.locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${escapeHtml(t.title)}</title><style>html{background:#0a0a0b;color:#b9b9c0;font:15px/1.7 system-ui,-apple-system,sans-serif}body{display:flex;min-height:96vh;align-items:center;justify-content:center;margin:0;padding:20px}main{width:100%;max-width:420px;text-align:center}.mark{color:#f2f2f3;font-weight:600;letter-spacing:.04em;margin:0 0 18px}h1{color:#f2f2f3;font-size:18px;margin:0 0 8px}p{margin:6px 0}#g-ts{display:flex;justify-content:center;margin:14px 0;min-height:66px}button{background:#9EDC1D;color:#0a0a0b;border:0;border-radius:8px;padding:10px 22px;font:inherit;font-weight:600;cursor:pointer}button[hidden]{display:none}button[disabled]{opacity:.5;cursor:default}details{color:#7d7d86;font-size:13px;margin-top:14px;text-align:left}summary{cursor:pointer;color:#b9b9c0}details p{margin:6px 0 0}.ns{color:#b9b9c0;border:1px solid #2a2a2e;border-radius:8px;padding:12px;margin-top:16px}</style></head><body><main><p class="mark">Uvel</p><h1>${escapeHtml(t.title)}</h1><p id="g-msg" role="status" aria-live="polite">${escapeHtml(t.checking)}</p><div id="g-ts"></div><button id="g-retry" type="button" hidden>${escapeHtml(t.retry)}</button><details id="g-why"><summary>${escapeHtml(t.why)}</summary><p class="hint">${escapeHtml(t.hint)}</p></details><noscript><p class="ns">${escapeHtml(t.noscript)}</p></noscript></main><script>(function(){var returnTo=${json(returnTo)},siteKey=${json(options.siteKey)},coolingSeconds=${coolingSeconds},msg=document.getElementById('g-msg'),retry=document.getElementById('g-retry'),widget=null,s={checking:${json(t.checking)},verifying:${json(t.verifying)},failed:${json(t.failed)},network:${json(t.network)},cooling:${json(t.cooling)},retry:${json(t.retry)}};function setMsg(x,show){msg.textContent=x;retry.hidden=!show;retry.disabled=false}function fail(code,retryAfter){if(code==='rate_limited'){cool(Math.max(1,retryAfter||60));return}setMsg(code==='network'?s.network:s.failed,true)}function cool(seconds){var n=seconds;setMsg(s.cooling,false);retry.hidden=false;retry.disabled=true;(function tick(){retry.textContent=s.retry+' ('+n+')';if(n<=0){retry.disabled=false;retry.textContent=s.retry;mount(1);return}n--;setTimeout(tick,1000)})()}function onToken(token){setMsg(s.verifying,false);var settled=false,timer=setTimeout(function(){if(settled)return;settled=true;fail('network')},8000);fetch('/__gate/verify',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token:token,returnTo:returnTo})}).then(function(r){return r.json().then(function(b){return{ok:r.ok&&b&&b.ok===true,code:b&&b.code,retryAfter:b&&b.retryAfter}})}).then(function(res){if(settled)return;settled=true;clearTimeout(timer);if(res.ok){location.replace(returnTo)}else{fail(res.code,res.retryAfter)}}).catch(function(){if(settled)return;settled=true;clearTimeout(timer);fail('network')})}function mount(attempt){if(window.turnstile){if(widget===null){widget=window.turnstile.render('#g-ts',{sitekey:siteKey,callback:onToken,'error-callback':function(){fail('error')},'expired-callback':function(){fail('expired')}})}else{window.turnstile.reset(widget)}return}if(attempt>50){fail('network');return}setTimeout(function(){mount(attempt+1)},200)}retry.addEventListener('click',function(){setMsg(s.checking,false);mount(1)});if(coolingSeconds>0){cool(coolingSeconds)}else{mount(1)}})();</script><script src="https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit" async defer></script></body></html>`;
}

export function challengePageHeaders(): Record<string, string> {
  return {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Robots-Tag': 'noindex',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy':
      "default-src 'none'; script-src 'unsafe-inline' https://challenges.cloudflare.com; style-src 'unsafe-inline'; frame-src https://challenges.cloudflare.com; connect-src 'self' https://challenges.cloudflare.com; img-src data:; base-uri 'none'; form-action 'none'",
  };
}
