// T6 验收(plan T6;继承 CON03-③ 口径字典):合成事件 → 九表数值精确对账。
import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { p75, pruneRawEvents, runDailyRollup } from '../src/rollup';

const DAY = '2026-08-15';
const T0 = Date.parse(`${DAY}T10:00:00.000Z`);
const MIN = 60_000;

async function raw(ts: number, type: string, uid: string | null, payload: Record<string, unknown>) {
  await env.DB.prepare('INSERT INTO raw_events (ts, type, uid, payload) VALUES (?1,?2,?3,?4)')
    .bind(ts, type, uid, JSON.stringify(payload))
    .run();
}
const pv = (loc: string, country: string, dev: string, ref: string, path = '/', bot = 0) => ({ t: 'pv', path, loc, dev, ref, country, bot });

beforeEach(async () => {
  for (const t of ['raw_events', 'daily_traffic', 'daily_cta', 'daily_section', 'daily_faq', 'daily_learn', 'daily_vitals', 'daily_errors', 'daily_blocked', 'daily_bot'])
    await env.DB.prepare(`DELETE FROM ${t}`).run();
});

async function seedScenario() {
  // uid A:同维度 3 pv,间隔 10 分钟 + 40 分钟(>30min 切会话)→ pv3 uv1 sessions2
  await raw(T0, 'pv', 'aaaaaaaaaaaaaaaa', pv('en', 'VN', 'm', 'direct'));
  await raw(T0 + 10 * MIN, 'pv', 'aaaaaaaaaaaaaaaa', pv('en', 'VN', 'm', 'direct'));
  await raw(T0 + 50 * MIN, 'pv', 'aaaaaaaaaaaaaaaa', pv('en', 'VN', 'm', 'direct'));
  // uid B:2 pv(10 分钟内,单会话),第二条是 learn 文章页(派生阅读榜)
  await raw(T0, 'pv', 'bbbbbbbbbbbbbbbb', pv('vi', 'US', 'd', 'search'));
  await raw(T0 + 5 * MIN, 'pv', 'bbbbbbbbbbbbbbbb', pv('vi', 'US', 'd', 'search', '/vi/learn/getting-started/'));
  // Bot pv:不入流量,只入占比(1 / 6 = 0.167)
  await raw(T0, 'pv', 'cccccccccccccccc', pv('en', 'SG', 'd', 'direct', '/', 1));
  // cta:A 点 ios×2,B 点 ios×1 → clicks3 uniq2;sec:download A+B → uniq2
  await raw(T0, 'cta', 'aaaaaaaaaaaaaaaa', { t: 'cta', cta: 'ios', sec: 'download', loc: 'en', bot: 0 });
  await raw(T0 + MIN, 'cta', 'aaaaaaaaaaaaaaaa', { t: 'cta', cta: 'ios', sec: 'download', loc: 'en', bot: 0 });
  await raw(T0, 'cta', 'bbbbbbbbbbbbbbbb', { t: 'cta', cta: 'ios', sec: 'download', loc: 'en', bot: 0 });
  await raw(T0, 'sec', 'aaaaaaaaaaaaaaaa', { t: 'sec', sec: 'download', bot: 0 });
  await raw(T0, 'sec', 'bbbbbbbbbbbbbbbb', { t: 'sec', sec: 'download', bot: 0 });
  await raw(T0, 'faq', 'aaaaaaaaaaaaaaaa', { t: 'faq', faq: 'q3', loc: 'en', bot: 0 });
  await raw(T0 + MIN, 'faq', 'bbbbbbbbbbbbbbbb', { t: 'faq', faq: 'q3', loc: 'vi', bot: 0 });
  // vitals:LCP [1000,2000,3000,4000] → p75=3000;CLS [0.1,0.2,0.3,0.4] → 0.3
  for (const [i, lcp] of [1000, 2000, 3000, 4000].entries())
    await raw(T0 + i, 'vit', 'aaaaaaaaaaaaaaaa', { t: 'vit', lcp, cls: (i + 1) / 10, path: '/', dev: 'm', bot: 0 });
  await raw(T0, 'err', null, { t: 'err', h: 'abc123', path: '/', bot: 0 });
  await raw(T0 + MIN, 'err', null, { t: 'err', h: 'abc123', path: '/', bot: 0 });
  // 屏蔽事件(服务端注入形态):独立分桶
  await raw(T0, 'blocked', null, { t: 'blocked', c: 'CN', p: 'page' });
  await raw(T0 + MIN, 'blocked', null, { t: 'blocked', c: 'CN', p: 'page' });
  await raw(T0 + 2 * MIN, 'blocked', null, { t: 'blocked', c: 'CN', p: 'page' });
  await raw(T0, 'blocked', null, { t: 'blocked', c: 'US', p: 'page' });
  // 邻日事件:不得混入本日
  await raw(T0 + 86_400_000, 'pv', 'dddddddddddddddd', pv('en', 'VN', 'm', 'direct'));
}

