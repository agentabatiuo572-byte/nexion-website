// T15/T16/T17 验收(plan;继承 CON12-A1/A2/E1/E2/E3/E4)。
import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetGeoCache } from '../src/geo';
import { app } from '../src/index';
import { resetRateLimiter } from '../src/ingest';

const PW = 'geo-suite-password!';
const IP = { 'cf-connecting-ip': '203.0.113.60', 'content-type': 'application/json' };
const HTML = { accept: 'text/html' };

async function login(): Promise<string> {
  await app.request('/api/auth/setup', { method: 'POST', headers: IP, body: JSON.stringify({ token: env.SETUP_TOKEN, password: PW }) }, env);
  const res = await app.request('/api/auth/login', { method: 'POST', headers: IP, body: JSON.stringify({ password: PW }) }, env);
  return `nx_sid=${(res.headers.get('set-cookie') ?? '').match(/nx_sid=([^;]+)/)?.[1]}`;
}
const J = (cookie: string) => ({ cookie, 'content-type': 'application/json' });

async function enableCN(cookie: string) {
  const res = await app.request('/api/geo', {
    method: 'PUT', headers: J(cookie),
    body: JSON.stringify({ enabled: true, countries: ['CN'], reason: '测试启用屏蔽规则' }),
  }, env);
  expect(res.status).toBe(200);
}

beforeEach(async () => {
  resetGeoCache();
  resetRateLimiter();
  for (const t of ['audit', 'sessions', 'login_throttle', 'auth_account', 'config_versions', 'config_draft', 'raw_events', 'daily_traffic', 'daily_blocked'])
    await env.DB.prepare(`DELETE FROM ${t}`).run();
  await env.KV.delete('geo:rules');
});

