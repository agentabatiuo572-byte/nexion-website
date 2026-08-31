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

  it('CON08-③ 服务端造 id + 回收区语义(deleted 不计可见/不拦缺译)', async () => {
    const cookie = await login();
    const mint = await app.request('/api/config/mint-id', { method: 'POST', headers: J(cookie), body: JSON.stringify({ kind: 'faq' }) }, env);
    expect(mint.status).toBe(200);
    expect(((await mint.json()) as { id: string }).id).toMatch(/^faq-[0-9a-f-]{8}$/);
    expect((await app.request('/api/config/mint-id', { method: 'POST', headers: J(cookie), body: JSON.stringify({ kind: 'x' }) }, env)).status).toBe(400);
    const o = await getOverview(cookie);
    const p = structuredClone(o.draft.payload);
    for (const it of p.faq.items.slice(0, 7)) (it as { deleted?: boolean }).deleted = true; // 剩 2 可见
    (p.faq.items[0] as { q: { zh: string } }).q.zh = ''; // 回收区条目缺译不该被拦
    const v = await app.request('/api/config/validate', { method: 'POST', headers: J(cookie), body: JSON.stringify({ payload: p }) }, env);
    const body = (await v.json()) as { errors: Array<{ rule: string; path: string }> };
    expect(body.errors.some((e) => e.rule === 'min-visible')).toBe(true);
    expect(body.errors.some((e) => e.rule === 'untranslated' && e.path.startsWith('faq.'))).toBe(false);
  });

  it('CON09-E3 公告内容变更 server 换 id;未变则稳定', async () => {
    const cookie = await login();
    const o = await getOverview(cookie);
    const p = structuredClone(o.draft.payload);
    p.announcement.text.en = 'Maintenance window tonight';
    await app.request('/api/config/draft', { method: 'PUT', headers: J(cookie), body: JSON.stringify({ payload: p, baseRevision: o.draft.draftRev }) }, env);
    const o2 = await getOverview(cookie);
    const id1 = o2.draft.payload.announcement.id;
    expect(id1).toMatch(/^ann-/);
    const p2 = structuredClone(o2.draft.payload);
    p2.copy.en['final.title'] = 'unrelated change';
    await app.request('/api/config/draft', { method: 'PUT', headers: J(cookie), body: JSON.stringify({ payload: p2, baseRevision: o2.draft.draftRev }) }, env);
    const o3 = await getOverview(cookie);
    expect(o3.draft.payload.announcement.id).toBe(id1); // 无关改动不换 id
    // T14-P3 回归:文案改回与线上完全一致 → 还原线上 id,零幽灵改动
    const liveId = (o3 as unknown as { live: { payload: { announcement: { id: string } } } }).live.payload.announcement.id;
    const p3 = structuredClone(o3.draft.payload);
    p3.announcement.text = structuredClone((o3 as unknown as { live: { payload: { announcement: { text: object } } } }).live.payload.announcement.text) as typeof p3.announcement.text;
    await app.request('/api/config/draft', { method: 'PUT', headers: J(cookie), body: JSON.stringify({ payload: p3, baseRevision: o3.draft.draftRev }) }, env);
    const o4 = await getOverview(cookie);
    expect(o4.draft.payload.announcement.id).toBe(liveId);
    const changed = (o4 as unknown as { changedPaths: string[] }).changedPaths;
    expect(changed.some((p) => p.startsWith('announcement'))).toBe(false); // 幽灵清零
  });

  it('CON11-E3 Legal 保存剥危险节点并回显计数', async () => {
    const cookie = await login();
    const o = await getOverview(cookie);
    const p = structuredClone(o.draft.payload);
    p.legal.terms.md.en = '# Terms\nok<script>alert(1)</script>\n<iframe src="x"></iframe>\n<a href="/x" onclick="evil()">link</a>';
    const res = await app.request('/api/config/draft', { method: 'PUT', headers: J(cookie), body: JSON.stringify({ payload: p, baseRevision: o.draft.draftRev }) }, env);
    const body = (await res.json()) as { sanitized: number };
    expect(res.status).toBe(200);
    expect(body.sanitized).toBeGreaterThan(0);
    const o2 = await getOverview(cookie);
    const md = o2.draft.payload.legal.terms.md.en;
    expect(md).not.toContain('<script');
    expect(md).not.toContain('<iframe');
    expect(md).not.toContain('onclick');
    expect(md).toContain('# Terms');
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
