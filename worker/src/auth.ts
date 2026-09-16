import { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import type { Context, MiddlewareHandler } from 'hono';
import type { Env } from './env';
import { prepareAuditAfterPreviousChange, writeAudit } from './audit';

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

/** Administrator JSON mutations share the same origin policy in both AI route families. */
export const requireSameOriginJson: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  c.header('Cache-Control', 'no-store');
  if (!['GET', 'HEAD'].includes(c.req.method)) {
    const url = new URL(c.req.url), origin = c.req.header('origin');
    const local = c.env.ENVIRONMENT === 'dev' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    const localOrigins = [
      'http://localhost:5175', 'http://127.0.0.1:5175',
      'http://localhost:8787', 'http://127.0.0.1:8787',
      'http://localhost:4399', 'http://127.0.0.1:4399',
    ];
    if (!origin || (origin !== url.origin && !(local && localOrigins.includes(origin)))) return c.json({ error: 'origin-rejected' }, 403);
    if (!/^application\/json(?:\s*;|$)/i.test(c.req.header('content-type') ?? '')) return c.json({ error: 'json-required' }, 415);
  }
  await next();
};

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
// 🔴 计算前准入模型：先由 D1 原子登记尝试并写 attempt 审计，只有前 5 个请求可以进入 PBKDF2。
// 第 6 个及以后在昂贵计算前即 429。结果审计失败时保留已审计的准入计数，安全侧失败关闭；
// 成功会在 session + success audit 同一事务中把计数归零。列名 fail_count 沿用迁移。

interface AttemptRow { fail_count: number; locked_until: number | null }

function prepareAttempt(db: D1Database, key: string, now: number): D1PreparedStatement {
  return db.prepare(
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
  ).bind(key, now);
}

function attemptOutcome(row: AttemptRow, now: number): { blocked: boolean; retryAfterMs: number } {
  const lockedUntil = row.locked_until;
  const overLimit = row.fail_count > LOCK_AFTER_FAILS;
  const blocked = overLimit || (lockedUntil !== null && lockedUntil > now);
  const retryAfterMs = blocked && lockedUntil ? Math.max(0, lockedUntil - now) : 0;
  return { blocked, retryAfterMs };
}

type AttemptAuditAction = 'login.attempt' | 'auth.setup.attempt';
type BlockedAuditAction = 'login.fail' | 'auth.setup.fail';

function prepareBlockedAttemptAudit(
  db: D1Database,
  key: string,
  now: number,
  action: BlockedAuditAction,
): D1PreparedStatement {
  return db.prepare(
    `INSERT INTO audit (ts,actor,action,target,before_summary,after_summary,reason)
     SELECT ?1,'admin',?2,?3,NULL,NULL,'locked'
     FROM login_throttle
     WHERE key=?3 AND (fail_count>${LOCK_AFTER_FAILS} OR (locked_until IS NOT NULL AND locked_until>?1))`,
  ).bind(now,action,key);
}

/** 尝试计数、准入审计、锁定结果审计同一事务；事务失败时绝不进入 KDF。 */
async function reserveAttempt(
  db: D1Database,
  key: string,
  now: number,
  attemptAction: AttemptAuditAction,
  blockedAction: BlockedAuditAction,
): Promise<{ blocked: boolean; retryAfterMs: number }> {
  const committed = await db.batch([
    prepareAttempt(db,key,now),
    prepareAuditAfterPreviousChange(db, { action: attemptAction, target: key }),
    prepareBlockedAttemptAudit(db,key,now,blockedAction),
  ]);
  const row = committed[0]?.results?.[0] as AttemptRow | undefined;
  if (!row) throw new Error('login throttle admission returned no state');
  return attemptOutcome(row,now);
}

async function activeLock(db: D1Database, key: string, now: number): Promise<number | null> {
  const row = await db.prepare('SELECT locked_until FROM login_throttle WHERE key=?1 AND locked_until>?2')
    .bind(key,now).first<{ locked_until: number }>();
  return row?.locked_until ?? null;
}

// ---------- 会话 ----------

