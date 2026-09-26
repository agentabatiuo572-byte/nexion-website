// FEAT-ANTIBOT01 §3.3 闸核心验收:cookie 签发/校验/绑定/过期、判定表、豁免、挑战页与 Turnstile 校验。
import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_GATE_POLICY,
  GATE_POLICY_KEY,
  challengePageHeaders,
  challengePageHtml,
  decideGate,
  gateCookieValue,
  ipSubnet,
  isGateExemptPath,
  loadGatePolicy,
  readCookie,
  resetGatePolicyCache,
  resolveGateSecret,
  sanitizeReturnTo,
  signGateCookie,
  verifyGateCookie,
  verifyTurnstileToken,
} from '../src/gate';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36';
const SECRET = 'test-gate-secret';
const CTX = { ua: UA, ip: '203.0.113.60', bindMode: 'ua' as const, ttlMs: 60_000, now: 1_000_000 };

describe('ipSubnet', () => {
  it('groups IPv4 by /24, IPv6 by first three segments; invalid -> unknown', () => {
    expect(ipSubnet('203.0.113.60')).toBe('203.0.113.0/24');
    expect(ipSubnet('203.0.113.61')).toBe('203.0.113.0/24');
    expect(ipSubnet('198.51.100.9')).toBe('198.51.100.0/24');
    expect(ipSubnet('2001:db8:1:2::5')).toBe('v6:2001:db8:1');
    expect(ipSubnet('2001:db8::5')).toBe('v6:2001:db8:0');
    expect(ipSubnet('2001:0DB8:0000::5')).toBe('v6:2001:db8:0');
    expect(ipSubnet('::ffff:203.0.113.60')).toBe('203.0.113.0/24');
    expect(ipSubnet('not-an-ip')).toBe('unknown');
    expect(ipSubnet('999.1.1.1')).toBe('unknown');
    expect(ipSubnet('')).toBe('unknown');
  });
});

describe('gate cookie', () => {
  it('signs and verifies a round-trip', async () => {
    const value = await signGateCookie(SECRET, CTX);
    expect(value.startsWith('v1.')).toBe(true);
    await expect(verifyGateCookie(SECRET, value, CTX)).resolves.toEqual({ ok: true });
  });

  it('rejects tampered signatures and malformed values', async () => {
    const value = await signGateCookie(SECRET, CTX);
    const parts = value.split('.');
    await expect(verifyGateCookie(SECRET, `v1.${parts[1]}.${parts[2]}.${'0'.repeat(parts[3].length)}`, CTX)).resolves.toEqual({ ok: false, reason: 'bad_signature' });
    await expect(verifyGateCookie(SECRET, 'garbage', CTX)).resolves.toEqual({ ok: false, reason: 'malformed' });
    await expect(verifyGateCookie(SECRET, null, CTX)).resolves.toEqual({ ok: false, reason: 'malformed' });
    await expect(verifyGateCookie(SECRET, `v2.${parts[1]}.${parts[2]}.${parts[3]}`, CTX)).resolves.toEqual({ ok: false, reason: 'malformed' });
  });

  it('expires after ttl and rejects future-dated values', async () => {
    const value = await signGateCookie(SECRET, CTX);
    await expect(verifyGateCookie(SECRET, value, { ...CTX, now: CTX.now + CTX.ttlMs + 1 })).resolves.toEqual({ ok: false, reason: 'expired' });
    await expect(verifyGateCookie(SECRET, value, { ...CTX, now: CTX.now - 10 * 60_000 })).resolves.toEqual({ ok: false, reason: 'malformed' });
  });

  it('binds to UA and, when configured, to the IP subnet', async () => {
    const uaBound = await signGateCookie(SECRET, { ...CTX, bindMode: 'ua' });
    await expect(verifyGateCookie(SECRET, uaBound, { ...CTX, bindMode: 'ua', ua: `${UA} x` })).resolves.toEqual({ ok: false, reason: 'mismatch' });

    const subnetBound = await signGateCookie(SECRET, { ...CTX, bindMode: 'ua+subnet' });
    await expect(verifyGateCookie(SECRET, subnetBound, { ...CTX, bindMode: 'ua+subnet', ip: '203.0.113.99' })).resolves.toEqual({ ok: true });
    await expect(verifyGateCookie(SECRET, subnetBound, { ...CTX, bindMode: 'ua+subnet', ip: '198.51.100.1' })).resolves.toEqual({ ok: false, reason: 'mismatch' });

    const unbound = await signGateCookie(SECRET, { ...CTX, bindMode: 'none' });
    await expect(verifyGateCookie(SECRET, unbound, { ...CTX, bindMode: 'none', ua: 'other', ip: '198.51.100.1' })).resolves.toEqual({ ok: true });
  });

  it('sets cookie attributes', () => {
    expect(gateCookieValue('v1.x', 3_600_000, true)).toBe('ng_gate=v1.x; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=3600');
    expect(gateCookieValue('v1.x', 3_600_000, false)).not.toContain('Secure');
  });
});

