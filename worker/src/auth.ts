import { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import type { Context, MiddlewareHandler } from 'hono';
import type { Env } from './env';
import { writeAudit } from './audit';

/** 安全参数(PRD §3;KDF 迭代可由 env.KDF_ITER 覆盖——Workers 免费档 CPU 上限的部署期调节阀) */
const KDF_ITER_DEFAULT = 600_000;
const SESSION_TTL_MS = 7 * 24 * 3600_000; // 7 天滑动
const LOCK_WINDOW_MS = 15 * 60_000; // 15 分钟窗口
const LOCK_AFTER_FAILS = 5;
const LOCK_DURATION_MS = 15 * 60_000;
const MIN_PASSWORD_LEN = 12;
export const SESSION_COOKIE = 'nx_sid';

const enc = new TextEncoder();

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function randomHex(bytes: number): string {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return toHex(a.buffer);
}

async function sha256Hex(s: string): Promise<string> {
  return toHex(await crypto.subtle.digest('SHA-256', enc.encode(s)));
}

async function pbkdf2Hex(password: string, saltHex: string, iterations: number): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const salt = new Uint8Array(saltHex.match(/../g)!.map((h) => parseInt(h, 16)));
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);
  return toHex(bits);
}

/** 常数时间比较(workerd 提供 timingSafeEqual;长度不同直接 false) */
function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  const subtle = crypto.subtle as SubtleCrypto & { timingSafeEqual?: (a: ArrayBuffer, b: ArrayBuffer) => boolean };
  if (typeof subtle.timingSafeEqual === 'function') return subtle.timingSafeEqual(ab.buffer as ArrayBuffer, bb.buffer as ArrayBuffer);
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i]! ^ bb[i]!;
  return diff === 0;
}

function kdfIter(env: Env): number {
  const n = Number(env.KDF_ITER ?? KDF_ITER_DEFAULT);
  return Number.isFinite(n) && n >= 100_000 ? n : KDF_ITER_DEFAULT;
}

function clientIp(c: Context<{ Bindings: Env }>): string {
  return c.req.header('cf-connecting-ip') ?? 'unknown';
}

async function isInitialized(db: D1Database): Promise<boolean> {
  const row = await db.prepare('SELECT id FROM auth_account WHERE id = 1').first();
  return row !== null;
}

// ---------- 限速(CON01-E2:15 分钟 5 次失败 → 锁 15 分钟,锁内正确口令也拒) ----------

async function throttleState(db: D1Database, key: string, now: number): Promise<{ locked: boolean; fails: number }> {
  const row = await db
    .prepare('SELECT fail_count, window_start, locked_until FROM login_throttle WHERE key = ?1')
    .bind(key)
    .first<{ fail_count: number; window_start: number; locked_until: number | null }>();
  if (!row) return { locked: false, fails: 0 };
  if (row.locked_until && row.locked_until > now) return { locked: true, fails: row.fail_count };
  if (now - row.window_start > LOCK_WINDOW_MS) return { locked: false, fails: 0 };
  return { locked: false, fails: row.fail_count };
}

async function recordFail(db: D1Database, key: string, now: number): Promise<void> {
  const st = await throttleState(db, key, now);
  const fails = st.fails + 1;
  const lockedUntil = fails >= LOCK_AFTER_FAILS ? now + LOCK_DURATION_MS : null;
  await db
    .prepare(
      `INSERT INTO login_throttle (key, fail_count, window_start, locked_until) VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT(key) DO UPDATE SET
         fail_count = CASE WHEN ?3 - window_start > ${LOCK_WINDOW_MS} THEN 1 ELSE fail_count + 1 END,
         window_start = CASE WHEN ?3 - window_start > ${LOCK_WINDOW_MS} THEN ?3 ELSE window_start END,
         locked_until = CASE
           WHEN (CASE WHEN ?3 - window_start > ${LOCK_WINDOW_MS} THEN 1 ELSE fail_count + 1 END) >= ${LOCK_AFTER_FAILS}
           THEN ?3 + ${LOCK_DURATION_MS} ELSE locked_until END`,
    )
    .bind(key, fails, now, lockedUntil)
    .run();
}

async function clearFails(db: D1Database, key: string): Promise<void> {
  await db.prepare('DELETE FROM login_throttle WHERE key = ?1').bind(key).run();
}

// ---------- 会话 ----------

