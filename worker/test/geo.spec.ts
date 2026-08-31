// T15/T16/T17 验收(plan;继承 CON12-A1/A2/E1/E2/E3/E4)。
import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetGeoCache, resetGeoLimiters } from '../src/geo';
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
  resetGeoLimiters();
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

  it('E4/C2 模拟头白名单判据:仅 dev|preview 生效,其余环境(含拼错/未设)一律拒绝——带正对照', async () => {
    const cookie = await login();
    await enableCN(cookie);
    // 🔴 正对照(T15 验收发现的假绿修复):只断言「生产下 sim 不生效」是不够的——
    // 中间件在生产整体失效(永远放行)也会让那条断言变绿。必须同时证明「生产下拦截仍活着」。
    const prodEnv = { ...env, ENVIRONMENT: 'production' };
    // ① 正对照:生产环境下,真实国家(用 cf-ipcountry 头模拟边缘注入)命中名单 → 仍拦
    expect((await app.request('/', { headers: { ...HTML, 'cf-ipcountry': 'CN' } }, prodEnv)).status).toBe(451);
    // ② 逃逸方向:被屏蔽访客用 sim 头伪装成允许国家 → 不得放行
    expect((await app.request('/', { headers: { ...HTML, 'cf-ipcountry': 'CN', 'x-geo-sim': 'US' } }, prodEnv)).status).toBe(451);
    // ③ 触发方向:sim 头不得在生产制造拦截(证明 sim 被彻底忽略而非反向生效)
    expect((await app.request('/', { headers: { ...HTML, 'cf-ipcountry': 'US', 'x-geo-sim': 'CN' } }, prodEnv)).status).not.toBe(451);
    // ④ C2 判据反转:环境值拼错/未覆盖(非 dev|preview)同样拒绝模拟——漏配时 fail-closed
    for (const bad of ['prod', 'Production', 'staging', '']) {
      const e = { ...env, ENVIRONMENT: bad };
      expect((await app.request('/', { headers: { ...HTML, 'cf-ipcountry': 'US', 'x-geo-sim': 'CN' } }, e)).status, `env=${bad}`).not.toBe(451);
      expect((await app.request('/', { headers: { ...HTML, 'cf-ipcountry': 'CN', 'x-geo-sim': 'US' } }, e)).status, `env=${bad}`).toBe(451);
    }
    // ⑤ dev 下 sim 有效(本套件其余用例的前提)
    expect((await app.request('/', { headers: { ...HTML, 'x-geo-sim': 'CN' } }, env)).status).toBe(451);
  });

  it('C1 直通密钥 fail-closed:缺失/非 dev 环境仍用 dev 默认值 → 签发 503、校验一律不放行', async () => {
    const cookie = await login();
    await enableCN(cookie);
    // 先在正常 dev 环境拿一枚合法 cookie(用于证明「密钥闸关掉后连合法 cookie 也不放行」)
    const tok = await app.request('/api/geo/bypass-token', { method: 'POST', headers: J(cookie) }, env);
    const { url } = (await tok.json()) as { url: string };
    const ex = await app.request(url, { headers: { 'x-geo-sim': 'CN' } }, env);
    const goodCookie = `gx_bypass=${(ex.headers.get('set-cookie') ?? '').match(/gx_bypass=([^;]+)/)?.[1]}`;
    expect((await app.request('/', { headers: { ...HTML, 'x-geo-sim': 'CN', cookie: goodCookie } }, env)).status).not.toBe(451);
    // ① 密钥缺失:签发 503,且既有 cookie 失效(不再用空串验签)
    const noSecret = { ...env, BYPASS_SECRET: '' };
    expect((await app.request('/api/geo/bypass-token', { method: 'POST', headers: J(cookie) }, noSecret)).status).toBe(503);
    expect((await app.request('/', { headers: { ...HTML, 'cf-ipcountry': 'CN', cookie: goodCookie } }, noSecret)).status).toBe(451);
    // ② 非 dev 环境仍是仓库内 dev 默认值 = 未轮换 → 同样停用
    const unrotated = { ...env, ENVIRONMENT: 'production' }; // BYPASS_SECRET 仍为 dev 默认值
    expect((await app.request('/api/geo/bypass-token', { method: 'POST', headers: J(cookie) }, unrotated)).status).toBe(503);
    expect((await app.request('/', { headers: { ...HTML, 'cf-ipcountry': 'CN', cookie: goodCookie } }, unrotated)).status).toBe(451);
    // ③ 轮换后恢复可用(证明上面两条不是「整条链坏掉」的假绿)
    const rotated = { ...env, ENVIRONMENT: 'production', BYPASS_SECRET: 'rotated-production-secret-x' };
    expect((await app.request('/api/geo/bypass-token', { method: 'POST', headers: J(cookie) }, rotated)).status).toBe(200);
  });

  it('C1 有效期上限:自选遥远 exp 的伪造/超期令牌不被接受', async () => {
    const cookie = await login();
    await enableCN(cookie);
    // 用真密钥签一枚「合法签名但 exp 在 10 年后」的 cookie:签名对,但超出 30 天上限 → 拒
    const far = Date.now() + 10 * 365 * 24 * 3600_000;
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey('raw', enc.encode(env.BYPASS_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const sig = await crypto.subtle.sign('HMAC', key, enc.encode(`bp.${far}`));
    const hex = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
    const res = await app.request('/', { headers: { ...HTML, 'x-geo-sim': 'CN', cookie: `gx_bypass=${far}.${hex}` } }, env);
    expect(res.status).toBe(451);
  });

  it('M2 兑换令牌一次性:重放同一令牌被拒', async () => {
    const cookie = await login();
    await enableCN(cookie);
    const { url } = (await (await app.request('/api/geo/bypass-token', { method: 'POST', headers: J(cookie) }, env)).json()) as { url: string };
    expect((await app.request(url, {}, env)).status).toBe(302);
    const replay = await app.request(url, {}, env);
    expect(replay.status).toBe(403); // 同一枚令牌第二次兑换
  });

  it('M3 审计含拦截页文案变化:只改文案时 before/after 不再看起来一样', async () => {
    const cookie = await login();
    await enableCN(cookie);
    const page = {
      title: { zh: '暂不提供服务', en: 'Not available' },
      body: { zh: '本服务目前不向您所在的地区提供。', en: 'Not offered in your region.' },
    };
    const res = await app.request('/api/geo', {
      method: 'PUT', headers: J(cookie),
      body: JSON.stringify({ enabled: true, countries: ['CN'], blockPage: page, reason: '仅更新拦截页文案' }),
    }, env);
    expect(res.status).toBe(200);
    const row = await env.DB.prepare("SELECT after_summary FROM audit WHERE action='geo.update' ORDER BY id DESC LIMIT 1").first<{ after_summary: string }>();
    expect(row!.after_summary).toContain('拦截页文案已改');
    resetGeoCache();
    expect(await (await app.request('/', { headers: { ...HTML, 'x-geo-sim': 'CN' } }, env)).text()).toContain('暂不提供服务'); // 文案真生效
  });

  it('L2 PUT 校验:非法结构/超长文案/非法国家码一律 400,不落盘', async () => {
    const cookie = await login();
    const bad = [
      { enabled: true, countries: ['CN'], reason: '短' },
      { enabled: true, countries: ['cn'], reason: '国家码小写测试用例' },
      // P2(第二路验收):非真实 ISO 码 + 兜底哨兵 XX 必须拒——XX 入名单会误伤全部无地理信息访客
      { enabled: true, countries: ['ZZ'], reason: '非真实国家码测试用例' },
      { enabled: true, countries: ['CN', 'XX'], reason: '兜底哨兵入名单测试' },
      { enabled: true, countries: ['QQ'], reason: '未分配码测试用例xx' },
      { enabled: 'yes', countries: ['CN'], reason: '布尔类型错误测试' },
      { enabled: true, countries: ['CN'], reason: '文案超长测试用例', blockPage: { title: { zh: 'x'.repeat(200), en: 'y' }, body: { zh: 'a', en: 'b' } } },
      { enabled: true, countries: ['CN'], reason: '结构错误测试用例', blockPage: 42 },
    ];
    for (const b of bad) {
      const res = await app.request('/api/geo', { method: 'PUT', headers: J(cookie), body: JSON.stringify(b) }, env);
      expect(res.status, JSON.stringify(b).slice(0, 60)).toBe(400);
    }
    expect(await env.KV.get('geo:rules')).toBeNull(); // 一条都没落盘
    // 正对照:真实码照常通过(证明上面的拒绝不是「整条 PUT 坏掉」的假绿)
    const ok = await app.request('/api/geo', {
      method: 'PUT', headers: J(cookie),
      body: JSON.stringify({ enabled: true, countries: ['CN', 'HK', 'VN'], reason: '真实码正对照用例', confirmHighTraffic: true }),
    }, env);
    expect(ok.status).toBe(200);
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
