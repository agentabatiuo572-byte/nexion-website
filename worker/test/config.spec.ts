// T8 验收(plan T8;继承 CON04-A1/E1/E3 + CON13-③ 底座)。
import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { app } from '../src/index';
import type { SiteConfig } from '../../schema/src/index.js';

const IP = { 'cf-connecting-ip': '203.0.113.9', 'content-type': 'application/json' };
const PW = 'config-suite-pass!';

async function login(): Promise<string> {
  await app.request('/api/auth/setup', { method: 'POST', headers: IP, body: JSON.stringify({ token: env.SETUP_TOKEN, password: PW }) }, env);
  const res = await app.request('/api/auth/login', { method: 'POST', headers: IP, body: JSON.stringify({ password: PW }) }, env);
  const m = (res.headers.get('set-cookie') ?? '').match(/nx_sid=([^;]+)/);
  return `nx_sid=${m?.[1]}`;
}

const J = (cookie: string) => ({ cookie, 'content-type': 'application/json' });

async function getOverview(cookie: string) {
  const res = await app.request('/api/config', { headers: { cookie } }, env);
  expect(res.status).toBe(200);
  return (await res.json()) as {
    liveVersion: number;
    draft: { payload: SiteConfig; draftRev: number };
    dirty: number;
    sensitiveChanged: string[];
  };
}

beforeEach(async () => {
  for (const t of ['audit', 'sessions', 'login_throttle', 'auth_account', 'config_versions', 'config_draft']) {
    await env.DB.prepare(`DELETE FROM ${t}`).run();
  }
});

