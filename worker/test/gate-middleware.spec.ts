// FEAT-ANTIBOT01 §3.3 中间件接线验收:挑战壳 / 名单拦截 / monitor 只记 / 豁免直通 / verify 签发 / 降级。
import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { GATE_COOKIE_NAME, GATE_POLICY_KEY, resetGateLimiters, resetGatePolicyCache, signGateCookie } from '../src/gate';
import { setTurnstileFetchForTests } from '../src/gate-middleware';
import { app } from '../src/index';

const IP = '203.0.113.60';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36';
const AI_UA = 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.2; +https://openai.com/gptbot';
const SOCIAL_UA = 'Twitterbot/1.0';
const SECRET = 'dev-gate-secret';
const CHALLENGE_MARK = 'Verifying your browser';

const page = (extra: Record<string, string> = {}) => ({ 'cf-connecting-ip': IP, accept: 'text/html', 'user-agent': UA, ...extra });
const aiPage = (extra: Record<string, string> = {}) => page({ 'user-agent': AI_UA, ...extra });

async function setPolicy(policy: Record<string, unknown>): Promise<void> {
  resetGatePolicyCache();
  await env.KV.put(GATE_POLICY_KEY, JSON.stringify(policy));
}

async function gateEvents(): Promise<Array<{ payload: string }>> {
  const rows = await env.DB.prepare("SELECT payload FROM raw_events WHERE type='gate' ORDER BY id").all<{ payload: string }>();
  return rows.results;
}

async function validCookie(ua = UA, ip = IP): Promise<string> {
  const value = await signGateCookie(SECRET, { ua, ip, bindMode: 'ua+subnet', ttlMs: 7 * 24 * 3_600_000 });
  return `${GATE_COOKIE_NAME}=${value}`;
}

beforeEach(async () => {
  resetGatePolicyCache();
  resetGateLimiters();
  setTurnstileFetchForTests(null);
  await env.KV.delete(GATE_POLICY_KEY);
  await env.DB.prepare("DELETE FROM raw_events WHERE type='gate'").run();
});

describe('gate middleware (enforce)', () => {
  it('serves a content-free challenge shell for anonymous document requests', async () => {
    await setPolicy({ mode: 'enforce' });
    const res = await app.request('/', { headers: page() }, env);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('content-security-policy')).toContain('challenges.cloudflare.com');
    const html = await res.text();
    expect(html).toContain(CHALLENGE_MARK);
    expect(html).toContain('<noscript>');
    expect(html).toContain('/__gate/verify');

    const events = await gateEvents();
    expect(events).toHaveLength(1);
    expect(events[0].payload).toContain('"r":"challenge_issued"');
    expect(events[0].payload).toContain('"e":1');
  });

  it('blocks AI and search-engine UAs with an empty 403 and logs the block', async () => {
    await setPolicy({ mode: 'enforce' });
    const ai = await app.request('/learn/how-it-works', { headers: aiPage() }, env);
    expect(ai.status).toBe(403);
    expect(await ai.text()).toBe('');
    const bot = await app.request('/', { headers: page({ 'user-agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)' }) }, env);
    expect(bot.status).toBe(403);

    const events = await gateEvents();
    expect(events.length).toBe(2);
    expect(events[0].payload).toContain('"r":"ai_bot_ua"');
    expect(events[0].payload).toContain('"e":1');
    expect(events[1].payload).toContain('"r":"search_engine_ua"');
  });

  it('lets whitelisted social unfurlers and valid gate cookies through, and logs both', async () => {
    await setPolicy({ mode: 'enforce' });
    const social = await app.request('/', { headers: page({ 'user-agent': SOCIAL_UA }) }, env);
    expect(social.status).not.toBe(403);
    expect(await social.text()).not.toContain(CHALLENGE_MARK);

    const cookie = await validCookie();
    const passed = await app.request('/', { headers: page({ cookie }) }, env);
    expect(passed.status).not.toBe(403);
    expect(await passed.text()).not.toContain(CHALLENGE_MARK);

    const reasons = (await gateEvents()).map((row) => (JSON.parse(row.payload) as { r: string }).r);
    expect(reasons).toContain('whitelist_social');
    expect(reasons).toContain('cookie_valid');

    // cookie 放行按 1 次/5 分钟/IP 采样:紧接着的第二次不再写
    const before = (await gateEvents()).length;
    await app.request('/', { headers: page({ cookie }) }, env);
    expect((await gateEvents()).length).toBe(before);
  });

  it('renders the challenge shell in the requested locale', async () => {
    await setPolicy({ mode: 'enforce' });
    const res = await app.request('/learn/how-it-works', { headers: page({ 'accept-language': 'zh-CN,zh;q=0.9' }) }, env);
    expect(await res.text()).toContain('正在验证您的浏览器');
  });

  it('renders a cooling challenge page when issuance is rate-limited', async () => {
    await setPolicy({ mode: 'enforce' });
    let last: Response | undefined;
    for (let i = 0; i < 31; i++) last = await app.request('/', { headers: page() }, env);
    expect(last!.status).toBe(429);
    expect(last!.headers.get('retry-after')).toBe('60');
    expect(await last!.text()).toContain('coolingSeconds=60');
  });

  it('keeps exempt paths out of the gate', async () => {
    await setPolicy({ mode: 'enforce' });
    expect((await app.request('/api/health', { headers: page() }, env)).status).toBe(200);
    expect(await (await app.request('/robots.txt', { headers: page() }, env)).text()).not.toContain(CHALLENGE_MARK);
    expect(await (await app.request('/admin/', { headers: page() }, env)).text()).not.toContain(CHALLENGE_MARK);
  });
});

