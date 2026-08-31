import { Hono } from 'hono';
import type { Env } from './env';
import { auditRoutes, writeAudit } from './audit';
import { authRoutes, requireAuth } from './auth';
import { configRoutes } from './config';
import { ingestRoutes } from './ingest';
import { dailyJob, runDailyRollup } from './rollup';

export const app = new Hono<{ Bindings: Env }>();

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

// 静态产物兜底(T3;区域屏蔽中间件 T15 将插在一切之前)
app.all('*', (c) => c.env.ASSETS.fetch(c.req.raw));

const worker = {
  fetch: app.fetch,
  // 每日 00:10 UTC:汇总昨日 + 原始事件 90 天滚动清理(PRD §5.3)
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(dailyJob(env));
  },
} satisfies ExportedHandler<Env>;

export default worker;