describe('CON03/§5.3 日汇总口径', () => {
  it('九表数值精确对账(会话切分/uv 去重/Bot 排除/learn 派生/blocked 分桶/日界)', async () => {
    await seedScenario();
    await runDailyRollup(env.DB, DAY);

    const tr = (await env.DB.prepare('SELECT * FROM daily_traffic WHERE date=?1 ORDER BY locale').bind(DAY).all()).results as Array<Record<string, unknown>>;
    expect(tr.length).toBe(2);
    expect(tr[0]).toMatchObject({ locale: 'en', country: 'VN', device: 'm', ref_class: 'direct', pv: 3, uv: 1, sessions: 2 });
    expect(tr[1]).toMatchObject({ locale: 'vi', country: 'US', device: 'd', ref_class: 'search', pv: 2, uv: 1, sessions: 1 });

    const cta = await env.DB.prepare('SELECT clicks, uniq FROM daily_cta WHERE date=?1 AND cta_id=?2').bind(DAY, 'ios').first();
    expect(cta).toMatchObject({ clicks: 3, uniq: 2 });
    const sec = await env.DB.prepare('SELECT uniq FROM daily_section WHERE date=?1 AND section_id=?2').bind(DAY, 'download').first();
    expect(sec).toMatchObject({ uniq: 2 });
    const faq = await env.DB.prepare('SELECT opens FROM daily_faq WHERE date=?1 AND faq_id=?2').bind(DAY, 'q3').first();
    expect(faq).toMatchObject({ opens: 2 });
    const learn = await env.DB.prepare('SELECT reads FROM daily_learn WHERE date=?1 AND slug=?2').bind(DAY, 'getting-started').first();
    expect(learn).toMatchObject({ reads: 1 });
    const vit = await env.DB.prepare('SELECT lcp_p75, cls_p75, n FROM daily_vitals WHERE date=?1').bind(DAY).first();
    expect(vit).toMatchObject({ lcp_p75: 3000, cls_p75: 0.3, n: 4 });
    const err = await env.DB.prepare('SELECT count FROM daily_errors WHERE date=?1 AND msg_hash=?2').bind(DAY, 'abc123').first();
    expect(err).toMatchObject({ count: 2 });
    const blk = (await env.DB.prepare('SELECT country, hits FROM daily_blocked WHERE date=?1 ORDER BY hits DESC').bind(DAY).all()).results;
    expect(blk).toEqual([
      { country: 'CN', hits: 3 },
      { country: 'US', hits: 1 },
    ]);
    const bot = await env.DB.prepare('SELECT bot_share FROM daily_bot WHERE date=?1').bind(DAY).first<{ bot_share: number }>();
    expect(bot!.bot_share).toBeCloseTo(1 / 6, 3);
  });

  it('幂等:重跑同日结果不翻倍', async () => {
    await seedScenario();
    await runDailyRollup(env.DB, DAY);
    await runDailyRollup(env.DB, DAY);
    const tr = await env.DB.prepare('SELECT COUNT(*) c FROM daily_traffic WHERE date=?1').bind(DAY).first<{ c: number }>();
    expect(tr!.c).toBe(2);
    const cta = await env.DB.prepare('SELECT clicks FROM daily_cta WHERE date=?1 AND cta_id=?2').bind(DAY, 'ios').first();
    expect(cta).toMatchObject({ clicks: 3 });
  });

  it('90 天滚动清理:91 天前删、89 天前留;p75 公式=nearest-rank', async () => {
    const now = Date.now();
    await raw(now - 91 * 86_400_000, 'pv', 'x1', pv('en', 'VN', 'm', 'direct'));
    await raw(now - 89 * 86_400_000, 'pv', 'x2', pv('en', 'VN', 'm', 'direct'));
    const deleted = await pruneRawEvents(env.DB, now);
    expect(deleted).toBe(1);
    const left = await env.DB.prepare('SELECT uid FROM raw_events').all<{ uid: string }>();
    expect(left.results.map((r) => r.uid)).toEqual(['x2']);
    expect(p75([1000, 2000, 3000, 4000])).toBe(3000);
    expect(p75([5])).toBe(5);
    expect(p75([])).toBeNull();
  });
});