describe('gate middleware (monitor / degraded)', () => {
  it('monitor records would-be blocks without changing the response', async () => {
    await setPolicy({ mode: 'monitor' });
    const res = await app.request('/', { headers: aiPage() }, env);
    expect(res.status).not.toBe(403);
    const events = await gateEvents();
    expect(events).toHaveLength(1);
    expect(events[0].payload).toContain('"r":"ai_bot_ua"');
    expect(events[0].payload).toContain('"e":0');
  });

  it('fails open on unrotated secrets and records the degraded event', async () => {
    await setPolicy({ mode: 'enforce' });
    const prod = { ...env, ENVIRONMENT: 'production' };
    const res = await app.request('/', { headers: page() }, prod);
    expect(res.status).not.toBe(403);
    expect(await res.text()).not.toContain(CHALLENGE_MARK);
    const events = await gateEvents();
    expect(events).toHaveLength(1);
    expect(events[0].payload).toContain('"r":"gate_degraded"');
    expect(events[0].payload).toContain('"e":0');
  });

  it('fails closed when configured', async () => {
    await setPolicy({ mode: 'enforce', failMode: 'closed' });
    const prod = { ...env, ENVIRONMENT: 'production' };
    expect((await app.request('/', { headers: page() }, prod)).status).toBe(503);
  });
});

describe('POST /__gate/verify', () => {
  const post = (body: unknown, extra: Record<string, string> = {}) => ({
    method: 'POST',
    headers: { 'cf-connecting-ip': IP, 'user-agent': UA, 'content-type': 'application/json', ...extra },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

  it('issues a bound cookie after Turnstile passes, and the cookie opens the gate', async () => {
    await setPolicy({ mode: 'enforce' });
    setTurnstileFetchForTests(async () => new Response(JSON.stringify({ success: true }), { status: 200 }));
    const res = await app.request('/__gate/verify', post({ token: 'tok', returnTo: '/learn/x?a=1' }), env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, returnTo: '/learn/x?a=1' });
    const cookie = (res.headers.get('set-cookie') ?? '').match(/ng_gate=([^;]+)/)?.[1];
    expect(cookie).toBeTruthy();

    const passed = await app.request('/', { headers: page({ cookie: `${GATE_COOKIE_NAME}=${cookie}` }) }, env);
    expect(passed.status).not.toBe(403);
    expect(await passed.text()).not.toContain(CHALLENGE_MARK);
  });

  it('rejects failed and network-broken Turnstile checks', async () => {
    await setPolicy({ mode: 'enforce' });
    setTurnstileFetchForTests(async () => new Response(JSON.stringify({ success: false, 'error-codes': ['invalid-input-response'] }), { status: 200 }));
    const failed = await app.request('/__gate/verify', post({ token: 'tok', returnTo: '/' }), env);
    expect(failed.status).toBe(403);
    expect(await failed.json()).toEqual({ ok: false, code: 'invalid-input-response' });

    setTurnstileFetchForTests(async () => { throw new Error('down'); });
    const broken = await app.request('/__gate/verify', post({ token: 'tok', returnTo: '/' }), env);
    expect(broken.status).toBe(403);
    expect(await broken.json()).toEqual({ ok: false, code: 'network' });
  });

  it('rejects malformed bodies and rate-limits repeated attempts', async () => {
    await setPolicy({ mode: 'enforce' });
    expect((await app.request('/__gate/verify', post('{broken'), env)).status).toBe(400);
    expect((await app.request('/__gate/verify', post({ token: '', returnTo: '/' }), env)).status).toBe(400);

    setTurnstileFetchForTests(async () => new Response(JSON.stringify({ success: true }), { status: 200 }));
    let limited = 0;
    for (let i = 0; i < 12; i++) {
      const res = await app.request('/__gate/verify', post({ token: `t${i}`, returnTo: '/' }), env);
      if (res.status === 429) {
        limited++;
        expect(await res.json()).toEqual({ ok: false, code: 'rate_limited', retryAfter: 60 });
      }
    }
    expect(limited).toBeGreaterThan(0);
  });
});
