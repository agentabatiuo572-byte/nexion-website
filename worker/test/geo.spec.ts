// T15/T16/T17 验收(plan;继承 CON12-A1/A2/E1/E2/E3/E4)。
import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadRules, resetGeoCache, resetGeoLimiters } from '../src/geo';
import { app } from '../src/index';
import { resetRateLimiter } from '../src/ingest';
import { runDailyRollup } from '../src/rollup';

const PW = 'geo-suite-password!';
const IP = { 'cf-connecting-ip': '203.0.113.60', 'content-type': 'application/json' };
const HTML = { accept: 'text/html' };
const DEFAULT_PAGE = {
  title: { zh: '服务在您所在的地区不可用', en: 'Service unavailable in your region' },
  body: {
    zh: '本服务目前不向您所在的地区提供。感谢理解。',
    en: 'This service is currently not offered in your region. Thank you for your understanding.',
  },
};
const INITIAL_RULES = { enabled: false, countries: ['CN'], blockPage: DEFAULT_PAGE };

async function fingerprint(serialized: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(serialized));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function setAuthority(rules: typeof INITIAL_RULES & Record<string, unknown>, version = 1): Promise<void> {
  const serialized = JSON.stringify(rules);
  const fp = await fingerprint(serialized);
  await env.DB.prepare(
    `INSERT INTO geo_rule_state (id, status, current_rules, current_fingerprint, version)
     VALUES (1, 'ready', ?1, ?2, ?3)
     ON CONFLICT(id) DO UPDATE SET
       status='ready', current_rules=excluded.current_rules,
       current_fingerprint=excluded.current_fingerprint, version=excluded.version,
       pending_kind=NULL, pending_operation_id=NULL,
       pending_previous_rules=NULL, pending_previous_fingerprint=NULL,
       pending_started_at=NULL, pending_before_summary=NULL,
       pending_after_summary=NULL, pending_reason=NULL`,
  ).bind(serialized, fp, version).run();
  await env.KV.put(`geo:rules:v${version}`, serialized);
}

async function login(): Promise<string> {
  await app.request('/api/auth/setup', { method: 'POST', headers: IP, body: JSON.stringify({ token: env.SETUP_TOKEN, password: PW }) }, env);
  const res = await app.request('/api/auth/login', { method: 'POST', headers: IP, body: JSON.stringify({ password: PW }) }, env);
  return `nx_sid=${(res.headers.get('set-cookie') ?? '').match(/nx_sid=([^;]+)/)?.[1]}`;
}
const J = (cookie: string) => ({ cookie, 'content-type': 'application/json' });

async function geoWriteMeta(db: D1Database = env.DB, operationId = crypto.randomUUID()): Promise<{
  operationId: string;
  expectedVersion: number;
  expectedFingerprint: string;
}> {
  const row = await db.prepare('SELECT version, current_fingerprint FROM geo_rule_state WHERE id=1')
    .first<{ version: number; current_fingerprint: string }>();
  if (!row) throw new Error('test requires a ready geo authority row');
  return { operationId, expectedVersion: row.version, expectedFingerprint: row.current_fingerprint };
}

async function withGeoWriteMeta(
  body: Record<string, unknown>,
  db: D1Database = env.DB,
  operationId?: string,
): Promise<Record<string, unknown>> {
  return { ...body, ...(await geoWriteMeta(db, operationId)) };
}

async function enableCN(cookie: string) {
  const res = await app.request('/api/geo', {
    method: 'PUT', headers: J(cookie),
    body: JSON.stringify(await withGeoWriteMeta({ enabled: true, countries: ['CN'], reason: '测试启用屏蔽规则' })),
  }, env);
  expect(res.status).toBe(200);
}

