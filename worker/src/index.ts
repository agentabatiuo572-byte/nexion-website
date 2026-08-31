import { Hono } from 'hono';
import type { Env } from './env';
import { auditRoutes } from './audit';
import { authRoutes, requireAuth } from './auth';

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

// API 界域封口:未知 /api/* 返回 JSON 404,绝不落到静态层吐 HTML
app.all('/api/*', (c) => c.json({ error: 'not-found' }, 404));

// 静态产物兜底(T3;区域屏蔽中间件 T15 将插在一切之前)
app.all('*', (c) => c.env.ASSETS.fetch(c.req.raw));

const worker = {
  fetch: app.fetch,
  // 每日 00:10 UTC:日汇总 + 原始事件 90 天滚动清理(T6 实现;骨架期占位防 cron 报错)
  async scheduled(_event: ScheduledController, _env: Env, _ctx: ExecutionContext) {},
} satisfies ExportedHandler<Env>;

export default worker;