/** 会话校验 + 滑动续期;无效返回 false 并顺手清掉过期行 */
async function validateSession(db: D1Database, token: string, now: number): Promise<boolean> {
  const hash = await sha256Hex(token);
  /* 授权判定与续期必须是同一条条件写：若 logout 已在线性化点前删掉 session，UPDATE
     命中 0 行就拒绝；不能先 SELECT 判有效、再无视续期 UPDATE 是否仍命中。 */
  const renewed = await db.prepare(
    'UPDATE sessions SET expires_at = ?1 WHERE token_hash = ?2 AND expires_at > ?3 RETURNING token_hash',
  ).bind(now + SESSION_TTL_MS,hash,now).first<{ token_hash: string }>();
  if (renewed) return true;
  await db.prepare('DELETE FROM sessions WHERE token_hash = ?1 AND expires_at <= ?2').bind(hash,now).run();
  return false;
}

/** 受保护 API 中间件:无效会话一律 401(CON01-E3;登录页回跳由前端处理) */
export const requireAuth: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token || !(await validateSession(c.env.DB, token, Date.now()))) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  await next();
  // 数据库与浏览器必须按同一活动时点滑动；登出响应只保留后续 deleteCookie。
  if (!new URL(c.req.url).pathname.endsWith('/logout')) {
    setCookie(c, SESSION_COOKIE, token, { ...SESSION_COOKIE_OPTS, maxAge: SESSION_TTL_MS / 1000 });
  }
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
  const throttleKey = `setup:${ip}`;
  if (await isInitialized(c.env.DB)) return c.json({ error: 'already-initialized' }, 410);
  const body = await c.req.json<{ token?: string; password?: string }>().catch(() => null);
  const admission = await reserveAttempt(c.env.DB,throttleKey,now,'auth.setup.attempt','auth.setup.fail');
  if (admission.blocked) {
    const retryAfterSec = Math.ceil(admission.retryAfterMs / 1000);
    return c.json({ error: 'too-many-attempts', retryAfterSec }, 429, { 'Retry-After': String(retryAfterSec) });
  }
  if (!body?.token || !timingSafeEqualHex(await sha256Hex(body.token), await sha256Hex(c.env.SETUP_TOKEN ?? ''))) {
    await writeAudit(c.env.DB, { action: 'auth.setup.fail', target: throttleKey, reason: 'invalid-token' });
    return c.json({ error: 'forbidden' }, 403);
  }
  if (!body.password || body.password.length < MIN_PASSWORD_LEN || body.password.length > MAX_PASSWORD_LEN) {
    await writeAudit(c.env.DB, { action: 'auth.setup.fail', target: throttleKey, reason: 'password-length' });
    return c.json({ error: `password-length(must be ${MIN_PASSWORD_LEN}-${MAX_PASSWORD_LEN})` }, 400);
  }
  const salt = randomHex(16);
  const hash = await pbkdf2Hex(body.password, salt, kdfIter(c.env));
  const committed = await c.env.DB.batch([
    c.env.DB.prepare(`INSERT INTO auth_account(id,password_hash,salt,initialized_at)
      SELECT 1,?1,?2,?3
        WHERE EXISTS(SELECT 1 FROM login_throttle WHERE key=?4 AND fail_count<=${LOCK_AFTER_FAILS}
          AND (locked_until IS NULL OR locked_until<=?3))
        AND NOT EXISTS(SELECT 1 FROM auth_account WHERE id=1)
      RETURNING id`).bind(hash,salt,now,throttleKey),
    prepareAuditAfterPreviousChange(c.env.DB, { action: 'auth.setup', target: 'admin' }),
    c.env.DB.prepare('DELETE FROM login_throttle WHERE key=?1 AND changes()>0').bind(throttleKey),
    // 预检查后若另一请求已完成 setup，本请求的临时尝试没有业务结果与审计，事务内清干净。
    c.env.DB.prepare('DELETE FROM login_throttle WHERE key=?1 AND changes()=0 AND EXISTS(SELECT 1 FROM auth_account WHERE id=1)').bind(throttleKey),
  ]);
  if (!(committed[0]?.meta.changes ?? 0)) {
    if ((committed[3]?.meta.changes ?? 0)>0) return c.json({ error: 'already-initialized' }, 410);
    const lockedUntil = await activeLock(c.env.DB,throttleKey,Date.now());
    if (lockedUntil) {
      const retryAfterSec = Math.ceil((lockedUntil-Date.now())/1000);
      return c.json({ error: 'too-many-attempts', retryAfterSec }, 429, { 'Retry-After': String(retryAfterSec) });
    }
    // 并发重复 setup：条件 INSERT 只有一个能命中，失败方稳定返回 410。
    return c.json({ error: 'already-initialized' }, 410);
  }
  return c.json({ ok: true });
});

