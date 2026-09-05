// T2 验收(plan T2-AC1..AC4;继承 PRD CON01-A1/E1/E2/E3/E4 + CON14-A1/E2)。
// pool-workers 0.22 无 per-test 隔离存储 → beforeEach 显式清表,每条测试自建全部状态。
import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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
  it('setup 成功审计失败时账号回滚，已审计的计算准入计数留作失败关闭', async () => {
    await env.DB.prepare(
      "CREATE TRIGGER fail_setup_audit BEFORE INSERT ON audit WHEN NEW.action='auth.setup' BEGIN SELECT RAISE(ABORT, 'injected-setup-audit-failure'); END",
    ).run();
    try {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      expect((await setup()).status).toBe(500);
      expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM auth_account').first()).toMatchObject({ n: 0 });
      expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM login_throttle').first()).toMatchObject({ n: 1 });
      expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM audit WHERE action='auth.setup.attempt'").first()).toMatchObject({ n: 1 });
      expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM audit WHERE action='auth.setup'").first()).toMatchObject({ n: 0 });
    } finally {
      vi.restoreAllMocks();
      await env.DB.prepare('DROP TRIGGER fail_setup_audit').run();
    }
    expect((await setup()).status).toBe(200);
  });

  it('setup 的预检查过时且账号已被并发建立时，不留下无对应审计的限速状态', async () => {
    await env.DB.prepare("INSERT INTO auth_account(id,password_hash,salt,initialized_at) VALUES(1,'winner','00',?1)")
      .bind(Date.now()).run();
    const stalePrecheckDb = {
      prepare(sql: string) {
        if (sql === 'SELECT id FROM auth_account WHERE id = 1') {
          return { first: async () => null } as unknown as D1PreparedStatement;
        }
        return env.DB.prepare(sql);
      },
      batch: env.DB.batch.bind(env.DB),
    } as unknown as D1Database;
    const result = await app.request('/api/auth/setup', {
      method: 'POST', headers: IP,
      body: JSON.stringify({ token: env.SETUP_TOKEN, password: PW }),
    }, { ...env, DB: stalePrecheckDb });
    expect(result.status).toBe(410);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM login_throttle').first()).toMatchObject({ n: 0 });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM audit WHERE action='auth.setup'").first()).toMatchObject({ n: 0 });
  });

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

  it('登录结果审计失败时保留已审计的计算准入计数', async () => {
    await setup();
    await env.DB.prepare(
      "CREATE TRIGGER fail_login_failure_audit BEFORE INSERT ON audit WHEN NEW.action='login.fail' BEGIN SELECT RAISE(ABORT, 'injected-login-failure-audit'); END",
    ).run();
    try {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      expect((await login('wrong-password-xxxx')).status).toBe(500);
      expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM login_throttle').first()).toMatchObject({ n: 1 });
      expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM audit WHERE action='login.attempt'").first()).toMatchObject({ n: 1 });
      expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM audit WHERE action='login.fail'").first()).toMatchObject({ n: 0 });
    } finally {
      vi.restoreAllMocks();
      await env.DB.prepare('DROP TRIGGER fail_login_failure_audit').run();
    }
  });

  it('登录成功审计失败时 session/cookie 回滚，计算准入计数失败关闭', async () => {
    await setup();
    expect((await login('wrong-password-xxxx')).status).toBe(401);
    const before = await env.DB.prepare('SELECT fail_count,window_start,locked_until FROM login_throttle WHERE key=?1')
      .bind('203.0.113.7')
      .first<{ fail_count: number; window_start: number; locked_until: number | null }>();
    await env.DB.prepare(
      "CREATE TRIGGER fail_login_success_audit BEFORE INSERT ON audit WHEN NEW.action='login.success' BEGIN SELECT RAISE(ABORT, 'injected-login-success-audit'); END",
    ).run();
    try {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const result = await login(PW);
      expect(result.status).toBe(500);
      expect(result.headers.get('set-cookie')).toBeNull();
      expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM sessions').first()).toMatchObject({ n: 0 });
      expect(await env.DB.prepare('SELECT fail_count,window_start,locked_until FROM login_throttle WHERE key=?1')
        .bind('203.0.113.7').first()).toMatchObject({ ...before, fail_count: (before?.fail_count ?? 0) + 1 });
      expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM audit WHERE action='login.success'").first()).toMatchObject({ n: 0 });
    } finally {
      vi.restoreAllMocks();
      await env.DB.prepare('DROP TRIGGER fail_login_success_audit').run();
    }
  });

  it('锁定分支的 login.fail 审计失败时第六次尝试与锁定一起回滚', async () => {
    await setup();
    for (let i = 0; i < 5; i++) expect((await login('wrong-password-xxxx')).status).toBe(401);
    const before = await env.DB.prepare('SELECT fail_count,window_start,locked_until FROM login_throttle WHERE key=?1')
      .bind('203.0.113.7')
      .first<{ fail_count: number; window_start: number; locked_until: number | null }>();
    const auditBefore = await env.DB.prepare("SELECT COUNT(*) AS n FROM audit WHERE action='login.fail'").first<{ n: number }>();
    await env.DB.prepare(
      "CREATE TRIGGER fail_locked_login_audit BEFORE INSERT ON audit WHEN NEW.action='login.fail' BEGIN SELECT RAISE(ABORT, 'injected-locked-login-audit'); END",
    ).run();
    try {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      expect((await login(PW)).status).toBe(500);
      expect(await env.DB.prepare('SELECT fail_count,window_start,locked_until FROM login_throttle WHERE key=?1')
        .bind('203.0.113.7').first()).toEqual(before);
      expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM sessions').first()).toMatchObject({ n: 0 });
      expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM audit WHERE action='login.fail'").first()).toEqual(auditBefore);
    } finally {
      vi.restoreAllMocks();
      await env.DB.prepare('DROP TRIGGER fail_locked_login_audit').run();
    }
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

  it('会话续期提交前若已被并发登出删除，旧请求不得继续取得授权或刷新 cookie', async () => {
    await setup();
    const cookie = sidCookie(await login(PW));
    let injected = false;
    const racingDb = {
      prepare(sql: string) {
        const statement = env.DB.prepare(sql);
        if (!sql.startsWith('UPDATE sessions SET expires_at')) return statement;
        return {
          bind(...values: unknown[]) {
            const bound = statement.bind(...values);
            const revoke = async () => {
              if (injected) return;
              injected = true;
              await env.DB.prepare('DELETE FROM sessions').run();
            };
            return {
              run: async () => { await revoke(); return bound.run(); },
              first: async <T>() => { await revoke(); return bound.first<T>(); },
            };
          },
        } as unknown as D1PreparedStatement;
      },
    } as D1Database;

    const result = await app.request('/api/me', { headers: { cookie } }, { ...env, DB: racingDb });
    expect(injected).toBe(true);
    expect(result.status).toBe(401);
    expect(result.headers.get('set-cookie')).toBeNull();
  });

  it('登出审计失败时会话删除与 cookie 清除一起回滚', async () => {
    await setup();
    const cookie = sidCookie(await login(PW));
    await env.DB.prepare(
      "CREATE TRIGGER fail_logout_audit BEFORE INSERT ON audit WHEN NEW.action='auth.logout' BEGIN SELECT RAISE(ABORT, 'injected-logout-audit-failure'); END",
    ).run();
    try {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const out = await app.request('/api/auth/logout', { method: 'POST', headers: { cookie } }, env);
      expect(out.status).toBe(500);
      expect(out.headers.get('set-cookie')).toBeNull();
      expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM sessions').first()).toMatchObject({ n: 1 });
      expect((await app.request('/api/me', { headers: { cookie } }, env)).status).toBe(200);
      expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM audit WHERE action='auth.logout'").first()).toMatchObject({ n: 0 });
    } finally {
      vi.restoreAllMocks();
      await env.DB.prepare('DROP TRIGGER fail_logout_audit').run();
    }
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
  it('HIGH 并发爆破:最多 5 个请求能进入账号读取与 KDF 前置路径', async () => {
    await setup();
    let kdfEligible = 0;
    const admissionOrder: string[] = [];
    let releaseAccountReads!: () => void;
    const accountReadGate = new Promise<void>((resolve) => { releaseAccountReads = resolve; });
    const countedDb = {
      prepare(sql: string) {
        if (sql.includes('SELECT password_hash, salt FROM auth_account')) {
          const prepared = env.DB.prepare(sql);
          return {
            first: async <T>() => {
              admissionOrder.push('account-read-before-kdf');
              kdfEligible++;
              await accountReadGate;
              return prepared.first<T>();
            },
          } as unknown as D1PreparedStatement;
        }
        return env.DB.prepare(sql);
      },
      batch(statements: D1PreparedStatement[]) {
        admissionOrder.push('admission-batch');
        return env.DB.batch(statements);
      },
    } as unknown as D1Database;
    const pending = Array.from({ length: 20 }, async () => (
        await app.request(
          '/api/auth/login',
          { method: 'POST', headers: IP, body: JSON.stringify({ password: 'wrong-password-xxxx' }) },
          { ...env, DB: countedDb },
        )
      ).status);
    for (let attempt = 0; attempt < 100 && kdfEligible < 5; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
    const admittedBeforeRelease = kdfEligible;
    releaseAccountReads();
    const results = await Promise.all(pending);
    const n401 = results.filter((s) => s === 401).length;
    const n429 = results.filter((s) => s === 429).length;
    expect(n401).toBeLessThanOrEqual(5); // 绝不允许 >5 个请求拿到可区分于锁定的凭据结果
    expect(n401 + n429).toBe(20); // 每个请求都有确定结果,无异常
    expect(n429).toBeGreaterThan(0); // 确实触发了锁定
    expect(admittedBeforeRelease).toBe(5); // 第 6 个起必须在 PBKDF2 之前被 D1 准入门挡住
    expect(admissionOrder.indexOf('admission-batch')).toBeLessThan(admissionOrder.indexOf('account-read-before-kdf'));
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
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM audit WHERE action='auth.setup.attempt'").first()).toMatchObject({ n: 6 });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM audit WHERE action='auth.setup.fail'").first()).toMatchObject({ n: 6 });
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