async function createSession(db: D1Database, now: number): Promise<string> {
  const token = randomHex(32);
  await db
    .prepare('INSERT INTO sessions (token_hash, created_at, expires_at) VALUES (?1, ?2, ?3)')
    .bind(await sha256Hex(token), now, now + SESSION_TTL_MS)
    .run();
  return token;
}

/** 会话校验 + 滑动续期;无效返回 null 并顺手清掉过期行 */
async function validateSession(db: D1Database, token: string, now: number): Promise<boolean> {
  const hash = await sha256Hex(token);
  const row = await db
    .prepare('SELECT expires_at FROM sessions WHERE token_hash = ?1')
    .bind(hash)
    .first<{ expires_at: number }>();
  if (!row) return false;
  if (row.expires_at <= now) {
    await db.prepare('DELETE FROM sessions WHERE token_hash = ?1').bind(hash).run();
    return false;
  }
  await db.prepare('UPDATE sessions SET expires_at = ?1 WHERE token_hash = ?2').bind(now + SESSION_TTL_MS, hash).run();
  return true;
}

/** 受保护 API 中间件:无效会话一律 401(CON01-E3;登录页回跳由前端处理) */
export const requireAuth: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token || !(await validateSession(c.env.DB, token, Date.now()))) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  await next();
};

// ---------- 路由 ----------

export const authRoutes = new Hono<{ Bindings: Env }>();

/** 首次初始化(CON01;已初始化 → 410 永久失效,E4) */
authRoutes.post('/setup', async (c) => {
  const now = Date.now();
  if (await isInitialized(c.env.DB)) return c.json({ error: 'already-initialized' }, 410);
  const body = await c.req.json<{ token?: string; password?: string }>().catch(() => null);
  if (!body?.token || !timingSafeEqualHex(await sha256Hex(body.token), await sha256Hex(c.env.SETUP_TOKEN ?? ''))) {
    return c.json({ error: 'forbidden' }, 403);
  }
  if (!body.password || body.password.length < MIN_PASSWORD_LEN) {
    return c.json({ error: `password-too-short(min ${MIN_PASSWORD_LEN})` }, 400);
  }
  const salt = randomHex(16);
  const hash = await pbkdf2Hex(body.password, salt, kdfIter(c.env));
  await c.env.DB
    .prepare('INSERT INTO auth_account (id, password_hash, salt, initialized_at) VALUES (1, ?1, ?2, ?3)')
    .bind(hash, salt, now)
    .run();
  await writeAudit(c.env.DB, { action: 'auth.setup', target: 'admin' });
  return c.json({ ok: true });
});

/** 登录(CON01-A1/E1/E2)。错误一律同文案,不泄露差在哪个字段。 */
authRoutes.post('/login', async (c) => {
  const now = Date.now();
  const ip = clientIp(c);
  const st = await throttleState(c.env.DB, ip, now);
  if (st.locked) {
    await writeAudit(c.env.DB, { action: 'login.fail', target: ip, reason: 'locked' });
    return c.json({ error: 'too-many-attempts' }, 429);
  }
  const body = await c.req.json<{ password?: string }>().catch(() => null);
  const account = await c.env.DB
    .prepare('SELECT password_hash, salt FROM auth_account WHERE id = 1')
    .first<{ password_hash: string; salt: string }>();
  const candidate = body?.password ? await pbkdf2Hex(body.password, account?.salt ?? randomHex(16), kdfIter(c.env)) : '';
  if (!account || !candidate || !timingSafeEqualHex(candidate, account.password_hash)) {
    await recordFail(c.env.DB, ip, now);
    await writeAudit(c.env.DB, { action: 'login.fail', target: ip });
    return c.json({ error: 'invalid-credentials' }, 401);
  }
  await clearFails(c.env.DB, ip);
  const token = await createSession(c.env.DB, now);
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    path: '/',
    maxAge: SESSION_TTL_MS / 1000,
  });
  await writeAudit(c.env.DB, { action: 'login.success', target: ip });
  return c.json({ ok: true });
});

authRoutes.post('/logout', requireAuth, async (c) => {
  const token = getCookie(c, SESSION_COOKIE);
  if (token) await c.env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?1').bind(await sha256Hex(token)).run();
  deleteCookie(c, SESSION_COOKIE, { path: '/' });
  await writeAudit(c.env.DB, { action: 'auth.logout' });
  return c.json({ ok: true });
});
