// T2 验收(plan T2-AC1..AC4;继承 PRD CON01-A1/E1/E2/E3/E4 + CON14-A1/E2)。
// pool-workers 0.22 无 per-test 隔离存储 → beforeEach 显式清表,每条测试自建全部状态。
import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { app } from '../src/index';

beforeEach(async () => {
  for (const t of ['audit', 'sessions', 'login_throttle', 'auth_account']) {
    await env.DB.prepare(`DELETE FROM ${t}`).run();
  }
});

const IP = { 'cf-connecting-ip': '203.0.113.7', 'content-type': 'application/json' };
const PW = 'correct-horse-battery';

async function setup(password = PW) {
  return app.request(
    '/api/auth/setup',
    { method: 'POST', headers: IP, body: JSON.stringify({ token: env.SETUP_TOKEN, password }) },
    env,
  );
}

async function login(password: string, ip = '203.0.113.7') {
  return app.request(
    '/api/auth/login',
    {
      method: 'POST',
      headers: { 'cf-connecting-ip': ip, 'content-type': 'application/json' },
      body: JSON.stringify({ password }),
    },
    env,
  );
}

function sidCookie(res: Response): string {
  const sc = res.headers.get('set-cookie') ?? '';
  const m = sc.match(/nx_sid=([^;]+)/);
  return m ? `nx_sid=${m[1]}` : '';
}

async function auditActions(): Promise<string[]> {
  const rows = await env.DB.prepare('SELECT action FROM audit ORDER BY id').all<{ action: string }>();
  return rows.results.map((r) => r.action);
}

describe('CON01 初始化与登录', () => {
  it('AC1 正确口令登录:会话 cookie 属性齐 + 审计 login.success', async () => {
    await setup();
    const res = await login(PW);
    expect(res.status).toBe(200);
    const sc = res.headers.get('set-cookie') ?? '';
    expect(sc).toContain('nx_sid=');
    expect(sc).toContain('HttpOnly');
    expect(sc).toContain('Secure');
    expect(sc.toLowerCase()).toContain('samesite=lax');
    expect(sc).toContain('Max-Age=604800'); // 7 天
    expect(await auditActions()).toContain('login.success');
    // 会话可用:受保护探针 200
    const me = await app.request('/api/me', { headers: { cookie: sidCookie(res) } }, env);
    expect(me.status).toBe(200);
  });

  it('AC2a 错误口令:401 通用报错(不泄露字段)+ 审计 login.fail', async () => {
    await setup();
    const res = await login('wrong-password-xxxx');
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('invalid-credentials');
    expect(await auditActions()).toContain('login.fail');
  });

  it('AC2b 限速:5 次失败后锁定,正确口令也拒(429);另一 IP 不受连坐', async () => {
    await setup();
    for (let i = 0; i < 5; i++) expect((await login('wrong-password-xxxx')).status).toBe(401);
    expect((await login(PW)).status).toBe(429); // 锁内正确口令也拒
    expect((await login(PW, '198.51.100.9')).status).toBe(200); // 其它 IP 正常
    // 锁到期后恢复(直接把 locked_until 拨到过去——时间是数据不是魔法)
    await env.DB.prepare('UPDATE login_throttle SET locked_until = ?1 WHERE key = ?2')
      .bind(Date.now() - 1000, '203.0.113.7')
      .run();
    expect((await login(PW)).status).toBe(200);
  });

  it('AC3a 会话过期 → 401;登出后旧会话失效', async () => {
    await setup();
    const res = await login(PW);
    const cookie = sidCookie(res);
    await env.DB.prepare('UPDATE sessions SET expires_at = ?1').bind(Date.now() - 1000).run();
    expect((await app.request('/api/me', { headers: { cookie } }, env)).status).toBe(401);
    // 重新登录 → 登出 → 旧 cookie 失效
    const res2 = await login(PW);
    const cookie2 = sidCookie(res2);
    const out = await app.request('/api/auth/logout', { method: 'POST', headers: { cookie: cookie2 } }, env);
    expect(out.status).toBe(200);
    expect((await app.request('/api/me', { headers: { cookie: cookie2 } }, env)).status).toBe(401);
    expect(await auditActions()).toContain('auth.logout');
  });

  it('E4 状态探针:初始化前 false / 后 true(T10-P1 回归:setup 页访问即知)', async () => {
    const before = (await (await app.request('/api/auth/state', {}, env)).json()) as { initialized: boolean };
    expect(before.initialized).toBe(false);
    await setup();
    const after = (await (await app.request('/api/auth/state', {}, env)).json()) as { initialized: boolean };
    expect(after.initialized).toBe(true);
  });

  it('AC3b 未初始化受保护路由不可达;/setup 初始化后 410;错 token 403;短口令 400', async () => {
    expect((await app.request('/api/me', {}, env)).status).toBe(401);
    const bad = await app.request(
      '/api/auth/setup',
      { method: 'POST', headers: IP, body: JSON.stringify({ token: 'wrong', password: PW }) },
      env,
    );
    expect(bad.status).toBe(403);
    const short = await app.request(
      '/api/auth/setup',
      { method: 'POST', headers: IP, body: JSON.stringify({ token: env.SETUP_TOKEN, password: 'short' }) },
      env,
    );
    expect(short.status).toBe(400);
    expect((await setup()).status).toBe(200);
    expect((await setup()).status).toBe(410); // E4:永久失效
    expect(await auditActions()).toContain('auth.setup');
  });
});