describe('CON12 区域屏蔽', () => {
  it('初始未配置=关闭:CN 模拟请求放行', async () => {
    const res = await app.request('/', { headers: { ...HTML, 'x-geo-sim': 'CN' } }, env);
    expect(res.status).not.toBe(451);
  });

  it('A1 启用后命中名单:text/html → 451 拦截页(zh+en)+ 拦截事件入库;资产请求 451 无体不计数', async () => {
    const cookie = await login();
    await enableCN(cookie);
    const res = await app.request('/', { headers: { ...HTML, 'x-geo-sim': 'CN' } }, env);
    expect(res.status).toBe(451);
    const html = await res.text();
    expect(html).toContain('不可用');
    expect(html).toContain('unavailable');
    expect(html).toContain('noindex');
    const asset = await app.request('/x.css', { headers: { accept: 'text/css', 'x-geo-sim': 'CN' } }, env);
    expect(asset.status).toBe(451);
    await new Promise((r) => setTimeout(r, 50)); // waitUntil 落库
    const n = await env.DB.prepare("SELECT COUNT(*) c FROM raw_events WHERE type='blocked'").first<{ c: number }>();
    expect(n!.c).toBe(1); // 仅文档请求计数
    const vn = await app.request('/', { headers: { ...HTML, 'x-geo-sim': 'VN' } }, env);
    expect(vn.status).not.toBe(451); // 非名单放行
  });

  it('E1 自锁保护:/admin 与 /api 恒不拦;直通 cookie 放行且不计统计', async () => {
    const cookie = await login();
    await enableCN(cookie);
    expect((await app.request('/admin/', { headers: { ...HTML, 'x-geo-sim': 'CN' } }, env)).status).not.toBe(451);
    expect((await app.request('/api/health', { headers: { 'x-geo-sim': 'CN' } }, env)).status).toBe(200);
    // 直通:签发令牌 → 兑换 cookie → CN 放行
    const tok = await app.request('/api/geo/bypass-token', { method: 'POST', headers: J(cookie) }, env);
    const { url } = (await tok.json()) as { url: string };
    const ex = await app.request(url, { headers: { 'x-geo-sim': 'CN' } }, env);
    expect(ex.status).toBe(302);
    const bp = (ex.headers.get('set-cookie') ?? '').match(/gx_bypass=([^;]+)/)?.[1];
    expect(bp).toBeTruthy();
    const before = (await env.DB.prepare("SELECT COUNT(*) c FROM raw_events WHERE type='blocked'").first<{ c: number }>())!.c;
    const ok = await app.request('/', { headers: { ...HTML, 'x-geo-sim': 'CN', cookie: `gx_bypass=${bp}` } }, env);
    expect(ok.status).not.toBe(451);
    const after = (await env.DB.prepare("SELECT COUNT(*) c FROM raw_events WHERE type='blocked'").first<{ c: number }>())!.c;
    expect(after).toBe(before); // 直通不计统计
    // 伪造 cookie 不放行
    const forged = await app.request('/', { headers: { ...HTML, 'x-geo-sim': 'CN', cookie: 'gx_bypass=9999999999999.deadbeef' } }, env);
    expect(forged.status).toBe(451);
    // 兑换伪令牌 403
    expect((await app.request('/api/bypass?t=123.fake', {}, env)).status).toBe(403);
  });

  it('E4 生产环境恒忽略模拟头(双向)', async () => {
    const cookie = await login();
    await enableCN(cookie);
    const prodEnv = { ...env, ENVIRONMENT: 'production' };
    const res = await app.request('/', { headers: { ...HTML, 'x-geo-sim': 'CN' } }, prodEnv);
    expect(res.status).not.toBe(451); // 生产:sim 无效,无 cf.country → XX 放行
    const dev = await app.request('/', { headers: { ...HTML, 'x-geo-sim': 'CN' } }, env);
    expect(dev.status).toBe(451); // dev:sim 有效
  });

  it('E3 KV 读取异常 → 内置基线 CN 生效(不失守);面板 degraded=true', async () => {
    const cookie = await login();
    resetGeoCache();
    const broken = { ...env, KV: { ...env.KV, get: () => Promise.reject(new Error('kv down')) } } as typeof env;
    const res = await app.request('/', { headers: { ...HTML, 'x-geo-sim': 'CN' } }, broken);
    expect(res.status).toBe(451);
    resetGeoCache();
    const st = await app.request('/api/geo', { headers: { cookie } }, broken);
    expect(((await st.json()) as { degraded: boolean }).degraded).toBe(true);
    resetGeoCache();
  });

  it('A2/E2 规则变更:理由必填;高流量国家须显式确认;回读确认;审计 before/after', async () => {
    const cookie = await login();
    // 造 7 天流量:VN 90%,US 10%
    await env.DB.prepare("INSERT INTO daily_traffic (date, locale, country, device, ref_class, pv, uv, sessions) VALUES (date('now','-1 day'),'vi','VN','m','direct',90,50,60),(date('now','-1 day'),'en','US','d','direct',10,8,9)").run();
    const noReason = await app.request('/api/geo', { method: 'PUT', headers: J(cookie), body: JSON.stringify({ enabled: true, countries: ['CN'] }) }, env);
    expect(noReason.status).toBe(400);
    const hot = await app.request('/api/geo', { method: 'PUT', headers: J(cookie), body: JSON.stringify({ enabled: true, countries: ['CN', 'VN'], reason: '误伤护栏测试用例' }) }, env);
    expect(hot.status).toBe(409);
    const hotBody = (await hot.json()) as { hot: Array<{ country: string; share: number }> };
    expect(hotBody.hot[0]).toMatchObject({ country: 'VN' });
    expect(hotBody.hot[0]!.share).toBeCloseTo(0.9, 2);
    const confirmed = await app.request('/api/geo', { method: 'PUT', headers: J(cookie), body: JSON.stringify({ enabled: true, countries: ['CN', 'VN'], reason: '误伤护栏测试用例', confirmHighTraffic: true }) }, env);
    expect(confirmed.status).toBe(200);
    resetGeoCache();
    expect((await app.request('/', { headers: { ...HTML, 'x-geo-sim': 'VN' } }, env)).status).toBe(451);
    const audit = await env.DB.prepare("SELECT before_summary, after_summary, reason FROM audit WHERE action='geo.update' ORDER BY id DESC LIMIT 1").first<{ before_summary: string; after_summary: string; reason: string }>();
    expect(audit!.after_summary).toContain('VN');
    expect(audit!.reason).toContain('护栏');
    // 未登录不可改
    expect((await app.request('/api/geo', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{}' }, env)).status).toBe(401);
  });

  it('GET /api/geo 统计口径:last7/todayLive/占比', async () => {
    const cookie = await login();
    await enableCN(cookie);
    for (let i = 0; i < 3; i++) await app.request('/', { headers: { ...HTML, 'x-geo-sim': 'CN' } }, env);
    await new Promise((r) => setTimeout(r, 80));
    const st = (await (await app.request('/api/geo', { headers: { cookie } }, env)).json()) as { stats: { todayLive: number } };
    expect(st.stats.todayLive).toBe(3);
  });
});
