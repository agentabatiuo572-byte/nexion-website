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
const MAX_PASSWORD_LEN = 256; // 纵深防御(LOW:防超长输入喂 PBKDF2)
export const SESSION_COOKIE = 'nx_sid';
/** 登录态 cookie 属性单源:setCookie 与 deleteCookie 共用,防清除时属性漂移(LOW) */
const SESSION_COOKIE_OPTS = { httpOnly: true, secure: true, sameSite: 'Lax', path: '/' } as const;

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

/** 常数时间比较(workerd 提供 timingSafeEqual;长度不同直接 false)。geo 直通签名同用此实现。 */
export function timingSafeEqualHex(a: string, b: string): boolean {
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

// ---------- 限速(CON01-E2:15 分钟 5 次尝试 → 锁 15 分钟,锁内正确口令也拒) ----------
//
// 🔴 原子「先占名额」模型(安全评审 HIGH 2026-08-31 修):一次登录尝试 = 一条 UPSERT+RETURNING,
// 在**验口令之前**就原子完成「窗口滚动 + 计数递增 + 触发锁定」并拿回结果。并发 N 个请求各自拿到
// 唯一的递增值(1..N),超阈值者当场判 blocked——消除了旧代码「先 SELECT 读未锁、再各自验口令、
// 最后才写计数」之间的 check-then-act 间隙(那个间隙让并发爆破的实际上限 = 并发数而非 5 次)。
// 列名 fail_count 沿用迁移(现语义 = 窗口内尝试数;成功即 clearAttempts 清零,故稳态 = 连续失败数)。

async function registerAttempt(db: D1Database, key: string, now: number): Promise<{ blocked: boolean; retryAfterMs: number }> {
  const row = await db
    .prepare(
      `INSERT INTO login_throttle (key, fail_count, window_start, locked_until) VALUES (?1, 1, ?2, NULL)
       ON CONFLICT(key) DO UPDATE SET
         fail_count = CASE
           WHEN locked_until IS NOT NULL AND locked_until > ?2 THEN fail_count
           WHEN (locked_until IS NOT NULL AND locked_until <= ?2) OR (?2 - window_start > ${LOCK_WINDOW_MS}) THEN 1
           ELSE fail_count + 1 END,
         window_start = CASE
           WHEN locked_until IS NOT NULL AND locked_until > ?2 THEN window_start
           WHEN (locked_until IS NOT NULL AND locked_until <= ?2) OR (?2 - window_start > ${LOCK_WINDOW_MS}) THEN ?2
           ELSE window_start END,
         locked_until = CASE
           WHEN locked_until IS NOT NULL AND locked_until > ?2 THEN locked_until
           WHEN (locked_until IS NOT NULL AND locked_until <= ?2) OR (?2 - window_start > ${LOCK_WINDOW_MS}) THEN NULL
           WHEN fail_count + 1 > ${LOCK_AFTER_FAILS} THEN ?2 + ${LOCK_DURATION_MS}
           ELSE locked_until END
       RETURNING fail_count, locked_until`,
    )
    .bind(key, now)
    .first<{ fail_count: number; locked_until: number | null }>();
  const lockedUntil = row?.locked_until ?? null;
  const overLimit = (row?.fail_count ?? 1) > LOCK_AFTER_FAILS;
  const blocked = overLimit || (lockedUntil !== null && lockedUntil > now);
  const retryAfterMs = blocked && lockedUntil ? Math.max(0, lockedUntil - now) : 0;
  return { blocked, retryAfterMs };
}

async function clearAttempts(db: D1Database, key: string): Promise<void> {
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

/** 会话校验 + 滑动续期;无效返回 false 并顺手清掉过期行 */
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

/** 初始化状态探针(公开只读):setup 页开门即知该渲染表单还是死卡(CON01-E4「访问即 410 卡」;
    T10 验收 P-1 修)。只暴露布尔,无枚举面。 */
authRoutes.get('/state', async (c) => c.json({ initialized: await isInitialized(c.env.DB) }));

/** 首次初始化(CON01;已初始化 → 410 永久失效,E4)。SETUP_TOKEN 暴力猜测按 IP 限速(MEDIUM)。 */
authRoutes.post('/setup', async (c) => {
  const now = Date.now();
  const ip = clientIp(c);
  if (await isInitialized(c.env.DB)) return c.json({ error: 'already-initialized' }, 410);
  const gate = await registerAttempt(c.env.DB, `setup:${ip}`, now);
  if (gate.blocked) {
    return c.json({ error: 'too-many-attempts', retryAfterSec: Math.ceil(gate.retryAfterMs / 1000) }, 429, {
      'Retry-After': String(Math.ceil(gate.retryAfterMs / 1000)),
    });
  }
  const body = await c.req.json<{ token?: string; password?: string }>().catch(() => null);
  if (!body?.token || !timingSafeEqualHex(await sha256Hex(body.token), await sha256Hex(c.env.SETUP_TOKEN ?? ''))) {
    return c.json({ error: 'forbidden' }, 403);
  }
  if (!body.password || body.password.length < MIN_PASSWORD_LEN || body.password.length > MAX_PASSWORD_LEN) {
    return c.json({ error: `password-length(must be ${MIN_PASSWORD_LEN}-${MAX_PASSWORD_LEN})` }, 400);
  }
  const salt = randomHex(16);
  const hash = await pbkdf2Hex(body.password, salt, kdfIter(c.env));
  try {
    await c.env.DB
      .prepare('INSERT INTO auth_account (id, password_hash, salt, initialized_at) VALUES (1, ?1, ?2, ?3)')
      .bind(hash, salt, now)
      .run();
  } catch {
    // 并发重复 setup 撞主键(CHECK id=1):安全不变量仍成立,回干净的 410 而非 500(LOW)
    return c.json({ error: 'already-initialized' }, 410);
  }
  await clearAttempts(c.env.DB, `setup:${ip}`);
  await writeAudit(c.env.DB, { action: 'auth.setup', target: 'admin' });
  return c.json({ ok: true });
});

/** 登录(CON01-A1/E1/E2)。错误一律同文案,不泄露差在哪个字段;限速在验口令前原子占位。 */
authRoutes.post('/login', async (c) => {
  const now = Date.now();
  const ip = clientIp(c);
  const attempt = await registerAttempt(c.env.DB, ip, now);
  if (attempt.blocked) {
    await writeAudit(c.env.DB, { action: 'login.fail', target: ip, reason: 'locked' });
    return c.json({ error: 'too-many-attempts', retryAfterSec: Math.ceil(attempt.retryAfterMs / 1000) }, 429, {
      'Retry-After': String(Math.ceil(attempt.retryAfterMs / 1000)),
    });
  }
  const body = await c.req.json<{ password?: string }>().catch(() => null);
  const account = await c.env.DB
    .prepare('SELECT password_hash, salt FROM auth_account WHERE id = 1')
    .first<{ password_hash: string; salt: string }>();
  const pw = body?.password;
  const candidate =
    pw && pw.length >= MIN_PASSWORD_LEN && pw.length <= MAX_PASSWORD_LEN
      ? await pbkdf2Hex(pw, account?.salt ?? randomHex(16), kdfIter(c.env))
      : '';
  if (!account || !candidate || !timingSafeEqualHex(candidate, account.password_hash)) {
    await writeAudit(c.env.DB, { action: 'login.fail', target: ip });
    return c.json({ error: 'invalid-credentials' }, 401);
  }
  await clearAttempts(c.env.DB, ip); // 成功即清零窗口内尝试
  const token = await createSession(c.env.DB, now);
  setCookie(c, SESSION_COOKIE, token, { ...SESSION_COOKIE_OPTS, maxAge: SESSION_TTL_MS / 1000 });
  await writeAudit(c.env.DB, { action: 'login.success', target: ip });
  return c.json({ ok: true });
});

authRoutes.post('/logout', requireAuth, async (c) => {
  const token = getCookie(c, SESSION_COOKIE);
  if (token) await c.env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?1').bind(await sha256Hex(token)).run();
  deleteCookie(c, SESSION_COOKIE, SESSION_COOKIE_OPTS); // 属性与 setCookie 镜像(LOW)
  await writeAudit(c.env.DB, { action: 'auth.logout' });
  return c.json({ ok: true });
});