/** 登录(CON01-A1/E1/E2)。错误一律同文案；已有锁先快拒，候选口令与最终限速/结果在 D1 batch 收口。 */
authRoutes.post('/login', async (c) => {
  const now = Date.now();
  const ip = clientIp(c);
  const body = await c.req.json<{ password?: string }>().catch(() => null);
  const admission = await reserveAttempt(c.env.DB,ip,now,'login.attempt','login.fail');
  if (admission.blocked) {
    const retryAfterSec = Math.ceil(admission.retryAfterMs / 1000);
    return c.json({ error: 'too-many-attempts', retryAfterSec }, 429, { 'Retry-After': String(retryAfterSec) });
  }
  const account = await c.env.DB
    .prepare('SELECT password_hash, salt FROM auth_account WHERE id = 1')
    .first<{ password_hash: string; salt: string }>();
  const pw = body?.password;
  const candidate =
    pw && pw.length >= MIN_PASSWORD_LEN && pw.length <= MAX_PASSWORD_LEN
      ? await pbkdf2Hex(pw, account?.salt ?? randomHex(16), kdfIter(c.env))
      : '';
  const valid = !!account && !!candidate && timingSafeEqualHex(candidate, account.password_hash);
  if (!valid) {
    await writeAudit(c.env.DB, { action: 'login.fail', target: ip });
    return c.json({ error: 'invalid-credentials' }, 401);
  }
  const token = randomHex(32);
  const tokenHash = await sha256Hex(token);
  const committed = await c.env.DB.batch([
    c.env.DB.prepare(`INSERT INTO sessions(token_hash,created_at,expires_at)
      SELECT ?1,?2,?3
        WHERE EXISTS(SELECT 1 FROM login_throttle WHERE key=?4 AND fail_count<=${LOCK_AFTER_FAILS}
          AND (locked_until IS NULL OR locked_until<=?2))`).bind(tokenHash,now,now+SESSION_TTL_MS,ip),
    c.env.DB.prepare(
      `INSERT INTO audit(ts,actor,action,target,before_summary,after_summary,reason)
       SELECT ?1,'admin','login.success',?2,NULL,NULL,NULL
       WHERE EXISTS(SELECT 1 FROM sessions WHERE token_hash=?3)`,
    ).bind(now,ip,tokenHash),
    c.env.DB.prepare(
      `UPDATE login_throttle SET fail_count=0,window_start=?1,locked_until=NULL
       WHERE key=?2 AND EXISTS(SELECT 1 FROM sessions WHERE token_hash=?3)`,
    ).bind(now,ip,tokenHash),
    c.env.DB.prepare(
      `INSERT INTO audit(ts,actor,action,target,before_summary,after_summary,reason)
       SELECT ?1,'admin','login.fail',?2,NULL,NULL,'locked'
       FROM login_throttle
       WHERE key=?2 AND NOT EXISTS(SELECT 1 FROM sessions WHERE token_hash=?3)
         AND (fail_count>${LOCK_AFTER_FAILS} OR (locked_until IS NOT NULL AND locked_until>?1))`,
    ).bind(now,ip,tokenHash),
  ]);
  if (!(committed[0]?.meta.changes ?? 0)) {
    const lockedUntil = await activeLock(c.env.DB,ip,Date.now());
    if (!lockedUntil) throw new Error('eligible login session was not created');
    const retryAfterSec = Math.ceil((lockedUntil-Date.now())/1000);
    return c.json({ error: 'too-many-attempts', retryAfterSec }, 429, { 'Retry-After': String(retryAfterSec) });
  }
  setCookie(c, SESSION_COOKIE, token, { ...SESSION_COOKIE_OPTS, maxAge: SESSION_TTL_MS / 1000 });
  return c.json({ ok: true });
});

authRoutes.post('/logout', requireAuth, async (c) => {
  const token = getCookie(c, SESSION_COOKIE);
  if (token) {
    await c.env.DB.batch([
      c.env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?1').bind(await sha256Hex(token)),
      prepareAuditAfterPreviousChange(c.env.DB, { action: 'auth.logout' }),
    ]);
  }
  deleteCookie(c, SESSION_COOKIE, SESSION_COOKIE_OPTS); // 属性与 setCookie 镜像(LOW)
  return c.json({ ok: true });
});