describe('readCookie', () => {
  it('extracts a named cookie or null', () => {
    expect(readCookie('a=1; ng_gate=v1.x; b=2', 'ng_gate')).toBe('v1.x');
    expect(readCookie('a=1; b=2', 'ng_gate')).toBeNull();
    expect(readCookie(null, 'ng_gate')).toBeNull();
    expect(readCookie('ng_gate=', 'ng_gate')).toBeNull();
  });
});

describe('resolveGateSecret', () => {
  it('rejects missing or unrotated production secrets', () => {
    expect(resolveGateSecret({ ENVIRONMENT: 'production' })).toEqual({ secret: null, degraded: true });
    expect(resolveGateSecret({ ENVIRONMENT: 'production', GATE_SECRET: 'dev-gate-secret' })).toEqual({ secret: null, degraded: true });
    expect(resolveGateSecret({ ENVIRONMENT: 'production', GATE_SECRET: 'rotated-secret' })).toEqual({ secret: 'rotated-secret', degraded: false });
    expect(resolveGateSecret({ ENVIRONMENT: 'dev', GATE_SECRET: 'dev-gate-secret' })).toEqual({ secret: 'dev-gate-secret', degraded: false });
  });
});

describe('loadGatePolicy', () => {
  beforeEach(async () => {
    resetGatePolicyCache();
    await env.KV.delete(GATE_POLICY_KEY);
  });

  it('defaults to monitor and honors a valid override', async () => {
    expect(await loadGatePolicy(env.KV)).toEqual({ policy: DEFAULT_GATE_POLICY, degraded: false });
    resetGatePolicyCache();
    await env.KV.put(GATE_POLICY_KEY, JSON.stringify({ mode: 'enforce', bindMode: 'ua', cookieTtlMs: 3_600_000, socialAllow: false, listVersion: 4 }));
    const { policy, degraded } = await loadGatePolicy(env.KV);
    expect(degraded).toBe(false);
    expect(policy).toEqual({ mode: 'enforce', failMode: 'open', cookieTtlMs: 3_600_000, bindMode: 'ua', socialAllow: false, listVersion: 4 });
  });

  it('falls back to defaults on broken JSON and repairs invalid fields', async () => {
    await env.KV.put(GATE_POLICY_KEY, '{broken');
    expect(await loadGatePolicy(env.KV)).toEqual({ policy: DEFAULT_GATE_POLICY, degraded: true });
    resetGatePolicyCache();
    await env.KV.put(GATE_POLICY_KEY, JSON.stringify({ mode: 'wat', cookieTtlMs: -1, listVersion: 0 }));
    expect(await loadGatePolicy(env.KV)).toEqual({ policy: DEFAULT_GATE_POLICY, degraded: false });
    // listVersion 必须限幅:超过契约上限会让 rollup 把全部 gate 事件判为坏载荷
    resetGatePolicyCache();
    await env.KV.put(GATE_POLICY_KEY, JSON.stringify({ listVersion: 2_000_000 }));
    expect((await loadGatePolicy(env.KV)).policy.listVersion).toBe(1);
  });
});

describe('decideGate', () => {
  const base = { klass: 'none' as const, socialAllow: true, cookieValid: false, bypass: false, degraded: false };

  it('covers the decision table', () => {
    expect(decideGate({ ...base, bypass: true })).toEqual({ intent: 'pass', reason: 'bypass_internal' });
    expect(decideGate({ ...base, klass: 'ai_training' })).toEqual({ intent: 'block', reason: 'ai_bot_ua' });
    expect(decideGate({ ...base, klass: 'ai_user' })).toEqual({ intent: 'block', reason: 'ai_bot_ua' });
    expect(decideGate({ ...base, klass: 'search_engine' })).toEqual({ intent: 'block', reason: 'search_engine_ua' });
    expect(decideGate({ ...base, klass: 'ai_search', degraded: true })).toEqual({ intent: 'block', reason: 'ai_bot_ua' });
    expect(decideGate({ ...base, degraded: true })).toEqual({ intent: 'pass', reason: 'gate_degraded' });
    expect(decideGate({ ...base, cookieValid: true })).toEqual({ intent: 'pass', reason: 'cookie_valid' });
    expect(decideGate({ ...base, klass: 'social_preview' })).toEqual({ intent: 'pass', reason: 'whitelist_social' });
    expect(decideGate({ ...base, klass: 'social_preview', socialAllow: false })).toEqual({ intent: 'challenge', reason: 'challenge_issued' });
    expect(decideGate(base)).toEqual({ intent: 'challenge', reason: 'challenge_issued' });
  });
});

