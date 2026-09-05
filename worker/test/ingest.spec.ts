// T5 验收(plan T5;继承 CON15-E2):校验/限速/匿名化富化。
import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { app } from '../src/index';
import { hashUid, resetRateLimiter } from '../src/ingest';
import { truncateUtf8, utf8ByteLength } from '../../schema/src/utf8';

const H = {
  'content-type': 'application/json',
  'cf-connecting-ip': '203.0.113.20',
  'cf-ipcountry': 'VN',
  'user-agent': 'Mozilla/5.0 (Linux; Android 14) Chrome/126',
};
const PV = { t: 'pv', path: '/', loc: 'en', dev: 'm', ref: 'direct', us: '', um: '', uc: '' };

function post(events: unknown[], headers: Record<string, string> = H) {
  return app.request('/api/e', { method: 'POST', headers, body: JSON.stringify({ events }) }, env);
}

beforeEach(async () => {
  resetRateLimiter();
  await env.DB.prepare('DELETE FROM raw_events').run();
});

describe('CON15 采集接口', () => {
  it('合法批次入库并富化:country 来自边缘头、uid=16hex、bot=0、服务端时间戳', async () => {
    const res = await post([PV, { t: 'cta', cta: 'ios', sec: 'download', loc: 'en', path: '/' }]);
    expect(res.status).toBe(200);
    const rows = await env.DB.prepare('SELECT type, uid, payload, ts FROM raw_events ORDER BY id').all<{ type: string; uid: string; payload: string; ts: number }>();
    expect(rows.results.length).toBe(2);
    expect(rows.results.map((r) => r.type)).toEqual(['pv', 'cta']);
    const p0 = JSON.parse(rows.results[0]!.payload) as { country: string; bot: number };
    expect(p0.country).toBe('VN');
    expect(p0.bot).toBe(0);
    expect(rows.results[0]!.uid).toMatch(/^[0-9a-f]{16}$/);
    expect(Math.abs(rows.results[0]!.ts - Date.now())).toBeLessThan(60_000);
  });

  it('爬虫 UA 标 bot=1(存但由汇总排除出流量)', async () => {
    await post([PV], { ...H, 'user-agent': 'Googlebot/2.1 (+http://www.google.com/bot.html)' });
    const row = await env.DB.prepare('SELECT payload FROM raw_events').first<{ payload: string }>();
    expect((JSON.parse(row!.payload) as { bot: number }).bot).toBe(1);
  });

  it('404 服务端生产者复用 bot 分类并把长路径截到 200 UTF-8 bytes', async () => {
    const response = await app.request(`/missing-${'路径'.repeat(80)}`, {
      headers: {
        accept: 'text/html',
        'cf-connecting-ip': '198.51.100.44',
        'user-agent': 'Googlebot/2.1',
      },
    }, env);
    expect(response.status).toBe(404);
    const row = await env.DB.prepare("SELECT uid,payload FROM raw_events WHERE type='e404'").first<{ uid: string | null; payload: string }>();
    const payload = JSON.parse(row!.payload) as { t: string; path: string; bot: number };
    expect(row!.uid).toBeNull();
    expect(payload).toMatchObject({ t: 'e404', bot: 1 });
    expect(utf8ByteLength(payload.path)).toBeLessThanOrEqual(200);
  });

  it('E2 畸形丢弃:非法结构 / 未知类型 / 超 10 条 / 超长字段 → 400,零入库', async () => {
    expect((await app.request('/api/e', { method: 'POST', headers: H, body: '{}' }, env)).status).toBe(400);
    expect((await post([{ t: 'hack', x: 1 }])).status).toBe(400);
    expect((await post(Array.from({ length: 11 }, () => PV))).status).toBe(400);
    expect((await post([{ ...PV, path: 'x'.repeat(201) }])).status).toBe(400);
    const n = await env.DB.prepare('SELECT COUNT(*) c FROM raw_events').first<{ c: number }>();
    expect(n!.c).toBe(0);
  });

  it('低基数字段只接受共享合同:section 12 项、CTA 4 项、FAQ qN', async () => {
    expect((await post([{ t: 'sec', sec: 'unknown-section', path: '/' }])).status).toBe(400);
    expect((await post([{ t: 'cta', cta: 'download', sec: 'download', loc: 'en', path: '/' }])).status).toBe(400);
    expect((await post([{ t: 'faq', faq: 'question-1', loc: 'en' }])).status).toBe(400);

    expect((await post([
      { t: 'sec', sec: 'learn-entry', path: '/' },
      { t: 'cta', cta: 'contact', sec: 'final-cta', loc: 'zh', path: '/zh/' },
      { t: 'faq', faq: 'q12', loc: 'vi' },
    ])).status).toBe(200);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM raw_events').first()).toMatchObject({ n: 3 });
  });

  it('字符串契约按 UTF-8 字节计长并拒绝 NUL，边界内事件照常入库', async () => {
    const acceptedPath = '/' + '😀'.repeat(49); // 197 UTF-8 bytes
    const oversizedPath = '/' + '😀'.repeat(50); // 201 UTF-8 bytes
    const nulPath = '/nul' + String.fromCharCode(0) + 'tail';

    expect((await post([{ ...PV, path: acceptedPath }])).status).toBe(200);
    expect((await post([{ ...PV, path: oversizedPath }])).status).toBe(400);
    expect((await post([{ ...PV, path: nulPath }])).status).toBe(400);
    const rows = await env.DB.prepare('SELECT payload FROM raw_events').all<{ payload: string }>();
    expect(rows.results).toHaveLength(1);
    expect((JSON.parse(rows.results[0]!.payload) as { path: string }).path).toBe(acceptedPath);
  });

  it('官网生产者按 UTF-8 安全截断多语 UTM，不能因单字段拖垮同批合法事件', async () => {
    const rawValues = [
      '推广'.repeat(30),
      'chiến-dịch-'.repeat(12),
      '😀'.repeat(17),
      `safe${String.fromCharCode(0)}tail`,
    ];
    const clipped = rawValues.map((value) => truncateUtf8(value, 64));
    for (const value of clipped) {
      expect(utf8ByteLength(value)).toBeLessThanOrEqual(64);
      expect(value).not.toContain(String.fromCharCode(0));
    }
    expect(clipped[2]).toBe('😀'.repeat(16));
    expect(clipped[3]).toBe('safetail');

    const response = await post([
      { ...PV, us: clipped[0], um: clipped[1], uc: clipped[2] },
      { t: 'cta', cta: 'ios', sec: '', loc: 'en', path: '/' },
    ]);
    expect(response.status).toBe(200);
    const rows = await env.DB.prepare('SELECT type,payload FROM raw_events ORDER BY id').all<{ type: string; payload: string }>();
    expect(rows.results.map((row) => row.type)).toEqual(['pv', 'cta']);
    expect(JSON.parse(rows.results[0]!.payload)).toMatchObject({ us: clipped[0], um: clipped[1], uc: clipped[2] });
  });

  it('限速:同 IP 突发 120 内放行,第 121 个 429;换 IP 不受累', async () => {
    for (let i = 0; i < 120; i++) expect((await post([PV])).status).toBe(200);
    expect((await post([PV])).status).toBe(429);
    expect((await post([PV], { ...H, 'cf-connecting-ip': '198.51.100.77' })).status).toBe(200);
  });

  it('uid 隐私口径:同日同源同 id;跨日盐轮换后不可关联(CON03-③)', async () => {
    const a = await hashUid('s', '2026-08-30', '1.2.3.4', 'ua');
    const b = await hashUid('s', '2026-08-30', '1.2.3.4', 'ua');
    const c = await hashUid('s', '2026-08-31', '1.2.3.4', 'ua');
    const d = await hashUid('s', '2026-08-30', '1.2.3.5', 'ua');
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).not.toBe(d);
  });
});
