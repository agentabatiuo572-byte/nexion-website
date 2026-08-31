// T5 验收(plan T5;继承 CON15-E2):校验/限速/匿名化富化。
import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { app } from '../src/index';
import { hashUid, resetRateLimiter } from '../src/ingest';

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

  it('E2 畸形丢弃:非法结构 / 未知类型 / 超 10 条 / 超长字段 → 400,零入库', async () => {
    expect((await app.request('/api/e', { method: 'POST', headers: H, body: '{}' }, env)).status).toBe(400);
    expect((await post([{ t: 'hack', x: 1 }])).status).toBe(400);
    expect((await post(Array.from({ length: 11 }, () => PV))).status).toBe(400);
    expect((await post([{ ...PV, path: 'x'.repeat(201) }])).status).toBe(400);
    const n = await env.DB.prepare('SELECT COUNT(*) c FROM raw_events').first<{ c: number }>();
    expect(n!.c).toBe(0);
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