beforeEach(async () => {
  resetGeoCache();
  resetGeoLimiters();
  resetRateLimiter();
  for (const t of ['geo_rule_operations', 'geo_bypass_redemptions', 'geo_rule_state', 'audit', 'sessions', 'login_throttle', 'auth_account', 'config_versions', 'config_draft', 'raw_events', 'daily_traffic', 'daily_blocked'])
    await env.DB.prepare(`DELETE FROM ${t}`).run();
  const geoKeys = await env.KV.list({ prefix: 'geo:rules' });
  await Promise.all(geoKeys.keys.map((key) => env.KV.delete(key.name)));
  await setAuthority(INITIAL_RULES);
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

  it('M2 迁移安全轮换:旧两段式兑换链接即使已有 KV used 标记也绝不再次兑换', async () => {
    const exp = Date.now() + 4 * 60_000;
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.BYPASS_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const bytes = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`bt.${exp}`));
    const sig = [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
    await env.KV.put(`bp:used:${sig}`, '1', { expirationTtl: 600 });
    const result = await app.request(`/api/bypass?t=${encodeURIComponent(`${exp}.${sig}`)}`, {}, env);
    expect(result.status).toBe(403);
    expect(result.headers.get('set-cookie')).toBeNull();
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM geo_bypass_redemptions').first()).toMatchObject({ n: 0 });
  });

  it('M2 同毫秒签发使用随机 JTI:两条链接彼此独立且都可各兑换一次', async () => {
    const cookie = await login();
    const fixedNow = Date.now();
    const now = vi.spyOn(Date, 'now').mockReturnValue(fixedNow);
    try {
      const first = await (await app.request('/api/geo/bypass-token', { method: 'POST', headers: J(cookie) }, env)).json() as { url: string };
      const second = await (await app.request('/api/geo/bypass-token', { method: 'POST', headers: J(cookie) }, env)).json() as { url: string };
      expect(first.url).not.toBe(second.url);
      expect((await app.request(first.url, { headers: { 'cf-connecting-ip': '203.0.113.81' } }, env)).status).toBe(302);
      expect((await app.request(second.url, { headers: { 'cf-connecting-ip': '203.0.113.82' } }, env)).status).toBe(302);
      expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM geo_bypass_redemptions').first()).toMatchObject({ n: 2 });
    } finally {
      now.mockRestore();
    }
  });

  it('M2 跨 isolate 并发兑换:D1 唯一约束只允许一个请求设置直通 cookie', async () => {
    const cookie = await login();
    const { url } = (await (await app.request('/api/geo/bypass-token', { method: 'POST', headers: J(cookie) }, env)).json()) as { url: string };
    const results = await Promise.all([
      app.request(url, { headers: { 'cf-connecting-ip': '203.0.113.71' } }, env),
      app.request(url, { headers: { 'cf-connecting-ip': '203.0.113.72' } }, env),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([302, 403]);
    expect(results.filter((r) => r.headers.has('set-cookie'))).toHaveLength(1);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM geo_bypass_redemptions').first()).toMatchObject({ n: 1 });
  });

  it('M2 一次性存储故障时 fail-closed:不再沿用 KV 异常放行，不跳转、不设置 cookie', async () => {
    const cookie = await login();
    const { url } = (await (await app.request('/api/geo/bypass-token', { method: 'POST', headers: J(cookie) }, env)).json()) as { url: string };
    const failedStatement = {
      bind: (..._values: unknown[]) => failedStatement,
      run: async () => { throw new Error('injected-redemption-ledger-failure'); },
    } as unknown as D1PreparedStatement;
    const brokenDb = {
      prepare: (sql: string) => sql.includes('geo_bypass_redemptions') ? failedStatement : env.DB.prepare(sql),
      batch: async (_statements: D1PreparedStatement[]) => { throw new Error('injected-redemption-ledger-failure'); },
    } as unknown as D1Database;
    const brokenKv = {
      get: async () => { throw new Error('injected-old-kv-replay-read-failure'); },
      put: async () => { throw new Error('injected-old-kv-replay-write-failure'); },
    } as unknown as KVNamespace;
    const result = await app.request(url, {}, { ...env, DB: brokenDb, KV: brokenKv });
    expect(result.status).toBe(503);
    expect(result.headers.get('set-cookie')).toBeNull();
    expect(result.headers.get('location')).toBeNull();
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
      body: JSON.stringify(await withGeoWriteMeta({ enabled: true, countries: ['CN'], blockPage: page, reason: '仅更新拦截页文案' })),
    }, env);
    expect(res.status).toBe(200);
    const row = await env.DB.prepare("SELECT after_summary FROM audit WHERE action='geo.update.applied' ORDER BY id DESC LIMIT 1").first<{ after_summary: string }>();
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
    const meta = await geoWriteMeta();
    for (const b of bad) {
      const res = await app.request('/api/geo', { method: 'PUT', headers: J(cookie), body: JSON.stringify({ ...meta, ...b }) }, env);
      expect(res.status, JSON.stringify(b).slice(0, 60)).toBe(400);
    }
    expect(await env.KV.get('geo:rules:v2')).toBeNull(); // 一条非法请求都没产生新物化版本
    // 正对照:真实码照常通过(证明上面的拒绝不是「整条 PUT 坏掉」的假绿)
    const ok = await app.request('/api/geo', {
      method: 'PUT', headers: J(cookie),
      body: JSON.stringify(await withGeoWriteMeta({ enabled: true, countries: ['CN', 'HK', 'VN'], reason: '真实码正对照用例' })),
    }, env);
    expect(ok.status).toBe(200);
  });

  it('PUT 的 before 只读 D1 权威版本:不使用 60 秒缓存或陈旧 KV，省略 blockPage 时保留 D1 文案', async () => {
    const cookie = await login();
    const cached = {
      enabled: false,
      countries: ['CN'],
      blockPage: { title: { zh: '缓存旧标题', en: 'Cached old title' }, body: { zh: '缓存旧正文', en: 'Cached old body' } },
    };
    await env.KV.put('geo:rules', JSON.stringify(cached));
    resetGeoCache();
    await app.request('/', { headers: { ...HTML, 'x-geo-sim': 'US' } }, env);

    const authoritative = {
      enabled: false,
      countries: ['US'],
      blockPage: { title: { zh: 'D1 权威标题', en: 'D1 authority title' }, body: { zh: 'D1 权威正文', en: 'D1 authority body' } },
    };
    await setAuthority(authoritative);

    const result = await app.request('/api/geo', {
      method: 'PUT', headers: J(cookie),
      body: JSON.stringify(await withGeoWriteMeta({ enabled: true, countries: ['CN'], reason: '验证写入只使用 D1 权威基线' })),
    }, env);
    expect(result.status).toBe(200);
    const stored = JSON.parse((await env.KV.get('geo:rules:v2'))!) as { blockPage: typeof authoritative.blockPage };
    expect(stored.blockPage).toEqual(authoritative.blockPage);
    const audit = await env.DB.prepare("SELECT before_summary FROM audit WHERE action='geo.update.applied' ORDER BY id DESC LIMIT 1").first<{ before_summary: string }>();
    expect(audit?.before_summary).toContain('enabled=false [US]');
  });

  it('D1 真源首次迁移:空表只暴露旧 KV 为候选，普通 PUT 被拦，显式 bootstrap 的 D1 事务才线性化', async () => {
    const cookie = await login();
    await env.DB.prepare('DELETE FROM geo_rule_state').run();
    const legacy = {
      enabled: true,
      countries: ['US'],
      blockPage: { title: { zh: '旧系统现行标题', en: 'Legacy current title' }, body: { zh: '旧系统现行正文', en: 'Legacy current body' } },
      updatedAt: 12345,
    };
    await env.KV.put('geo:rules', JSON.stringify(legacy));
    const state = await (await app.request('/api/geo', { headers: { cookie } }, env)).json() as {
      rules: typeof legacy;
      authority: { status: string; source: string; candidateFingerprint: string };
    };
    expect(state.rules).toMatchObject(legacy);
    expect(state.authority).toMatchObject({
      status: 'bootstrap-required',
      source: 'legacy-kv-candidate',
      candidateFingerprint: expect.any(String),
    });

    const rejected = await app.request('/api/geo', {
      method: 'PUT', headers: J(cookie),
      body: JSON.stringify({
        enabled: false, countries: ['CN'], reason: '迁移完成前禁止普通规则写入',
        operationId: crypto.randomUUID(), expectedVersion: 1, expectedFingerprint: '0'.repeat(64),
      }),
    }, env);
    expect(rejected.status).toBe(409);
    expect(await rejected.json()).toMatchObject({ error: 'geo-bootstrap-required' });
    expect(await env.KV.get('geo:rules')).toBe(JSON.stringify(legacy));

    const mismatch = await app.request('/api/geo/recovery', {
      method: 'POST', headers: J(cookie),
      body: JSON.stringify({
        action: 'bootstrap', rules: state.rules, candidateFingerprint: '0'.repeat(64),
        reason: '拒绝候选指纹与展示快照不一致',
      }),
    }, env);
    expect(mismatch.status).toBe(409);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM geo_rule_state').first()).toMatchObject({ n: 0 });

    const bootstrapped = await app.request('/api/geo/recovery', {
      method: 'POST', headers: J(cookie),
      body: JSON.stringify({
        action: 'bootstrap',
        rules: state.rules,
        candidateFingerprint: state.authority.candidateFingerprint,
        reason: '确认旧 KV 快照并迁移为 D1 权威规则',
      }),
    }, env);
    expect(bootstrapped.status).toBe(200);
    expect(await bootstrapped.json()).toMatchObject({ ok: true, recovery: 'bootstrap', rules: legacy });
    const source = await env.DB.prepare('SELECT status, current_rules, version FROM geo_rule_state WHERE id=1').first<{ status: string; current_rules: string; version: number }>();
    expect(source).toMatchObject({ status: 'ready', version: 1 });
    expect(JSON.parse(source!.current_rules)).toMatchObject(legacy);
    await env.KV.put('geo:rules', JSON.stringify(INITIAL_RULES)); // 旧 key 后续漂移也不再有权威性
    const afterLegacyDrift = await (await app.request('/api/geo', { headers: { cookie } }, env)).json() as { rules: typeof legacy; authority: { source: string } };
    expect(afterLegacyDrift).toMatchObject({ rules: legacy, authority: { source: 'd1' } });
  });

  it('bootstrap 在事务前重读 legacy KV：页面候选 A 漂移为 B 时拒绝 A，重读 B 后才能线性化', async () => {
    const cookie = await login();
    await env.DB.prepare('DELETE FROM geo_rule_state').run();
    const candidateA = {
      enabled: true,
      countries: ['US'],
      blockPage: { title: { zh: '候选 A', en: 'Candidate A' }, body: { zh: '候选 A 正文', en: 'Candidate A body' } },
    };
    const candidateB = {
      enabled: true,
      countries: ['VN'],
      blockPage: { title: { zh: '候选 B', en: 'Candidate B' }, body: { zh: '候选 B 正文', en: 'Candidate B body' } },
    };
    await env.KV.put('geo:rules', JSON.stringify(candidateA));
    const shownA = await (await app.request('/api/geo', { headers: { cookie } }, env)).json() as {
      rules: typeof candidateA; authority: { candidateFingerprint: string };
    };
    await env.KV.put('geo:rules', JSON.stringify(candidateB));

    const staleBootstrap = await app.request('/api/geo/recovery', {
      method: 'POST', headers: J(cookie),
      body: JSON.stringify({
        action: 'bootstrap', rules: shownA.rules, candidateFingerprint: shownA.authority.candidateFingerprint,
        reason: '候选漂移时必须拒绝旧页面快照',
      }),
    }, env);
    expect(staleBootstrap.status).toBe(409);
    expect(await staleBootstrap.json()).toMatchObject({ error: 'geo-bootstrap-candidate-changed' });
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM geo_rule_state').first()).toMatchObject({ n: 0 });

    const shownB = await (await app.request('/api/geo', { headers: { cookie } }, env)).json() as {
      rules: typeof candidateB; authority: { candidateFingerprint: string };
    };
    expect(shownB.rules).toMatchObject(candidateB);
    const accepted = await app.request('/api/geo/recovery', {
      method: 'POST', headers: J(cookie),
      body: JSON.stringify({
        action: 'bootstrap', rules: shownB.rules, candidateFingerprint: shownB.authority.candidateFingerprint,
        reason: '重读当前候选后建立 D1 权威版本',
      }),
    }, env);
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toMatchObject({ ok: true, rules: candidateB });
  });

  it('bootstrap 最终确认时 legacy KV 不可读则明确拒绝，D1 不产生权威行', async () => {
    const cookie = await login();
    await env.DB.prepare('DELETE FROM geo_rule_state').run();
    const candidate = {
      enabled: true,
      countries: ['US'],
      blockPage: { title: { zh: '待确认候选', en: 'Pending candidate' }, body: { zh: '待确认候选正文', en: 'Pending candidate body' } },
    };
    await env.KV.put('geo:rules', JSON.stringify(candidate));
    const shown = await (await app.request('/api/geo', { headers: { cookie } }, env)).json() as {
      rules: typeof candidate; authority: { candidateFingerprint: string };
    };
    const unavailable = {
      ...env,
      KV: {
        get: async () => { throw new Error('legacy-kv-read-down'); },
        put: env.KV.put.bind(env.KV),
      } as unknown as KVNamespace,
    };
    const result = await app.request('/api/geo/recovery', {
      method: 'POST', headers: J(cookie),
      body: JSON.stringify({
        action: 'bootstrap', rules: shown.rules, candidateFingerprint: shown.authority.candidateFingerprint,
        reason: '最终确认读取失败时必须拒绝迁移',
      }),
    }, unavailable);
    expect(result.status).toBe(503);
    expect(await result.json()).toMatchObject({ error: 'geo-bootstrap-candidate-unavailable' });
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM geo_rule_state').first()).toMatchObject({ n: 0 });
  });

  it('CON12-A2 60 秒缓存有明确边界：边界前可暂存 v1，达到边界的下一次读取必须取得 D1 v2', async () => {
    const startedAt = 2_000_000_000_000;
    const now = vi.spyOn(Date, 'now').mockReturnValue(startedAt);
    try {
      resetGeoCache();
      expect(await loadRules(env)).toMatchObject({ rules: { enabled: false, countries: ['CN'] } });
      const v2 = {
        enabled: true,
        countries: ['US'],
        blockPage: { title: { zh: '第二版', en: 'Version two' }, body: { zh: '第二版正文', en: 'Version two body' } },
      };
      await setAuthority(v2, 2);
      now.mockReturnValue(startedAt + 59_999);
      expect(await loadRules(env)).toMatchObject({ rules: { enabled: false, countries: ['CN'] } });
      now.mockReturnValue(startedAt + 60_000);
      expect(await loadRules(env)).toMatchObject({ rules: { enabled: true, countries: ['US'] } });
    } finally {
      now.mockRestore();
      resetGeoCache();
    }
  });

  it('pending current 分支:KV 未接受目标写入时，reconcile 识别旧值并重放 D1 目标', async () => {
    const cookie = await login();
    const failedPutEnv = {
      ...env,
      KV: { get: env.KV.get.bind(env.KV), put: async () => { throw new Error('interrupt-before-kv-accept'); } } as unknown as KVNamespace,
    };
    const attempt = await app.request('/api/geo', {
      method: 'PUT', headers: J(cookie),
      body: JSON.stringify(await withGeoWriteMeta({ enabled: true, countries: ['US'], reason: '制造旧物化值待恢复状态' })),
    }, failedPutEnv);
    const pendingBody = await attempt.json() as { error: string; operationId: string };
    expect(attempt.status).toBe(503);
    expect(pendingBody).toMatchObject({ error: 'geo-update-recovery-required', operationId: expect.any(String) });

    const pendingState = await env.DB.prepare('SELECT status, current_rules, version FROM geo_rule_state WHERE id=1').first<{ status: string; current_rules: string; version: number }>();
    expect(pendingState).toMatchObject({ status: 'pending', version: 2 });
    expect(JSON.parse(pendingState!.current_rules)).toMatchObject({ enabled: true, countries: ['US'] });

    const recovered = await app.request('/api/geo/recovery', {
      method: 'POST', headers: J(cookie),
      body: JSON.stringify({ action: 'reconcile', operationId: pendingBody.operationId, reason: '重新物化 D1 权威目标规则' }),
    }, env);
    expect(recovered.status).toBe(200);
    expect(await recovered.json()).toMatchObject({
      ok: true, recovery: 'reconcile', observed: 'current', rules: { enabled: true, countries: ['US'] },
    });
    expect(JSON.parse((await env.KV.get('geo:rules:v2'))!)).toMatchObject({ enabled: true, countries: ['US'] });
    expect(await env.DB.prepare('SELECT status, version, pending_operation_id FROM geo_rule_state WHERE id=1').first())
      .toMatchObject({ status: 'ready', version: 2, pending_operation_id: null });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM audit WHERE action='geo.update'").first()).toMatchObject({ n: 1 });
    const applied = await env.DB.prepare("SELECT reason FROM audit WHERE action='geo.update.applied'").first<{ reason: string }>();
    expect(applied?.reason).toContain('recovery observed=current');
  });

  it('pending target 分支:KV 已接受写入但响应丢失时，reconcile 幂等重放并只完成一次 applied', async () => {
    const cookie = await login();
    const acceptedThenLost = {
      ...env,
      KV: {
        get: env.KV.get.bind(env.KV),
        put: async (key: string, value: string) => {
          await env.KV.put(key, value);
          throw new Error('interrupt-after-kv-accept');
        },
      } as unknown as KVNamespace,
    };
    const attempt = await app.request('/api/geo', {
      method: 'PUT', headers: J(cookie),
      body: JSON.stringify(await withGeoWriteMeta({ enabled: true, countries: ['US'], reason: '制造目标已物化待恢复状态' })),
    }, acceptedThenLost);
    const pendingBody = await attempt.json() as { error: string; operationId: string };
    expect(attempt.status).toBe(503);
    expect(pendingBody.error).toBe('geo-update-recovery-required');

    const recovered = await app.request('/api/geo/recovery', {
      method: 'POST', headers: J(cookie),
      body: JSON.stringify({ action: 'reconcile', operationId: pendingBody.operationId, reason: '核对并完成 D1 权威物化' }),
    }, env);
    expect(recovered.status).toBe(200);
    expect(await recovered.json()).toMatchObject({
      ok: true, recovery: 'reconcile', observed: 'target', rules: { enabled: true, countries: ['US'] },
    });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM audit WHERE action='geo.update.applied'").first()).toMatchObject({ n: 1 });
    const applied = await env.DB.prepare("SELECT reason FROM audit WHERE action='geo.update.applied'").first<{ reason: string }>();
    expect(applied?.reason).toContain('recovery observed=target');
  });

  it('reconcile 的 KV 读取和再次写入都失败时保留 pending，故障恢复后仍可从接口收口', async () => {
    const cookie = await login();
    const initialFailure = {
      ...env,
      KV: { get: env.KV.get.bind(env.KV), put: async () => { throw new Error('initial-put-failed'); } } as unknown as KVNamespace,
    };
    const attempt = await app.request('/api/geo', {
      method: 'PUT', headers: J(cookie),
      body: JSON.stringify(await withGeoWriteMeta({ enabled: true, countries: ['US'], reason: '制造可重复恢复的待物化状态' })),
    }, initialFailure);
    const pendingBody = await attempt.json() as { operationId: string };

    const recoveryStillBroken = {
      ...env,
      KV: {
        get: async () => { throw new Error('recovery-read-failed'); },
        put: async () => { throw new Error('recovery-put-failed'); },
      } as unknown as KVNamespace,
    };
    const failedRecovery = await app.request('/api/geo/recovery', {
      method: 'POST', headers: J(cookie),
      body: JSON.stringify({ action: 'reconcile', operationId: pendingBody.operationId, reason: '存储仍故障时尝试恢复待处理操作' }),
    }, recoveryStillBroken);
    expect(failedRecovery.status).toBe(503);
    expect(await failedRecovery.json()).toMatchObject({ error: 'geo-update-recovery-required', observed: 'unavailable' });
    expect(await env.DB.prepare('SELECT status, pending_operation_id FROM geo_rule_state WHERE id=1').first())
      .toMatchObject({ status: 'pending', pending_operation_id: pendingBody.operationId });

    const readStillBroken = {
      ...env,
      KV: {
        get: async () => { throw new Error('recovery-read-still-failed'); },
        put: env.KV.put.bind(env.KV),
      } as unknown as KVNamespace,
    };
    const recovered = await app.request('/api/geo/recovery', {
      method: 'POST', headers: J(cookie),
      body: JSON.stringify({ action: 'reconcile', operationId: pendingBody.operationId, reason: '写通道恢复后按 D1 权威重新物化' }),
    }, readStillBroken);
    expect(recovered.status).toBe(200);
    expect(await recovered.json()).toMatchObject({ ok: true, observed: 'unavailable', rules: { countries: ['US'] } });
    expect(await env.DB.prepare('SELECT status FROM geo_rule_state WHERE id=1').first()).toMatchObject({ status: 'ready' });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM audit WHERE action='geo.update'").first()).toMatchObject({ n: 2 });
  });

  it('KV degraded 状态已缓存也不会成为 before；PUT 仍只从 D1 权威版本构造', async () => {
    const cookie = await login();
    const brokenRead = {
      ...env,
      KV: {
        get: async () => { throw new Error('injected-kv-read-failure'); },
        put: env.KV.put.bind(env.KV),
      } as unknown as KVNamespace,
    };
    expect((await app.request('/', { headers: { ...HTML, 'x-geo-sim': 'CN' } }, brokenRead)).status).not.toBe(451);

    const result = await app.request('/api/geo', {
      method: 'PUT', headers: J(cookie),
      body: JSON.stringify(await withGeoWriteMeta({ enabled: true, countries: ['US'], reason: '验证降级缓存绝不能作为写入基线' })),
    }, brokenRead);
    expect(result.status).toBe(200);
    const audit = await env.DB.prepare("SELECT before_summary FROM audit WHERE action='geo.update.applied'").first<{ before_summary: string }>();
    expect(audit?.before_summary).toContain('enabled=false [CN]');
    expect(JSON.parse((await env.KV.get('geo:rules:v2'))!)).toMatchObject({ enabled: true, countries: ['US'] });
  });

  it('客户端编辑基线过期时按 expected version/fingerprint 拒绝整对象覆盖', async () => {
    const cookie = await login();
    const initial = await (await app.request('/api/geo', { headers: { cookie } }, env)).json() as {
      rules: typeof INITIAL_RULES;
      authority: { version: number; currentFingerprint: string };
    };
    const newerPage = {
      title: { zh: '较新的拦截标题', en: 'Newer blocking title' },
      body: { zh: '这份文案来自另一个已提交页面。', en: 'This copy came from another committed editor.' },
    };
    const newer = await app.request('/api/geo', {
      method: 'PUT', headers: J(cookie),
      body: JSON.stringify({
        enabled: false,
        countries: ['CN'],
        blockPage: newerPage,
        reason: '先提交另一标签页里的新文案',
        operationId: crypto.randomUUID(),
        expectedVersion: initial.authority.version,
        expectedFingerprint: initial.authority.currentFingerprint,
      }),
    }, env);
    expect(newer.status).toBe(200);

    const stale = await app.request('/api/geo', {
      method: 'PUT', headers: J(cookie),
      body: JSON.stringify({
        enabled: true,
        countries: initial.rules.countries,
        blockPage: initial.rules.blockPage,
        reason: '旧标签页不得覆盖已经提交的新文案',
        operationId: crypto.randomUUID(),
        expectedVersion: initial.authority.version,
        expectedFingerprint: initial.authority.currentFingerprint,
      }),
    }, env);
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ error: 'geo-update-conflict' });
    const current = await (await app.request('/api/geo', { headers: { cookie } }, env)).json() as { rules: typeof INITIAL_RULES };
    expect(current.rules.blockPage).toEqual(newerPage);
  });

  it('同 operationId 的相同请求可幂等重试，且只产生一个版本和一组审计', async () => {
    const cookie = await login();
    const initial = await (await app.request('/api/geo', { headers: { cookie } }, env)).json() as {
      authority: { version: number; currentFingerprint: string };
    };
    const operationId = crypto.randomUUID();
    const body = {
      enabled: true,
      countries: ['CN'],
      reason: '验证同一操作响应丢失后的幂等重试',
      operationId,
      expectedVersion: initial.authority.version,
      expectedFingerprint: initial.authority.currentFingerprint,
    };
    const first = await app.request('/api/geo', { method: 'PUT', headers: J(cookie), body: JSON.stringify(body) }, env);
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ operationId, rules: { updateOperationId: operationId } });

    const retry = await app.request('/api/geo', { method: 'PUT', headers: J(cookie), body: JSON.stringify(body) }, env);
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({ ok: true, idempotent: true, operationId });
    const conflictingReuse = await app.request('/api/geo', {
      method: 'PUT',
      headers: J(cookie),
      body: JSON.stringify({ ...body, countries: ['US'] }),
    }, env);
    expect(conflictingReuse.status).toBe(409);
    expect(await conflictingReuse.json()).toMatchObject({ error: 'geo-operation-id-conflict', operationId });

    const conflictingPayloads = await Promise.all([
      { ...body, reason: '同一个操作编号不能换成另一条理由' },
      { ...body, expectedVersion: body.expectedVersion + 1 },
      { ...body, expectedFingerprint: 'f'.repeat(64) },
      { ...body, highTrafficConfirmation: { operationId, fingerprint: 'e'.repeat(64) } },
    ].map((payload) => app.request('/api/geo', {
      method: 'PUT', headers: J(cookie), body: JSON.stringify(payload),
    }, env)));
    expect(conflictingPayloads.map((response) => response.status)).toEqual([409, 409, 409, 409]);
    for (const response of conflictingPayloads) {
      expect(await response.json()).toMatchObject({ error: 'geo-operation-id-conflict', operationId });
    }
    expect(await env.DB.prepare('SELECT version FROM geo_rule_state WHERE id=1').first()).toMatchObject({ version: 2 });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM audit WHERE action='geo.update.attempt'").first()).toMatchObject({ n: 1 });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM audit WHERE action='geo.update.applied'").first()).toMatchObject({ n: 1 });
  });

  it('operationId 跨后续版本永久绑定完整请求：不同摘要冲突，原请求返回既有确定结果', async () => {
    const cookie = await login();
    const operationId = crypto.randomUUID();
    const requestA = await withGeoWriteMeta({
      enabled: true,
      countries: ['US'],
      reason: '先提交操作 A 并永久绑定完整请求摘要',
    }, env.DB, operationId);
    const first = await app.request('/api/geo', {
      method: 'PUT', headers: J(cookie), body: JSON.stringify(requestA),
    }, env);
    expect(first.status).toBe(200);
    const resultA = await first.json() as {
      rules: typeof INITIAL_RULES & { updateOperationId: string };
      authority: { version: number; currentFingerprint: string };
    };

    const requestB = await withGeoWriteMeta({
      enabled: true,
      countries: ['CN'],
      reason: '随后提交操作 B 覆盖当前规则但不能抹掉 A 的账本',
    });
    expect((await app.request('/api/geo', {
      method: 'PUT', headers: J(cookie), body: JSON.stringify(requestB),
    }, env)).status).toBe(200);

    const conflictingReuse = await app.request('/api/geo', {
      method: 'PUT', headers: J(cookie),
      body: JSON.stringify({ ...requestA, reason: '复用操作 A 但偷偷替换成另一份请求' }),
    }, env);
    expect(conflictingReuse.status).toBe(409);
    expect(await conflictingReuse.json()).toMatchObject({ error: 'geo-operation-id-conflict', operationId });

    const exactReplay = await app.request('/api/geo', {
      method: 'PUT', headers: J(cookie), body: JSON.stringify(requestA),
    }, env);
    expect(exactReplay.status).toBe(200);
    expect(await exactReplay.json()).toMatchObject({
      ok: true,
      idempotent: true,
      superseded: true,
      operationId,
      rules: resultA.rules,
      authority: resultA.authority,
    });
    const current = await (await app.request('/api/geo', { headers: { cookie } }, env)).json() as { rules: typeof INITIAL_RULES };
    expect(current.rules).toMatchObject({ enabled: true, countries: ['CN'] });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM audit WHERE target=?1 AND action='geo.update.applied'").bind(`geo:rules#${operationId}`).first())
      .toMatchObject({ n: 1 });
  });

  it('ready 但 KV 缺失时可按 D1 version/fingerprint 显式重新物化', async () => {
    const cookie = await login();
    await env.KV.delete('geo:rules:v1');
    const degraded = await (await app.request('/api/geo', { headers: { cookie } }, env)).json() as {
      degraded: boolean;
      authority: { version: number; currentFingerprint: string };
    };
    expect(degraded.degraded).toBe(true);
    const operationId = crypto.randomUUID();
    const staleRepair = await app.request('/api/geo/recovery', {
      method: 'POST', headers: J(cookie),
      body: JSON.stringify({
        action: 'rematerialize-ready',
        operationId: crypto.randomUUID(),
        version: degraded.authority.version + 1,
        currentFingerprint: degraded.authority.currentFingerprint,
        reason: '拒绝与当前 D1 权威版本不匹配的恢复请求',
      }),
    }, env);
    expect(staleRepair.status).toBe(409);
    expect(await staleRepair.json()).toMatchObject({ error: 'geo-ready-rematerialization-conflict' });
    expect(await env.KV.get('geo:rules:v1')).toBeNull();
    const repaired = await app.request('/api/geo/recovery', {
      method: 'POST', headers: J(cookie),
      body: JSON.stringify({
        action: 'rematerialize-ready',
        operationId,
        version: degraded.authority.version,
        currentFingerprint: degraded.authority.currentFingerprint,
        reason: '按当前 D1 权威版本重新物化边缘规则',
      }),
    }, env);
    expect(repaired.status).toBe(200);
    expect(await repaired.json()).toMatchObject({ ok: true, recovery: 'rematerialize-ready', operationId, authority: { status: 'ready', version: 1 } });
    expect(JSON.parse((await env.KV.get('geo:rules:v1'))!)).toMatchObject(INITIAL_RULES);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM audit WHERE action='geo.update.attempt' AND target=?1").bind(`geo:rules#${operationId}`).first()).toMatchObject({ n: 1 });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM audit WHERE action='geo.update.applied' AND target=?1").bind(`geo:rules#${operationId}`).first()).toMatchObject({ n: 1 });
  });

  it('ready 重物化的 attempt 审计失败时事务回滚，KV 保持缺失且没有无痕副作用', async () => {
    const cookie = await login();
    await env.KV.delete('geo:rules:v1');
    const current = await (await app.request('/api/geo', { headers: { cookie } }, env)).json() as {
      authority: { version: number; currentFingerprint: string };
    };
    const operationId = crypto.randomUUID();
    await env.DB.prepare("CREATE TRIGGER fail_geo_ready_attempt BEFORE INSERT ON audit WHEN NEW.action='geo.update.attempt' BEGIN SELECT RAISE(ABORT, 'injected-ready-attempt-audit-failure'); END").run();
    try {
      const result = await app.request('/api/geo/recovery', {
        method: 'POST', headers: J(cookie),
        body: JSON.stringify({
          action: 'rematerialize-ready', operationId,
          version: current.authority.version,
          currentFingerprint: current.authority.currentFingerprint,
          reason: '审计不可用时绝不能先改边缘 KV',
        }),
      }, env);
      expect(result.status).toBe(503);
      expect(await result.json()).toMatchObject({ error: 'geo-update-audit-unavailable', operationId });
      expect(await env.KV.get('geo:rules:v1')).toBeNull();
      expect(await env.DB.prepare('SELECT status,pending_operation_id FROM geo_rule_state WHERE id=1').first())
        .toMatchObject({ status: 'ready', pending_operation_id: null });
      expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM audit WHERE target=?1").bind(`geo:rules#${operationId}`).first())
        .toMatchObject({ n: 0 });
    } finally {
      await env.DB.prepare('DROP TRIGGER fail_geo_ready_attempt').run();
    }
  });

  it('ready 重物化在 applied 审计失败时保留 pending 意图，故障恢复后可按同 operationId 收口', async () => {
    const cookie = await login();
    await env.KV.delete('geo:rules:v1');
    const current = await (await app.request('/api/geo', { headers: { cookie } }, env)).json() as {
      authority: { version: number; currentFingerprint: string };
    };
    const operationId = crypto.randomUUID();
    await env.DB.prepare("CREATE TRIGGER fail_geo_ready_applied BEFORE INSERT ON audit WHEN NEW.action='geo.update.applied' BEGIN SELECT RAISE(ABORT, 'injected-ready-applied-audit-failure'); END").run();
    try {
      const result = await app.request('/api/geo/recovery', {
        method: 'POST', headers: J(cookie),
        body: JSON.stringify({
          action: 'rematerialize-ready', operationId,
          version: current.authority.version,
          currentFingerprint: current.authority.currentFingerprint,
          reason: '最终审计失败时保留可恢复操作意图',
        }),
      }, env);
      expect(result.status).toBe(503);
      expect(await result.json()).toMatchObject({ error: 'geo-update-recovery-required', operationId });
      expect(JSON.parse((await env.KV.get('geo:rules:v1'))!)).toMatchObject(INITIAL_RULES);
      expect(await env.DB.prepare('SELECT status,version,pending_operation_id FROM geo_rule_state WHERE id=1').first())
        .toMatchObject({ status: 'pending', version: 1, pending_operation_id: operationId });
      expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM audit WHERE action='geo.update.attempt' AND target=?1").bind(`geo:rules#${operationId}`).first())
        .toMatchObject({ n: 1 });
    } finally {
      await env.DB.prepare('DROP TRIGGER fail_geo_ready_applied').run();
    }

    const recovered = await app.request('/api/geo/recovery', {
      method: 'POST', headers: J(cookie),
      body: JSON.stringify({ action: 'reconcile', operationId, reason: '审计恢复后完成同一重物化操作' }),
    }, env);
    expect(recovered.status).toBe(200);
    expect(await recovered.json()).toMatchObject({ ok: true, operationId, authority: { status: 'ready', version: 1 } });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM audit WHERE action='geo.update.applied' AND target=?1").bind(`geo:rules#${operationId}`).first())
      .toMatchObject({ n: 1 });
  });

  it('ready 重物化不得复用旧 PUT ledger ID；拒绝前不改状态/KV，新 ID 仍可 pending 后 reconcile', async () => {
    const cookie = await login();
    const oldPutOperationId = crypto.randomUUID();
    const put = await app.request('/api/geo', {
      method: 'PUT', headers: J(cookie),
      body: JSON.stringify(await withGeoWriteMeta({
        enabled: true,
        countries: ['US'],
        reason: '建立一个已完成的旧 PUT 操作账本',
      }, env.DB, oldPutOperationId)),
    }, env);
    expect(put.status).toBe(200);
    const ready = await put.json() as { authority: { version: number; currentFingerprint: string } };
    await env.DB.prepare('DELETE FROM audit WHERE target=?1').bind(`geo:rules#${oldPutOperationId}`).run();
    await env.KV.delete(`geo:rules:v${ready.authority.version}`);

    const collision = await app.request('/api/geo/recovery', {
      method: 'POST', headers: J(cookie),
      body: JSON.stringify({
        action: 'rematerialize-ready',
        operationId: oldPutOperationId,
        version: ready.authority.version,
        currentFingerprint: ready.authority.currentFingerprint,
        reason: '旧 PUT 操作编号不能改作重物化操作',
      }),
    }, env);
    expect(collision.status).toBe(409);
    expect(await collision.json()).toMatchObject({ error: 'geo-operation-id-conflict', operationId: oldPutOperationId });
    expect(await env.DB.prepare('SELECT status,pending_operation_id FROM geo_rule_state WHERE id=1').first())
      .toMatchObject({ status: 'ready', pending_operation_id: null });
    expect(await env.KV.get(`geo:rules:v${ready.authority.version}`)).toBeNull();

    const newOperationId = crypto.randomUUID();
    const brokenKvEnv = {
      ...env,
      KV: {
        get: env.KV.get.bind(env.KV),
        put: async () => { throw new Error('injected-new-rematerialization-put-failure'); },
      } as unknown as KVNamespace,
    };
    const pending = await app.request('/api/geo/recovery', {
      method: 'POST', headers: J(cookie),
      body: JSON.stringify({
        action: 'rematerialize-ready',
        operationId: newOperationId,
        version: ready.authority.version,
        currentFingerprint: ready.authority.currentFingerprint,
        reason: '新操作编号在 KV 故障后必须保持可恢复',
      }),
    }, brokenKvEnv);
    expect(pending.status).toBe(503);
    expect(await pending.json()).toMatchObject({ error: 'geo-update-recovery-required', operationId: newOperationId });
    expect(await env.DB.prepare('SELECT status,pending_operation_id FROM geo_rule_state WHERE id=1').first())
      .toMatchObject({ status: 'pending', pending_operation_id: newOperationId });

    const recovered = await app.request('/api/geo/recovery', {
      method: 'POST', headers: J(cookie),
      body: JSON.stringify({ action: 'reconcile', operationId: newOperationId, reason: '用新编号恢复重物化操作并完成审计' }),
    }, env);
    expect(recovered.status).toBe(200);
    expect(await recovered.json()).toMatchObject({ ok: true, operationId: newOperationId, authority: { status: 'ready' } });
    expect(await env.DB.prepare('SELECT status,pending_operation_id FROM geo_rule_state WHERE id=1').first())
      .toMatchObject({ status: 'ready', pending_operation_id: null });
  });

  it('跨 isolate 陈旧 D1 快照:条件版本更新拒绝旧整对象覆盖较新权威规则', async () => {
    const cookie = await login();
    const staleRow = await env.DB.prepare('SELECT * FROM geo_rule_state WHERE id=1')
      .first<Record<string, unknown> & { version: number; current_fingerprint: string }>();
    await enableCN(cookie);
    const committed = await env.DB.prepare('SELECT current_rules, version FROM geo_rule_state WHERE id=1').first<{ current_rules: string; version: number }>();
    let stateReads = 0;
    let putCalls = 0;
    const staleDb = {
      prepare: (sql: string) => {
        if (sql.includes('FROM geo_rule_state WHERE id=1') && stateReads++ === 0) {
          return { first: async () => staleRow } as unknown as D1PreparedStatement;
        }
        return env.DB.prepare(sql);
      },
      batch: env.DB.batch.bind(env.DB),
    } as unknown as D1Database;
    const staleReplica = {
      ...env,
      DB: staleDb,
      KV: {
        get: async () => null,
        put: async () => { putCalls++; },
      } as unknown as KVNamespace,
    };
    const result = await app.request('/api/geo', {
      method: 'PUT', headers: J(cookie),
      body: JSON.stringify({
        enabled: true,
        countries: ['US'],
        reason: '验证陈旧 D1 快照写入会被版本拒绝',
        operationId: crypto.randomUUID(),
        expectedVersion: staleRow!.version,
        expectedFingerprint: staleRow!.current_fingerprint,
      }),
    }, staleReplica);
    expect(result.status).toBe(409);
    expect(await result.json()).toMatchObject({ error: 'geo-update-conflict' });
    expect(putCalls).toBe(0);
    const after = await env.DB.prepare('SELECT current_rules, version, status FROM geo_rule_state WHERE id=1').first<{ current_rules: string; version: number; status: string }>();
    expect(after).toMatchObject({ current_rules: committed!.current_rules, version: committed!.version, status: 'ready' });
  });

  it('迟到的旧物化写只落旧版本 key，不能覆盖恢复后提交的更新版本', async () => {
    const cookie = await login();
    let releaseOldWrite!: () => void;
    let signalOldWrite!: () => void;
    const oldWriteEntered = new Promise<void>((resolve) => { signalOldWrite = resolve; });
    const oldWriteGate = new Promise<void>((resolve) => { releaseOldWrite = resolve; });
    const delayedMaterializer = {
      ...env,
      KV: {
        get: env.KV.get.bind(env.KV),
        put: async (key: string, value: string) => {
          signalOldWrite();
          await oldWriteGate;
          await env.KV.put(key, value);
        },
      } as unknown as KVNamespace,
    };
    const oldRequest = app.request('/api/geo', {
      method: 'PUT', headers: J(cookie),
      body: JSON.stringify(await withGeoWriteMeta({ enabled: true, countries: ['US'], reason: '制造会迟到的旧版本物化写入' })),
    }, delayedMaterializer);
    await oldWriteEntered;
    const pending = await env.DB.prepare('SELECT pending_operation_id FROM geo_rule_state WHERE id=1').first<{ pending_operation_id: string }>();

    const recovered = await app.request('/api/geo/recovery', {
      method: 'POST', headers: J(cookie),
      body: JSON.stringify({ action: 'reconcile', operationId: pending!.pending_operation_id, reason: '先恢复旧操作再提交下一版本' }),
    }, env);
    expect(recovered.status).toBe(200);
    const newer = await app.request('/api/geo', {
      method: 'PUT', headers: J(cookie),
      body: JSON.stringify(await withGeoWriteMeta({ enabled: true, countries: ['VN'], reason: '提交不可被迟到写覆盖的新版本' })),
    }, env);
    expect(newer.status).toBe(200);

    releaseOldWrite();
    expect((await oldRequest).status).toBe(503);
    expect(JSON.parse((await env.KV.get('geo:rules:v2'))!)).toMatchObject({ countries: ['US'] });
    expect(JSON.parse((await env.KV.get('geo:rules:v3'))!)).toMatchObject({ countries: ['VN'] });
    const authority = await env.DB.prepare('SELECT version, status, current_rules FROM geo_rule_state WHERE id=1').first<{ version: number; status: string; current_rules: string }>();
    expect(authority).toMatchObject({ version: 3, status: 'ready' });
    expect(JSON.parse(authority!.current_rules)).toMatchObject({ countries: ['VN'] });
    resetGeoCache();
    expect((await app.request('/', { headers: { ...HTML, 'x-geo-sim': 'US' } }, env)).status).not.toBe(451);
    expect((await app.request('/', { headers: { ...HTML, 'x-geo-sim': 'VN' } }, env)).status).toBe(451);
  });

  it('Geo 更新先写 attempt；attempt 审计失败时 D1 事务回滚且绝不触碰 KV', async () => {
    const cookie = await login();
    await env.DB.prepare(
      "CREATE TRIGGER fail_geo_attempt_audit BEFORE INSERT ON audit WHEN NEW.action='geo.update.attempt' BEGIN SELECT RAISE(ABORT, 'injected-geo-attempt-audit-failure'); END",
    ).run();
    try {
      const result = await app.request('/api/geo', {
        method: 'PUT', headers: J(cookie),
        body: JSON.stringify(await withGeoWriteMeta({ enabled: true, countries: ['CN'], reason: '验证审计失败不会落下无记录规则' })),
      }, env);
      expect(result.status).toBe(500);
      expect(await env.KV.get('geo:rules:v2')).toBeNull();
      expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM audit WHERE action LIKE 'geo.update.%'").first()).toMatchObject({ n: 0 });
      expect(await env.DB.prepare('SELECT status, version FROM geo_rule_state WHERE id=1').first())
        .toMatchObject({ status: 'ready', version: 1 });
    } finally {
      await env.DB.prepare('DROP TRIGGER fail_geo_attempt_audit').run();
    }
  });

  it('applied 审计失败保留 pending；修复故障后 recovery 可完成，不需手改 D1', async () => {
    const cookie = await login();
    await env.DB.prepare(
      "CREATE TRIGGER fail_geo_applied_audit BEFORE INSERT ON audit WHEN NEW.action='geo.update.applied' BEGIN SELECT RAISE(ABORT, 'injected-geo-applied-audit-failure'); END",
    ).run();
    const result = await app.request('/api/geo', {
      method: 'PUT', headers: J(cookie),
      body: JSON.stringify(await withGeoWriteMeta({ enabled: true, countries: ['CN'], reason: '验证应用审计失败留下可恢复状态' })),
    }, env);
    const body = await result.json() as { error: string; operationId: string };
    expect(result.status).toBe(503);
    expect(body).toMatchObject({ error: 'geo-update-recovery-required', operationId: expect.any(String) });
    expect(await env.DB.prepare('SELECT status, pending_operation_id FROM geo_rule_state WHERE id=1').first())
      .toMatchObject({ status: 'pending', pending_operation_id: body.operationId });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM audit WHERE action='geo.update.attempt'").first()).toMatchObject({ n: 1 });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM audit WHERE action='geo.update.applied'").first()).toMatchObject({ n: 0 });

    await env.DB.prepare('DROP TRIGGER fail_geo_applied_audit').run();
    const recovered = await app.request('/api/geo/recovery', {
      method: 'POST', headers: J(cookie),
      body: JSON.stringify({ action: 'reconcile', operationId: body.operationId, reason: '审计恢复后完成边缘物化状态' }),
    }, env);
    expect(recovered.status).toBe(200);
    expect(await recovered.json()).toMatchObject({ ok: true, observed: 'target' });
    expect(await env.DB.prepare('SELECT status FROM geo_rule_state WHERE id=1').first()).toMatchObject({ status: 'ready' });
  });
  it('E3 KV 异常时回退 D1 权威；只有 D1 也不可用才启用内置 CN 基线', async () => {
    const cookie = await login();
    resetGeoCache();
    const broken = { ...env, KV: { ...env.KV, get: () => Promise.reject(new Error('kv down')) } } as typeof env;
    const res = await app.request('/', { headers: { ...HTML, 'x-geo-sim': 'CN' } }, broken);
    expect(res.status).not.toBe(451); // D1 当前权威是关闭，不能因 KV 故障反转规则
    resetGeoCache();
    const st = await app.request('/api/geo', { headers: { cookie } }, broken);
    expect((await st.json()) as { degraded: boolean; rules: { enabled: boolean } }).toMatchObject({ degraded: true, rules: { enabled: false } });
    resetGeoCache();
    const unavailableStatement = { first: async () => { throw new Error('d1 down'); } } as unknown as D1PreparedStatement;
    const bothBroken = {
      ...broken,
      DB: {
        prepare: (sql: string) => sql.includes('FROM geo_rule_state') ? unavailableStatement : env.DB.prepare(sql),
      } as unknown as D1Database,
    };
    expect((await app.request('/', { headers: { ...HTML, 'x-geo-sim': 'CN' } }, bothBroken)).status).toBe(451);
    expect((await app.request('/', { headers: { ...HTML, 'x-geo-sim': 'US' } }, bothBroken)).status).not.toBe(451);
    resetGeoCache();
  });

  it('A2/E2 规则变更:理由必填;高流量国家须显式确认;回读确认;审计 before/after', async () => {
    const cookie = await login();
    // 造 7 天流量:VN 90%,US 10%
    await env.DB.prepare("INSERT INTO daily_traffic (date, locale, country, device, ref_class, pv, uv, sessions) VALUES (date('now','-1 day'),'vi','VN','m','direct',90,50,60),(date('now','-1 day'),'en','US','d','direct',10,8,9)").run();
    const noReason = await app.request('/api/geo', {
      method: 'PUT', headers: J(cookie), body: JSON.stringify(await withGeoWriteMeta({ enabled: true, countries: ['CN'] })),
    }, env);
    expect(noReason.status).toBe(400);
    const operationId = crypto.randomUUID();
    const requestBody = await withGeoWriteMeta(
      { enabled: true, countries: ['CN', 'VN'], reason: '误伤护栏测试用例' },
      env.DB,
      operationId,
    );
    const hot = await app.request('/api/geo', { method: 'PUT', headers: J(cookie), body: JSON.stringify(requestBody) }, env);
    expect(hot.status).toBe(409);
    const hotBody = (await hot.json()) as { hot: Array<{ country: string; share: number }>; confirmationFingerprint: string };
    expect(hotBody.hot[0]).toMatchObject({ country: 'VN' });
    expect(hotBody.hot[0]!.share).toBeCloseTo(0.9, 2);
    const confirmed = await app.request('/api/geo', {
      method: 'PUT',
      headers: J(cookie),
      body: JSON.stringify({
        ...requestBody,
        highTrafficConfirmation: { operationId, fingerprint: hotBody.confirmationFingerprint },
      }),
    }, env);
    expect(confirmed.status).toBe(200);
    const confirmedBody = await confirmed.json() as { operationId: string };
    resetGeoCache();
    expect((await app.request('/', { headers: { ...HTML, 'x-geo-sim': 'VN' } }, env)).status).toBe(451);
    const audit = await env.DB.prepare("SELECT before_summary, after_summary, reason FROM audit WHERE action='geo.update.applied' ORDER BY id DESC LIMIT 1").first<{ before_summary: string; after_summary: string; reason: string }>();
    expect(audit!.after_summary).toContain('VN');
    expect(audit!.reason).toContain('护栏');
    const lifecycle = await env.DB.prepare("SELECT action,target FROM audit WHERE action IN ('geo.update.attempt','geo.update.applied') ORDER BY id").all();
    expect(lifecycle.results).toEqual([
      { action: 'geo.update.attempt', target: `geo:rules#${confirmedBody.operationId}` },
      { action: 'geo.update.applied', target: `geo:rules#${confirmedBody.operationId}` },
    ]);
    expect(JSON.parse((await env.KV.get('geo:rules:v2'))!) as { updateOperationId: string }).toMatchObject({ updateOperationId: confirmedBody.operationId });
    // 未登录不可改
    expect((await app.request('/api/geo', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{}' }, env)).status).toBe(401);
  });

  it('disabled→enabled 时把名单内已有高流量国家也视为本次变成被拦', async () => {
    const cookie = await login();
    await env.DB.prepare("INSERT INTO daily_traffic (date, locale, country, device, ref_class, pv, uv, sessions) VALUES (date('now','-1 day'),'zh','CN','m','direct',90,50,60),(date('now','-1 day'),'en','US','d','direct',10,8,9)").run();
    const initial = await (await app.request('/api/geo', { headers: { cookie } }, env)).json() as {
      authority: { version: number; currentFingerprint: string };
    };
    const operationId = crypto.randomUUID();
    const first = await app.request('/api/geo', {
      method: 'PUT', headers: J(cookie),
      body: JSON.stringify({
        enabled: true,
        countries: ['CN'],
        reason: '开启已有高流量名单必须二次确认',
        operationId,
        expectedVersion: initial.authority.version,
        expectedFingerprint: initial.authority.currentFingerprint,
      }),
    }, env);
    expect(first.status).toBe(409);
    const challenge = await first.json() as { operationId: string; confirmationFingerprint: string; hot: Array<{ country: string }> };
    expect(challenge).toMatchObject({
      error: 'need-confirm-high-traffic',
      operationId,
      confirmationFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
      hot: [{ country: 'CN' }],
    });

    const editedAfterChallenge = await app.request('/api/geo', {
      method: 'PUT', headers: J(cookie),
      body: JSON.stringify({
        enabled: true,
        countries: ['CN', 'US'],
        reason: '旧确认不能用于编辑后的另一份规则快照',
        operationId,
        expectedVersion: initial.authority.version,
        expectedFingerprint: initial.authority.currentFingerprint,
        highTrafficConfirmation: { operationId, fingerprint: challenge.confirmationFingerprint },
      }),
    }, env);
    expect(editedAfterChallenge.status).toBe(409);
    expect(await editedAfterChallenge.json()).toMatchObject({
      error: 'need-confirm-high-traffic',
      operationId,
      confirmationFingerprint: expect.not.stringMatching(challenge.confirmationFingerprint),
    });

    const confirmed = await app.request('/api/geo', {
      method: 'PUT', headers: J(cookie),
      body: JSON.stringify({
        enabled: true,
        countries: ['CN'],
        reason: '开启已有高流量名单必须二次确认',
        operationId,
        expectedVersion: initial.authority.version,
        expectedFingerprint: initial.authority.currentFingerprint,
        highTrafficConfirmation: { operationId, fingerprint: challenge.confirmationFingerprint },
      }),
    }, env);
    expect(confirmed.status).toBe(200);
  });

  it('高流量确认绑定操作者看到的国家与占比快照，新增国家跨阈值后旧确认失效', async () => {
    const cookie = await login();
    await env.DB.prepare("INSERT INTO daily_traffic (date, locale, country, device, ref_class, pv, uv, sessions) VALUES (date('now','-1 day'),'zh','CN','m','direct',90,50,60),(date('now','-1 day'),'en','US','d','direct',1,1,1)").run();
    const operationId = crypto.randomUUID();
    const requestBody = await withGeoWriteMeta({
      enabled: true,
      countries: ['US', 'CN'],
      reason: '确认必须绑定当时看到的高流量快照',
    }, env.DB, operationId);
    const first = await app.request('/api/geo', {
      method: 'PUT', headers: J(cookie), body: JSON.stringify(requestBody),
    }, env);
    expect(first.status).toBe(409);
    const firstChallenge = await first.json() as {
      hot: Array<{ country: string; share: number }>;
      confirmationFingerprint: string;
    };
    expect(firstChallenge.hot.map(({ country }) => country)).toEqual(['CN']);

    await env.DB.prepare("UPDATE daily_traffic SET pv=100 WHERE country='US'").run();
    const staleConfirmation = await app.request('/api/geo', {
      method: 'PUT', headers: J(cookie),
      body: JSON.stringify({
        ...requestBody,
        highTrafficConfirmation: { operationId, fingerprint: firstChallenge.confirmationFingerprint },
      }),
    }, env);
    expect(staleConfirmation.status).toBe(409);
    const nextChallenge = await staleConfirmation.json() as {
      error: string;
      hot: Array<{ country: string; share: number }>;
      confirmationFingerprint: string;
    };
    expect(nextChallenge.error).toBe('need-confirm-high-traffic');
    expect(nextChallenge.hot.map(({ country }) => country)).toEqual(['CN', 'US']);
    expect(nextChallenge.confirmationFingerprint).not.toBe(firstChallenge.confirmationFingerprint);

    const confirmed = await app.request('/api/geo', {
      method: 'PUT', headers: J(cookie),
      body: JSON.stringify({
        ...requestBody,
        highTrafficConfirmation: { operationId, fingerprint: nextChallenge.confirmationFingerprint },
      }),
    }, env);
    expect(confirmed.status).toBe(200);
  });

  it('GET /api/geo 统计口径:last7/todayLive/占比', async () => {
    const cookie = await login();
    await enableCN(cookie);
    for (let i = 0; i < 3; i++) await app.request('/', { headers: { ...HTML, 'x-geo-sim': 'CN' } }, env);
    await new Promise((r) => setTimeout(r, 80));
    const st = (await (await app.request('/api/geo', { headers: { cookie } }, env)).json()) as { stats: { todayLive: number } };
    expect(st.stats.todayLive).toBe(3);
  });

  it('blocked 生产者按共享 UTF-8 合同写 bot，Googlebot 不进入 Geo 今日实时值或日汇总', async () => {
    const cookie = await login();
    await enableCN(cookie);
    const emojiSegment = '😀'.repeat(7);
    const crawler = await app.request(`/${emojiSegment}`, {
      headers: {
        ...HTML,
        'x-geo-sim': 'CN',
        'cf-connecting-ip': '203.0.113.91',
        'user-agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
      },
    }, env);
    const human = await app.request('/human', {
      headers: {
        ...HTML,
        'x-geo-sim': 'CN',
        'cf-connecting-ip': '203.0.113.92',
        'user-agent': 'Mozilla/5.0 Chrome/140.0 Safari/537.36',
      },
    }, env);
    expect([crawler.status, human.status]).toEqual([451, 451]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    await env.DB.prepare("INSERT INTO raw_events (ts,type,uid,payload) VALUES (?1,'blocked',NULL,?2)")
      .bind(Date.now(), JSON.stringify({ t: 'blocked', c: 'CN', p: 'legacy' }))
      .run();

    const events = await env.DB.prepare("SELECT payload FROM raw_events WHERE type='blocked' ORDER BY id").all<{ payload: string }>();
    const payloads = events.results.map(({ payload }) => JSON.parse(payload) as { t: string; c: string; p: string; bot?: number });
    expect(payloads).toEqual([
      { t: 'blocked', c: 'CN', p: '😀'.repeat(6), bot: 1 },
      { t: 'blocked', c: 'CN', p: 'human', bot: 0 },
      { t: 'blocked', c: 'CN', p: 'legacy' },
    ]);
    for (const payload of payloads) expect(new TextEncoder().encode(payload.p).byteLength).toBeLessThanOrEqual(24);

    const live = await (await app.request('/api/geo', { headers: { cookie } }, env)).json() as { stats: { todayLive: number } };
    expect(live.stats.todayLive).toBe(2);
    const day = new Date().toISOString().slice(0, 10);
    const rollup = await runDailyRollup(env.DB, day);
    expect(rollup).toMatchObject({ scannedEvents: 3, processedEvents: 3, rejectedEvents: 0 });
    expect(await env.DB.prepare('SELECT hits FROM daily_blocked WHERE date=?1 AND country=?2').bind(day, 'CN').first())
      .toMatchObject({ hits: 2 });
  });
});