describe('CON04/CON13 配置模型', () => {
  it('首访种子化:live v1 + 草稿 = 种子,dirty=0;未登录 401', async () => {
    expect((await app.request('/api/config', {}, env)).status).toBe(401);
    const cookie = await login();
    const o = await getOverview(cookie);
    expect(o.liveVersion).toBeGreaterThan(0);
    expect(o.dirty).toBe(0);
    expect(Object.keys(o.draft.payload.copy.en).length).toBeGreaterThan(150); // 177 键
    expect(o.draft.payload.skus.length).toBe(7);
    expect(o.draft.payload.faq.items.length).toBe(9);
  });

  it('A1 存草稿:改 vi 值 → dirty 计数 + 审计 config.save;GET 回读一致', async () => {
    const cookie = await login();
    const o = await getOverview(cookie);
    const p = structuredClone(o.draft.payload);
    p.copy.vi['hero.scrollHint'] = 'Xem mạng lưới ngay';
    const res = await app.request('/api/config/draft', { method: 'PUT', headers: J(cookie), body: JSON.stringify({ payload: p, baseRevision: o.draft.draftRev }) }, env);
    expect(res.status).toBe(200);
    const o2 = await getOverview(cookie);
    expect(o2.dirty).toBe(1);
    expect(o2.draft.payload.copy.vi['hero.scrollHint']).toBe('Xem mạng lưới ngay');
    const audit = await env.DB.prepare("SELECT after_summary FROM audit WHERE action='config.save'").first<{ after_summary: string }>();
    expect(audit!.after_summary).toContain('1 处改动');
    expect(audit!.after_summary).toContain('hero.scrollHint');
  });

  it('E3 乐观锁:陈旧 baseRevision → 409 不覆盖', async () => {
    const cookie = await login();
    const o = await getOverview(cookie);
    const p1 = structuredClone(o.draft.payload);
    p1.copy.en['final.title'] = 'Tab A version';
    expect(
      (await app.request('/api/config/draft', { method: 'PUT', headers: J(cookie), body: JSON.stringify({ payload: p1, baseRevision: o.draft.draftRev }) }, env)).status,
    ).toBe(200);
    const p2 = structuredClone(o.draft.payload);
    p2.copy.en['final.title'] = 'Tab B stale version';
    const stale = await app.request('/api/config/draft', { method: 'PUT', headers: J(cookie), body: JSON.stringify({ payload: p2, baseRevision: o.draft.draftRev }) }, env);
    expect(stale.status).toBe(409);
    const o2 = await getOverview(cookie);
    expect(o2.draft.payload.copy.en['final.title']).toBe('Tab A version'); // B 未覆盖 A
  });

  it('结构非法 → 400;E1 禁用词可存草稿但 validate 报 error;高敏路径识别', async () => {
    const cookie = await login();
    const o = await getOverview(cookie);
    const bad = await app.request('/api/config/draft', { method: 'PUT', headers: J(cookie), body: JSON.stringify({ payload: { copy: 'nope' }, baseRevision: o.draft.draftRev }) }, env);
    expect(bad.status).toBe(400);
    // 注入禁用词 + 改高敏字段(下载 URL)
    const p = structuredClone(o.draft.payload);
    p.copy.en['hero.note'] = 'We guarantee your returns.';
    p.downloads.android = { url: 'https://play.google.com/store/apps/x', enabled: true };
    expect(
      (await app.request('/api/config/draft', { method: 'PUT', headers: J(cookie), body: JSON.stringify({ payload: p, baseRevision: o.draft.draftRev }) }, env)).status,
    ).toBe(200); // 草稿允许(红旗留发布)
    const v = await app.request('/api/config/validate', { method: 'POST', headers: J(cookie), body: '{}' }, env);
    const body = (await v.json()) as { errors: Array<{ rule: string; path: string }>; sensitiveChanged: string[] };
    expect(body.errors.some((e) => e.rule === 'forbidden-word' && e.path.includes('hero.note'))).toBe(true);
    expect(body.sensitiveChanged.some((s) => s.startsWith('downloads.android'))).toBe(true);
  });

  it('E2 占位符守恒是保存级硬拦:vi 丢 {devices} → PUT 400(T11-P2 回归)', async () => {
    const cookie = await login();
    const o = await getOverview(cookie);
    const p = structuredClone(o.draft.payload);
    p.copy.vi['social.scaleLine'] = 'Thiết bị đang chạy khắp nơi'; // 丢 {devices}/{countries}
    const res = await app.request('/api/config/draft', { method: 'PUT', headers: J(cookie), body: JSON.stringify({ payload: p, baseRevision: o.draft.draftRev }) }, env);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; issues: Array<{ rule: string }> };
    expect(body.error).toBe('placeholder');
    expect(body.issues.every((i) => i.rule === 'placeholder')).toBe(true);
    // 未被写入
    const o2 = await getOverview(cookie);
    expect(o2.draft.payload.copy.vi['social.scaleLine']).toContain('{devices}');
  });

  it('key 树=代码所有:增删 key 在 validate 被拒(unknown/missing)', async () => {
    const cookie = await login();
    const o = await getOverview(cookie);
    const p = structuredClone(o.draft.payload);
    p.copy.en['hacker.injected'] = 'x';
    delete p.copy.zh['final.title'];
    const v = await app.request('/api/config/validate', { method: 'POST', headers: J(cookie), body: JSON.stringify({ payload: p }) }, env);
    const body = (await v.json()) as { errors: Array<{ rule: string }> };
    expect(body.errors.some((e) => e.rule === 'unknown-key')).toBe(true);
    expect(body.errors.some((e) => e.rule === 'missing-key')).toBe(true);
  });

  it('种子草稿 validate:0 error(与等价性门口径一致)', async () => {
    const cookie = await login();
    const v = await app.request('/api/config/validate', { method: 'POST', headers: J(cookie), body: '{}' }, env);
    const body = (await v.json()) as { errors: unknown[]; warnings: Array<{ rule: string }> };
    expect(body.errors).toEqual([]);
    expect(body.warnings.some((w) => w.rule === 'mock-anchor')).toBe(true); // R49-A2 提醒在场
  });

  it('版本列表可读;编辑面无直写线上路由', async () => {
    const cookie = await login();
    await getOverview(cookie);
    const res = await app.request('/api/config/versions', { headers: { cookie } }, env);
    const body = (await res.json()) as { items: Array<{ status: string }> };
    expect(body.items[0]!.status).toBe('live');
    for (const method of ['PUT', 'POST', 'DELETE'] as const) {
      expect((await app.request('/api/config/live', { method, headers: J(cookie), body: '{}' }, env)).status, `${method} /live 不该存在`).toBe(404);
    }
  });
});