describe('isGateExemptPath', () => {
  it('exempts admin/api/declaration/well-known/gate/assets only', () => {
    for (const path of ['/admin', '/admin/x', '/api/health', '/robots.txt', '/sitemap-index.xml', '/sitemap-0.xml', '/.well-known/security.txt', '/__gate/verify', '/logo-lockup-dark.webp', '/assets/app.js', '/data.json']) {
      expect(isGateExemptPath(path), path).toBe(true);
    }
    for (const path of ['/', '/learn/how-it-works', '/zh/nex', '/index.html', '/foo.html', '/documents/uvel-whitepaper-v1.2-en.pdf']) {
      expect(isGateExemptPath(path), path).toBe(false);
    }
  });
});

describe('sanitizeReturnTo', () => {
  it('only accepts same-origin relative paths', () => {
    expect(sanitizeReturnTo('/')).toBe('/');
    expect(sanitizeReturnTo('/learn/x?a=1')).toBe('/learn/x?a=1');
    for (const bad of ['//evil.com', 'https://evil.com', '/a\\b', 'javascript:alert(1)', '', '/x\u0000', '/x\n', 'a', 42, null, undefined, '/'.repeat(600)]) {
      expect(sanitizeReturnTo(bad as unknown)).toBe('/');
    }
  });
});

describe('challenge page', () => {
  it('carries no site content and escapes attacker input', () => {
    const html = challengePageHtml({ locale: 'en', returnTo: '/"/><script>alert(1)</script>', siteKey: 'key"><script>' });
    expect(html).toContain('<noscript>');
    expect(html).toContain('__gate/verify');
    expect(html).toContain('<details id="g-why"><summary>Why am I seeing this?</summary>');
    expect(html).not.toContain('<script>alert(1)');
    expect(html).not.toContain('key"><script>');
    expect(new TextEncoder().encode(html).length).toBeLessThan(8192);
  });

  it('opens in cooling state when issuance was rate-limited', () => {
    const html = challengePageHtml({ locale: 'zh', returnTo: '/', siteKey: 'k', coolingSeconds: 45 });
    expect(html).toContain('为什么看到这个页面?');
    expect(html).toContain('coolingSeconds=45');
  });

  it('renders the requested locale and sends no-store headers', () => {
    expect(challengePageHtml({ locale: 'zh', returnTo: '/', siteKey: 'k' })).toContain('正在验证您的浏览器');
    expect(challengePageHtml({ locale: 'vi', returnTo: '/', siteKey: 'k' })).toContain('Đang xác minh');
    expect(challengePageHeaders()['Cache-Control']).toBe('no-store');
    expect(challengePageHeaders()['X-Robots-Tag']).toBe('noindex');
    expect(challengePageHeaders()['Content-Security-Policy']).toContain("frame-src https://challenges.cloudflare.com");
  });
});

describe('verifyTurnstileToken', () => {
  it('passes through success, failure codes and network errors', async () => {
    const okFetch = vi.fn(async () => new Response(JSON.stringify({ success: true }), { status: 200 }));
    await expect(verifyTurnstileToken('s', 't', '1.2.3.4', okFetch as unknown as typeof fetch)).resolves.toEqual({ ok: true });

    const failFetch = vi.fn(async () => new Response(JSON.stringify({ success: false, 'error-codes': ['invalid-input-response'] }), { status: 200 }));
    await expect(verifyTurnstileToken('s', 't', null, failFetch as unknown as typeof fetch)).resolves.toEqual({ ok: false, code: 'invalid-input-response' });

    const netFetch = vi.fn(async () => { throw new Error('down'); });
    await expect(verifyTurnstileToken('s', 't', null, netFetch as unknown as typeof fetch)).resolves.toEqual({ ok: false, code: 'network' });

    // 挂起(siteverify 不响应)必须超时归入 network,不能永久吊死
    const hangFetch = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    }));
    await expect(verifyTurnstileToken('s', 't', null, hangFetch as unknown as typeof fetch, 10)).resolves.toEqual({ ok: false, code: 'network' });
  });
});