describe('CON14 审计底座', () => {
  it('AC4a 只读可查(过滤+游标),无任何变更路由(404)', async () => {
    await setup();
    const res = await login(PW);
    const cookie = sidCookie(res);
    const list = await app.request('/api/audit?action=login.', { headers: { cookie } }, env);
    expect(list.status).toBe(200);
    const body = (await list.json()) as { items: Array<{ action: string }> };
    expect(body.items.length).toBeGreaterThan(0);
    expect(body.items.every((r) => r.action.startsWith('login.'))).toBe(true);
    // append-only:不存在修改/删除面(CON14-E2)
    for (const method of ['PUT', 'PATCH', 'DELETE'] as const) {
      const r = await app.request('/api/audit/1', { method, headers: { cookie } }, env);
      expect(r.status, `${method} 不该存在`).toBe(404);
    }
    // 未登录不可读
    expect((await app.request('/api/audit', {}, env)).status).toBe(401);
  });

  it('AC4b 敏感值不入审计:全表扫描不出现口令与会话令牌', async () => {
    await setup();
    const res = await login(PW);
    const token = sidCookie(res).replace('nx_sid=', '');
    expect(token.length).toBeGreaterThan(10); // 登录必须真成功,防空串让 not.toContain 恒假
    const rows = await env.DB.prepare('SELECT * FROM audit').all();
    const dump = JSON.stringify(rows.results);
    expect(dump).not.toContain(PW);
    expect(dump).not.toContain(token);
    const account = await env.DB.prepare('SELECT password_hash FROM auth_account WHERE id=1').first<{ password_hash: string }>();
    expect(dump).not.toContain(account!.password_hash);
  });
});

// 安全评审 HIGH/MEDIUM/LOW 回归(2026-08-31 修复的针对性门)
describe('限速与硬化回归', () => {
  it('HIGH 并发爆破:N 个并发错口令,放行验证的最多 5 次,其余 429', async () => {
    // ⚠️ 诚实局限:本地 workerd 会把同进程并发近乎串行化,故此测试在本地对新旧实现都会绿;
    // 竞态真正的防线是 registerAttempt 的原子 UPSERT(单条 SQL、D1 单写者串行,check-then-act 间隙不存在),
    // 那是静态可验证的。此门的价值:①锁定计数正确性 ②在能真并发的环境(生产/CI)成为有效回归门。
    await setup();
    const results = await Promise.all(
      Array.from({ length: 20 }, () => login('wrong-password-xxxx').then((r) => r.status)),
    );
    const n401 = results.filter((s) => s === 401).length;
    const n429 = results.filter((s) => s === 429).length;
    expect(n401).toBeLessThanOrEqual(5); // 绝不允许 >5 次口令校验被放行
    expect(n401 + n429).toBe(20); // 每个请求都有确定结果,无异常
    expect(n429).toBeGreaterThan(0); // 确实触发了锁定
  });

  it('429 带解锁倒计时数据(Retry-After 头 + retryAfterSec)', async () => {
    await setup();
    for (let i = 0; i < 5; i++) await login('wrong-password-xxxx');
    const res = await login('wrong-password-xxxx');
    expect(res.status).toBe(429);
    expect(Number(res.headers.get('Retry-After'))).toBeGreaterThan(0);
    const body = (await res.json()) as { retryAfterSec: number };
    expect(body.retryAfterSec).toBeGreaterThan(0);
    expect(body.retryAfterSec).toBeLessThanOrEqual(15 * 60);
  });

  it('MEDIUM setup 限速:错 token 5 次后第 6 次 429(未初始化态)', async () => {
    const bad = () =>
      app.request(
        '/api/auth/setup',
        { method: 'POST', headers: IP, body: JSON.stringify({ token: 'wrong-token', password: PW }) },
        env,
      );
    for (let i = 0; i < 5; i++) expect((await bad()).status).toBe(403);
    expect((await bad()).status).toBe(429);
  });

  it('LOW 密码超长(>256)被拒 400', async () => {
    const res = await app.request(
      '/api/auth/setup',
      { method: 'POST', headers: IP, body: JSON.stringify({ token: env.SETUP_TOKEN, password: 'a'.repeat(257) }) },
      env,
    );
    expect(res.status).toBe(400);
  });

  it('LOW logout 清 cookie 镜像安全属性', async () => {
    await setup();
    const res = await login(PW);
    const out = await app.request('/api/auth/logout', { method: 'POST', headers: { cookie: sidCookie(res) } }, env);
    const sc = out.headers.get('set-cookie') ?? '';
    expect(sc).toContain('nx_sid=');
    expect(sc).toContain('HttpOnly');
    expect(sc).toContain('Secure');
    expect(sc.toLowerCase()).toContain('samesite=lax');
    expect(sc).toContain('Max-Age=0');
  });
});

