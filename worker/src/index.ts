import { Hono } from 'hono';
import type { Env } from './env';

export const app = new Hono<{ Bindings: Env }>();

app.get('/api/health', (c) =>
  c.json({ ok: true, service: 'nexgrid-site-worker', environment: c.env.ENVIRONMENT }),
);

const worker = {
  fetch: app.fetch,
  // 每日 00:10 UTC:日汇总 + 原始事件 90 天滚动清理(T6 实现;骨架期占位防 cron 报错)
  async scheduled(_event: ScheduledController, _env: Env, _ctx: ExecutionContext) {},
} satisfies ExportedHandler<Env>;

export default worker;
