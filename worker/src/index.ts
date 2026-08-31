import { Hono } from 'hono';
import type { Env } from './env';
import { auditRoutes, writeAudit } from './audit';
import { authRoutes, requireAuth } from './auth';
import { configRoutes, probeDownloads } from './config';
import { dashRoutes } from './dash';
import { bypassExchange, geoMiddleware, geoRoutes } from './geo';
import { ingestRoutes } from './ingest';
import { createLimiter } from './ratelimit';
import { dailyJob, runDailyRollup } from './rollup';

/** 404 计数节流:同采集/拦截统计同档,防扫描器把 raw_events 写爆(计数因此为下限,面板标注) */
const notFoundLimiter = createLimiter(60_000, 120);

export const app = new Hono<{ Bindings: Env }>();

// 🔴 区域屏蔽中间件:一切之前(CON12;/admin 与 /api 前缀在中间件内豁免——自锁保护)
app.use('*', geoMiddleware);

app.get('/api/health', (c) =>
  c.json({ ok: true, service: 'nexgrid-site-worker', environment: c.env.ENVIRONMENT }),
);

// 认证(CON01):/api/auth/setup · /login · /logout
app.route('/api/auth', authRoutes);

// 会话探针(受保护路由样板;控制台壳用它探登录态)
app.get('/api/me', requireAuth, (c) => c.json({ ok: true, actor: 'admin' }));

// 审计(CON14):只读;append-only,无任何变更路由
app.use('/api/audit', requireAuth);
app.use('/api/audit/*', requireAuth);
app.route('/api/audit', auditRoutes);

// 匿名埋点采集(CON15):公开端点,限速+schema 校验在内
app.route('/api/e', ingestRoutes);

// 直通兑换(公开;令牌由控制台登录态签发)+ 屏蔽规则面(受保护)
app.route('/api/bypass', bypassExchange);
app.use('/api/geo', requireAuth);
app.use('/api/geo/*', requireAuth);
app.route('/api/geo', geoRoutes);

// 驾驶舱(CON03):只读聚合,受保护
app.use('/api/dash', requireAuth);
app.route('/api/dash', dashRoutes);

// 配置模型(CON04/13):草稿/校验/版本,全部受保护
app.use('/api/config', requireAuth);
app.use('/api/config/*', requireAuth);
app.route('/api/config', configRoutes);

// 手动汇总/回填(运维面,审计留痕;日常由 cron 驱动)
app.post('/api/admin/rollup', requireAuth, async (c) => {
  const body = await c.req.json<{ date?: string }>().catch(() => null);
  if (!body?.date || !/^\d{4}-\d{2}-\d{2}$/.test(body.date)) return c.json({ error: 'bad-date' }, 400);
  await runDailyRollup(c.env.DB, body.date);
  await writeAudit(c.env.DB, { action: 'admin.rollup', target: body.date });
  return c.json({ ok: true });
});

// API 界域封口:未知 /api/* 返回 JSON 404,绝不落到静态层吐 HTML
app.all('/api/*', (c) => c.json({ error: 'not-found' }, 404));

// 控制台 SPA(V1-dev 同域 /admin 路径;Phase C 迁子域):深链回退到 admin/index.html
// ⚠️ 区域屏蔽(T15)必须豁免本段(CON12-E1 自锁保护)
app.get('/admin', (c) => c.redirect('/admin/'));
app.get('/admin/*', async (c) => {
  const res = await c.env.ASSETS.fetch(c.req.raw);
  if (res.status !== 404) return res;
  return c.env.ASSETS.fetch(new Request(new URL('/admin/index.html', c.req.url)));
});

// 静态产物兜底(T3;区域屏蔽中间件 T15 已插在一切之前)
// 404 命中计数(CON03-③ 质量卡):服务端侧记,比页内埋点准(无 JS/爬虫的 404 也算);按 IP 节流
app.all('*', async (c) => {
  const res = await c.env.ASSETS.fetch(c.req.raw);
  if (res.status === 404 && (c.req.header('accept') ?? '').includes('text/html')) {
    const ip = c.req.header('cf-connecting-ip') ?? 'unknown';
    if (!notFoundLimiter.hit(ip)) {
      const log = c.env.DB.prepare('INSERT INTO raw_events (ts, type, uid, payload) VALUES (?1, ?2, NULL, ?3)')
        .bind(Date.now(), 'e404', JSON.stringify({ t: 'e404', path: new URL(c.req.url).pathname.slice(0, 200) }))
        .run()
        .then(() => {})
        .catch(() => {});
      try {
        c.executionCtx.waitUntil(log);
      } catch {
        await log;
      }
    }
  }
  return res;
});

/* 定时任务登记表(cron 表达式 → 处理函数)。
   🔴 单一真源:`gate-config-consistency.mjs` 双向比对本表的键与 wrangler.jsonc 的 triggers.crons——
   声明了没人处理、或代码处理了没声明,都会红(复测 O11:此前用三元兜底,「6h 那条」在代码里
   根本没出现过,门只能靠硬编码断言咬住,换个合法频率就会为错误的理由变红)。 */
const CRON_JOBS: Record<string, (env: Env) => Promise<void>> = {
  // 每日 00:10 UTC:汇总昨日 + 原始事件 90 天滚动清理(PRD §5.3)
  '10 0 * * *': (env) => dailyJob(env),
  // 每 6 小时:下载链接探活巡检(PRD CON03-③;结果落 probe_status,连续 2 次失败在驾驶舱红条)
  '0 */6 * * *': (env) => probeDownloads(env, true).then(() => {}),
};

const worker = {
  fetch: app.fetch,
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext) {
    const job = CRON_JOBS[event.cron];
    if (job) ctx.waitUntil(job(env));
  },
} satisfies ExportedHandler<Env>;

export default worker;