/* CON14-② A1「按类型**与时间**过滤」——第十轮独立验收 P1-5/P1-6:
   「发布」这一类根本建不出来(单前缀过滤的限制),时间过滤一个输入都没有。
   钉的是**契约里那四类各自能查出自己的记录**,不是某个具体前缀写法。 */
describe('CON14 审计过滤(类别 + 时间)', () => {
  it('「发布」是独立一类,不再混进「内容改动」', async () => {
    await setup();
    const cookie = sidCookie(await login(PW));
    const now = Date.now();
    for (const [action, ts] of [
      ['config.save', now - 3000],
      ['config.publish', now - 2000],
      ['config.publish.live', now - 1000],
      ['config.rollback', now - 500],
      ['geo.update', now - 400],
    ] as const) {
      await env.DB.prepare('INSERT INTO audit (ts, actor, action) VALUES (?1, ?2, ?3)').bind(ts, 'admin', action).run();
    }
    const get = async (q: string) =>
      ((await (await app.request(`/api/audit?${q}`, { headers: { cookie } }, env)).json()) as { items: Array<{ action: string }> }).items;

    const pub = await get('group=publish');
    expect(pub.map((r) => r.action).sort()).toEqual(['config.publish', 'config.publish.live', 'config.rollback']);
    // 「内容改动」里不该再混进发布类
    const content = await get('group=content');
    expect(content.every((r) => r.action === 'config.save')).toBe(true);
    expect(content.some((r) => r.action.startsWith('config.publish')), '发布记录混进了内容类').toBe(false);
    // 登录与账号合成一类(查一次会话进出不必点两个页签)
    const session = await get('group=session');
    expect(session.every((r) => /^(login|auth)\./.test(r.action))).toBe(true);
    // 不认识的类别要明确拒绝,不能当成「无过滤」把全部记录倒出来
    expect((await app.request('/api/audit?group=nope', { headers: { cookie } }, env)).status).toBe(400);
  });

  it('时间窗过滤:只返回窗内记录,两端都含', async () => {
    await setup();
    const cookie = sidCookie(await login(PW));
    const base = 1_780_000_000_000;
    for (const ts of [base - 1000, base, base + 500, base + 1000, base + 2000]) {
      await env.DB.prepare('INSERT INTO audit (ts, actor, action) VALUES (?1, ?2, ?3)').bind(ts, 'admin', 'config.save').run();
    }
    const inWin = ((await (await app.request(`/api/audit?from=${base}&to=${base + 1000}`, { headers: { cookie } }, env)).json()) as {
      items: Array<{ ts: number }>;
    }).items.filter((r) => r.ts >= base - 1000 && r.ts <= base + 2000);
    expect(inWin.map((r) => r.ts).sort((a, b) => a - b)).toEqual([base, base + 500, base + 1000]);
  });
});
