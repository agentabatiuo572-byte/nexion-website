// T3 验收(逻辑层):run_worker_first 下 API 与静态互不吞;字节级对比走 npm run test:static。
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { app } from '../src/index';

describe('T3 静态伺服与 API 界域', () => {
  it('assets 配置下 /api/health 仍由 worker 应答(run_worker_first)', async () => {
    const res = await app.request('/api/health', {}, env);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
  });

  it('未知 /api/* 返回 JSON 404,不落静态层吐 HTML', async () => {
    const res = await app.request('/api/no-such-endpoint', {}, env);
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type') ?? '').toContain('application/json');
  });

  it('站点首页经 worker 兜底返回 HTML(真 dist 产物)', async () => {
    const res = await app.request('/', {}, env);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<html');
    expect(html).toContain('NexGrid');
  });

  it('不存在的路径 → 404 状态(404 页托底,不裸 500)', async () => {
    const res = await app.request('/definitely-not-a-page-xyz', {}, env);
    expect(res.status).toBe(404);
  });
});
