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

/* 🔴 P1-6(2026-09-01 复验):带 body 的非 GET 打静态路径,此前把原始 Request 直接转给资产层,
   底层抛「响应已发出后还在读请求流」——本机两发即打死整个 worker 进程(验收方路由审计时
   真的掐断过一次正在跑的发布)。现在这类请求在碰资产层之前就被 405 收口。
   ⚠️ 单测证明不了「进程不崩」(沙箱里没有那个进程),它证明的是**根因已不成立**:
   请求根本不再带着 body 进入资产层。进程层面的证据由起服实测补。 */
describe('P1-6 静态层只接 GET/HEAD', () => {
  for (const method of ['PUT', 'POST', 'DELETE', 'PATCH']) {
    it(`${method} 带 body 打静态路径 → 405,不进资产层`, async () => {
      const res = await app.request('/index.html', { method, headers: { 'content-type': 'application/json' }, body: '{"a":1}' }, env);
      expect(res.status).toBe(405);
      expect(res.headers.get('allow')).toBe('GET, HEAD');
    });
  }
  it('同样的路径 GET 仍正常返回站点内容', async () => {
    const res = await app.request('/', {}, env);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('<html');
  });
  it('405 之后服务仍可用(同一 isolate 内继续应答)', async () => {
    await app.request('/', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{"a":1}' }, env);
    await app.request('/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"a":1}' }, env);
    expect((await app.request('/api/health', {}, env)).status).toBe(200);
  });
});
