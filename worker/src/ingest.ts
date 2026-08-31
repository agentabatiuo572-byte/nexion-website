import { Hono } from 'hono';
import type { Env } from './env';
import { BatchSchema } from './events';
import { createLimiter } from './ratelimit';

/* 采集接口(PRD CON15-A1/E1/E2/E3):畸形 4xx 丢弃、限速 429、匿名化在此完成。
   隐私硬约束:IP 只在本函数瞬时参与去重哈希,不落库不落日志。 */

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_BURST = 120; // PRD:60/分,突发 120——按突发值拦

const limiter = createLimiter(RATE_LIMIT_WINDOW_MS, RATE_LIMIT_BURST);
export function resetRateLimiter(): void {
  limiter.reset();
}
const rateLimited = (ip: string, now: number) => limiter.hit(ip, now);

const BOT_RE = /bot|crawl|spider|slurp|headless|python|curl|wget|monitor|preview|scan|lighthouse/i;

/** 访客日内去重 id:sha256(盐+日+IP+UA) 截 16hex。盐 00:00 UTC 随日期轮换 → 跨日不可关联(CON03-③)。 */
export async function hashUid(salt: string, day: string, ip: string, ua: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${salt}|${day}|${ip}|${ua}`));
  return [...new Uint8Array(buf)].slice(0, 8).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export const ingestRoutes = new Hono<{ Bindings: Env }>();

ingestRoutes.post('/', async (c) => {
  const now = Date.now();
  const ip = c.req.header('cf-connecting-ip') ?? 'unknown';
  if (rateLimited(ip, now)) return c.json({ error: 'rate-limited' }, 429);

  const raw = await c.req.json().catch(() => null);
  const parsed = BatchSchema.safeParse(raw);
  if (!parsed.success) return c.json({ error: 'bad-payload' }, 400); // E2:丢弃,客户端不重试

  const ua = c.req.header('user-agent') ?? '';
  const bot = BOT_RE.test(ua) ? 1 : 0;
  const country = (c.req.raw.cf?.country as string | undefined) ?? c.req.header('cf-ipcountry') ?? 'XX';
  const day = new Date(now).toISOString().slice(0, 10);
  const uid = await hashUid(c.env.BEACON_SALT ?? 'no-salt', day, ip, ua);

  const stmt = c.env.DB.prepare('INSERT INTO raw_events (ts, type, uid, payload) VALUES (?1, ?2, ?3, ?4)');
  await c.env.DB.batch(
    parsed.data.events.map((e) => stmt.bind(now, e.t, uid, JSON.stringify({ ...e, country, bot }))),
  );
  return c.json({ ok: true });
});
