// T6 验收(plan T6;继承 CON03-③ 口径字典):合成事件 → 全部日表数值精确对账。
import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dailyJob, p75, pruneRawEvents, runDailyRollup } from '../src/rollup';

const DAY = '2026-08-15';
const T0 = Date.parse(`${DAY}T10:00:00.000Z`);
const MIN = 60_000;

async function raw(ts: number, type: string, uid: string | null, payload: Record<string, unknown>) {
  await env.DB.prepare('INSERT INTO raw_events (ts, type, uid, payload) VALUES (?1,?2,?3,?4)')
    .bind(ts, type, uid, JSON.stringify(payload))
    .run();
}
const pv = (loc: string, country: string, dev: string, ref: string, path = '/', bot = 0) => ({
  t: 'pv', path, loc, dev, ref, us: '', um: '', uc: '', country, bot,
});

beforeEach(async () => {
  vi.restoreAllMocks();
  for (const t of [
    'raw_events', 'rollup_rejected_events', 'audit', 'daily_traffic', 'daily_visitors', 'daily_dimensions', 'daily_cta', 'daily_section', 'daily_faq',
    'daily_learn', 'daily_vitals', 'daily_errors', 'daily_blocked', 'daily_bot', 'daily_page', 'daily_notfound',
  ])
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
  await raw(T0, 'cta', 'aaaaaaaaaaaaaaaa', { t: 'cta', cta: 'ios', sec: 'download', loc: 'en', path: '/', country: 'VN', bot: 0 });
  await raw(T0 + MIN, 'cta', 'aaaaaaaaaaaaaaaa', { t: 'cta', cta: 'ios', sec: 'download', loc: 'en', path: '/', country: 'VN', bot: 0 });
  await raw(T0, 'cta', 'bbbbbbbbbbbbbbbb', { t: 'cta', cta: 'ios', sec: 'download', loc: 'en', path: '/', country: 'US', bot: 0 });
  await raw(T0, 'sec', 'aaaaaaaaaaaaaaaa', { t: 'sec', sec: 'download', path: '/', country: 'VN', bot: 0 });
  await raw(T0, 'sec', 'bbbbbbbbbbbbbbbb', { t: 'sec', sec: 'download', path: '/', country: 'US', bot: 0 });
  await raw(T0, 'faq', 'aaaaaaaaaaaaaaaa', { t: 'faq', faq: 'q3', loc: 'en', country: 'VN', bot: 0 });
  await raw(T0 + MIN, 'faq', 'bbbbbbbbbbbbbbbb', { t: 'faq', faq: 'q3', loc: 'vi', country: 'US', bot: 0 });
  // vitals:LCP [1000,2000,3000,4000] → p75=3000;CLS [0.1,0.2,0.3,0.4] → 0.3
  for (const [i, lcp] of [1000, 2000, 3000, 4000].entries())
    await raw(T0 + i, 'vit', 'aaaaaaaaaaaaaaaa', { t: 'vit', lcp, cls: (i + 1) / 10, path: '/', dev: 'm', country: 'VN', bot: 0 });
  await raw(T0, 'err', 'aaaaaaaaaaaaaaaa', { t: 'err', h: 'abc123', path: '/', country: 'VN', bot: 0 });
  await raw(T0 + MIN, 'err', 'aaaaaaaaaaaaaaaa', { t: 'err', h: 'abc123', path: '/', country: 'VN', bot: 0 });
  // 屏蔽事件(服务端注入形态):独立分桶
  await raw(T0, 'blocked', null, { t: 'blocked', c: 'CN', p: 'page' });
  await raw(T0 + MIN, 'blocked', null, { t: 'blocked', c: 'CN', p: 'page' });
  await raw(T0 + 2 * MIN, 'blocked', null, { t: 'blocked', c: 'CN', p: 'page' });
  await raw(T0, 'blocked', null, { t: 'blocked', c: 'US', p: 'page' });
  // 邻日事件:不得混入本日
  await raw(T0 + 86_400_000, 'pv', 'dddddddddddddddd', pv('en', 'VN', 'm', 'direct'));
}

describe('CON03/§5.3 日汇总口径', () => {
  it('全部日表数值精确对账(会话切分/uv 去重/Bot 排除/learn 派生/blocked 分桶/日界)', async () => {
    await seedScenario();
    await runDailyRollup(env.DB, DAY);

    const tr = (await env.DB.prepare('SELECT * FROM daily_traffic WHERE date=?1 ORDER BY locale').bind(DAY).all()).results as Array<Record<string, unknown>>;
    expect(tr.length).toBe(2);
    expect(tr[0]).toMatchObject({ locale: 'en', country: 'VN', device: 'm', ref_class: 'direct', pv: 3, uv: 1, sessions: 2 });
    expect(tr[1]).toMatchObject({ locale: 'vi', country: 'US', device: 'd', ref_class: 'search', pv: 2, uv: 1, sessions: 1 });
    expect(await env.DB.prepare('SELECT uv,sessions,cta_visitors,rollup_version FROM daily_visitors WHERE date=?1').bind(DAY).first())
      .toMatchObject({ uv: 2, sessions: 3, cta_visitors: 2, rollup_version: 2 });

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

  it('聚合键超过 50 时 SQL 条数仍有固定上界，不丢聚合结果', async () => {
    const keyCount = 73;
    for (let i = 0; i < keyCount; i++) {
      await raw(T0 + i, 'e404', null, { t: 'e404', path: `/missing-${i}` });
    }

    let statementCount = 0;
    const boundedDb = {
      prepare: env.DB.prepare.bind(env.DB),
      batch: async (statements: D1PreparedStatement[]) => {
        statementCount = statements.length;
        if (statements.length > 29) throw new Error(`D1 statement limit exceeded: ${statements.length}`);
        return env.DB.batch(statements);
      },
    } as D1Database;

    const result = await runDailyRollup(boundedDb, DAY, { action: 'admin.rollup', target: DAY });

    expect(statementCount).toBe(29);
    expect(result).toEqual({ scannedEvents: keyCount, processedEvents: keyCount, rejectedEvents: 0 });
    expect(
      await env.DB.prepare('SELECT COUNT(*) AS n, SUM(hits) AS hits FROM daily_notfound WHERE date=?1').bind(DAY).first(),
    ).toMatchObject({ n: keyCount, hits: keyCount });

    await runDailyRollup(boundedDb, DAY);
    expect(statementCount).toBe(28);
  });

  it('损坏 JSON 按 raw_event_id 幂等隔离，合法事件仍汇总且重跑可追踪', async () => {
    await raw(T0, 'e404', null, { t: 'e404', path: '/valid' });
    const invalid = await env.DB.prepare(
      "INSERT INTO raw_events (ts,type,uid,payload) VALUES (?1,'e404',NULL,?2) RETURNING id",
    ).bind(T0 + 1, '{broken-json').first<{ id: number }>();

    const first = await runDailyRollup(env.DB, DAY);

    expect(first).toEqual({ scannedEvents: 2, processedEvents: 1, rejectedEvents: 1 });
    expect(await env.DB.prepare('SELECT path,hits FROM daily_notfound WHERE date=?1').bind(DAY).first())
      .toMatchObject({ path: '/valid', hits: 1 });
    expect(await env.DB.prepare(
      'SELECT raw_event_id,date,event_type,reason,payload,attempts FROM rollup_rejected_events WHERE raw_event_id=?1',
    ).bind(invalid!.id).first()).toMatchObject({
      raw_event_id: invalid!.id,
      date: DAY,
      event_type: 'e404',
      reason: 'invalid-json',
      payload: '{broken-json',
      attempts: 1,
    });

    const second = await runDailyRollup(env.DB, DAY);
    expect(second).toEqual(first);
    expect(await env.DB.prepare('SELECT attempts FROM rollup_rejected_events WHERE raw_event_id=?1').bind(invalid!.id).first())
      .toMatchObject({ attempts: 2 });
  });

  it('严格拒绝不存在的 UTC 日历日期，不能由 Date.parse 静默归一', async () => {
    await expect(runDailyRollup(env.DB, '2026-02-31')).rejects.toThrow(/date|day|UTC/i);
  });

  it('e404 与 blocked 一样排除显式 bot，缺 bot 的历史事件仍按真人计', async () => {
    await raw(T0, 'e404', null, { t: 'e404', path: '/human-legacy' });
    await raw(T0 + 1, 'e404', null, { t: 'e404', path: '/human', bot: 0 });
    await raw(T0 + 2, 'e404', null, { t: 'e404', path: '/crawler', bot: 1 });

    expect(await runDailyRollup(env.DB, DAY)).toEqual({ scannedEvents: 3, processedEvents: 3, rejectedEvents: 0 });
    expect((await env.DB.prepare('SELECT path,hits FROM daily_notfound WHERE date=?1 ORDER BY path').bind(DAY).all()).results)
      .toEqual([
        { path: '/human', hits: 1 },
        { path: '/human-legacy', hits: 1 },
      ]);
  });

  it('原始 envelope 与服务端字段越界会隔离，不能污染任一汇总表', async () => {
    await raw(T0, 'pv', 'not-16-hex', pv('en', 'VN', 'm', 'direct'));
    await raw(T0 + 1, 'pv', 'eeeeeeeeeeeeeeee', pv('en', 'COUNTRY-TOO-LONG', 'm', 'direct'));
    await raw(T0 + 2, 'blocked', null, { t: 'blocked', c: 'CN', p: 'x'.repeat(25), bot: 0 });
    await raw(T0 + 3, 'pv', 'ffffffffffffffff', pv('en', 'VN', 'm', 'direct'));

    expect(await runDailyRollup(env.DB, DAY)).toEqual({ scannedEvents: 4, processedEvents: 1, rejectedEvents: 3 });
    expect(await env.DB.prepare('SELECT SUM(pv) AS pv FROM daily_traffic WHERE date=?1').bind(DAY).first())
      .toMatchObject({ pv: 1 });
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM daily_blocked WHERE date=?1').bind(DAY).first())
      .toMatchObject({ n: 0 });
  });

  it('绕过采集直写 raw 时，非法 section/CTA/FAQ 仍由 rollup 合同隔离', async () => {
    await raw(T0, 'sec', '1212121212121212', { t: 'sec', sec: 'unknown', path: '/', country: 'VN', bot: 0 });
    await raw(T0 + 1, 'cta', '1313131313131313', {
      t: 'cta', cta: 'download', sec: 'download', loc: 'en', path: '/', country: 'VN', bot: 0,
    });
    await raw(T0 + 2, 'faq', '1414141414141414', { t: 'faq', faq: 'q0', loc: 'en', country: 'VN', bot: 0 });
    await raw(T0 + 3, 'faq', '1515151515151515', { t: 'faq', faq: 'q12', loc: 'en', country: 'VN', bot: 0 });

    expect(await runDailyRollup(env.DB, DAY)).toEqual({ scannedEvents: 4, processedEvents: 1, rejectedEvents: 3 });
    expect(await env.DB.prepare('SELECT faq_id,opens FROM daily_faq WHERE date=?1').bind(DAY).first())
      .toMatchObject({ faq_id: 'q12', opens: 1 });
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM daily_section WHERE date=?1').bind(DAY).first())
      .toMatchObject({ n: 0 });
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM daily_cta WHERE date=?1').bind(DAY).first())
      .toMatchObject({ n: 0 });
  });

  it('历史事件缺失 bot 时沿用旧 JS 口径按真人汇总，所有真人口径表保持一致', async () => {
    await raw(T0, 'pv', '1111111111111111', {
      t: 'pv', path: '/learn/no-bot', loc: 'en', dev: 'm', ref: 'direct', us: '', um: '', uc: '', country: 'VN',
    });
    await raw(T0 + 1, 'cta', '1111111111111111', {
      t: 'cta', cta: 'ios', sec: 'download', loc: 'en', path: '/', country: 'VN',
    });
    await raw(T0 + 2, 'sec', '1111111111111111', {
      t: 'sec', sec: 'download', path: '/', country: 'VN',
    });
    await raw(T0 + 3, 'faq', '1111111111111111', {
      t: 'faq', faq: 'q1', loc: 'en', country: 'VN',
    });
    await raw(T0 + 4, 'vit', '1111111111111111', {
      t: 'vit', lcp: 1234, cls: 0.123, path: '/', dev: 'm', country: 'VN',
    });

    expect(await runDailyRollup(env.DB, DAY)).toEqual({ scannedEvents: 5, processedEvents: 5, rejectedEvents: 0 });
    expect(await env.DB.prepare('SELECT pv,uv,sessions FROM daily_traffic WHERE date=?1').bind(DAY).first())
      .toMatchObject({ pv: 1, uv: 1, sessions: 1 });
    expect(await env.DB.prepare('SELECT pv,uv FROM daily_page WHERE date=?1').bind(DAY).first())
      .toMatchObject({ pv: 1, uv: 1 });
    expect(await env.DB.prepare('SELECT clicks,uniq FROM daily_cta WHERE date=?1').bind(DAY).first())
      .toMatchObject({ clicks: 1, uniq: 1 });
    expect(await env.DB.prepare('SELECT uniq FROM daily_section WHERE date=?1').bind(DAY).first())
      .toMatchObject({ uniq: 1 });
    expect(await env.DB.prepare('SELECT opens FROM daily_faq WHERE date=?1').bind(DAY).first())
      .toMatchObject({ opens: 1 });
    expect(await env.DB.prepare('SELECT slug,reads FROM daily_learn WHERE date=?1').bind(DAY).first())
      .toMatchObject({ slug: 'no-bot', reads: 1 });
    expect(await env.DB.prepare('SELECT lcp_p75,cls_p75,n FROM daily_vitals WHERE date=?1').bind(DAY).first())
      .toMatchObject({ lcp_p75: 1234, cls_p75: 0.123, n: 1 });
    expect(await env.DB.prepare('SELECT bot_pv,human_pv FROM daily_bot WHERE date=?1').bind(DAY).first())
      .toMatchObject({ bot_pv: 0, human_pv: 1 });
  });

  it('命中 bot 的错误事件不进入 daily_errors，真人错误仍汇总', async () => {
    await raw(T0, 'err', '2222222222222222', { t: 'err', h: 'same-hash', path: '/', country: 'VN', bot: 0 });
    await raw(T0 + 1, 'err', '3333333333333333', { t: 'err', h: 'same-hash', path: '/', country: 'VN', bot: 1 });

    expect(await runDailyRollup(env.DB, DAY)).toEqual({ scannedEvents: 2, processedEvents: 2, rejectedEvents: 0 });
    expect(await env.DB.prepare('SELECT msg_hash,count FROM daily_errors WHERE date=?1').bind(DAY).first())
      .toMatchObject({ msg_hash: 'same-hash', count: 1 });
  });

  it('同一访客跨维度的新会话按该会话首条事件归属', async () => {
    const uid = '4444444444444444';
    await raw(T0, 'pv', uid, pv('en', 'VN', 'm', 'direct'));
    await raw(T0 + 31 * MIN, 'pv', uid, pv('vi', 'US', 'd', 'search'));

    expect(await runDailyRollup(env.DB, DAY)).toEqual({ scannedEvents: 2, processedEvents: 2, rejectedEvents: 0 });
    expect((await env.DB.prepare(`
      SELECT locale,country,device,ref_class,pv,sessions
      FROM daily_traffic WHERE date=?1 ORDER BY locale
    `).bind(DAY).all()).results).toEqual([
      { locale: 'en', country: 'VN', device: 'm', ref_class: 'direct', pv: 1, sessions: 1 },
      { locale: 'vi', country: 'US', device: 'd', ref_class: 'search', pv: 1, sessions: 1 },
    ]);
  });

  it('所有真人活动延续会话；维度取该会话首条 PV，整日 UV 与 CTA 访客只全局去重一次', async () => {
    const uid = '5555555555555555';
    await raw(T0, 'pv', uid, pv('en', 'VN', 'm', 'direct'));
    await raw(T0 + 25 * MIN, 'cta', uid, {
      t: 'cta', cta: 'ios', sec: 'download', loc: 'en', path: '/', country: 'VN', bot: 0,
    });
    await raw(T0 + 26 * MIN, 'cta', uid, {
      t: 'cta', cta: 'android', sec: 'download', loc: 'en', path: '/vi/', country: 'VN', bot: 0,
    });
    await raw(T0 + 50 * MIN, 'pv', uid, pv('vi', 'US', 'd', 'search'));

    expect(await runDailyRollup(env.DB, DAY)).toEqual({ scannedEvents: 4, processedEvents: 4, rejectedEvents: 0 });
    expect((await env.DB.prepare(`
      SELECT locale,country,device,ref_class,pv,uv,sessions
      FROM daily_traffic WHERE date=?1 ORDER BY locale
    `).bind(DAY).all()).results).toEqual([
      { locale: 'en', country: 'VN', device: 'm', ref_class: 'direct', pv: 1, uv: 1, sessions: 1 },
      { locale: 'vi', country: 'US', device: 'd', ref_class: 'search', pv: 1, uv: 1, sessions: 0 },
    ]);
    expect(await env.DB.prepare('SELECT uv,sessions,cta_visitors FROM daily_visitors WHERE date=?1').bind(DAY).first())
      .toMatchObject({ uv: 1, sessions: 1, cta_visitors: 1 });
  });

  it('全局会话由所有真人活动切分，CTA-only 保留 UV/session，但 contact 不进入转化访客', async () => {
    await raw(T0, 'pv', '1616161616161616', pv('en', 'VN', 'm', 'direct'));
    await raw(T0 + 31 * MIN, 'cta', '1616161616161616', {
      t: 'cta', cta: 'ios', sec: 'download', loc: 'en', path: '/', country: 'VN', bot: 0,
    });
    await raw(T0 + 5 * MIN, 'cta', '1717171717171717', {
      t: 'cta', cta: 'contact', sec: '', loc: 'vi', path: '/vi/', country: 'US', bot: 0,
    });

    await runDailyRollup(env.DB, DAY);
    expect(await env.DB.prepare('SELECT uv,sessions,cta_visitors FROM daily_visitors WHERE date=?1').bind(DAY).first())
      .toMatchObject({ uv: 2, sessions: 3, cta_visitors: 1 });
    expect(await env.DB.prepare('SELECT SUM(sessions) AS sessions FROM daily_traffic WHERE date=?1').bind(DAY).first())
      .toMatchObject({ sessions: 1 });
    expect(await env.DB.prepare("SELECT clicks,uniq FROM daily_cta WHERE date=?1 AND cta_id='contact'").bind(DAY).first())
      .toMatchObject({ clicks: 1, uniq: 1 });
    expect(await env.DB.prepare("SELECT uv,cta_visitors FROM daily_dimensions WHERE date=?1 AND dimension='locale' AND value='vi'").bind(DAY).first())
      .toMatchObject({ uv: 1, cta_visitors: 0 });
  });

  it('会话边界精确：相邻活动恰好 30 分钟仍同会话，30 分钟加 1ms 才切新会话', async () => {
    const uid = '3030303030303030';
    await raw(T0, 'faq', uid, { t: 'faq', faq: 'q1', loc: 'en', country: 'VN', bot: 0 });
    await raw(T0 + 30 * MIN, 'cta', uid, {
      t: 'cta', cta: 'ios', sec: 'download', loc: 'en', path: '/', country: 'VN', bot: 0,
    });
    await raw(T0 + 60 * MIN + 1, 'sec', uid, { t: 'sec', sec: 'trust', path: '/', country: 'VN', bot: 0 });

    await runDailyRollup(env.DB, DAY);

    expect(await env.DB.prepare('SELECT uv,sessions,cta_visitors FROM daily_visitors WHERE date=?1').bind(DAY).first())
      .toMatchObject({ uv: 1, sessions: 2, cta_visitors: 1 });
  });

  it('D1 batch 中途聚合失败时，删除、汇总与审计全部回滚', async () => {
    await env.DB.prepare(
      "INSERT INTO daily_traffic (date,locale,country,device,ref_class,pv,uv,sessions) VALUES (?1,'en','VN','m','direct',77,7,7)",
    ).bind(DAY).run();
    await raw(T0, 'cta', '4040404040404040', {
      t: 'cta', cta: 'ios', sec: 'download', loc: 'en', path: '/', country: 'VN', bot: 0,
    });
    await env.DB.prepare(`CREATE TRIGGER rollup_failure_probe
      BEFORE INSERT ON daily_cta BEGIN SELECT RAISE(ABORT, 'injected rollup failure'); END`).run();

    try {
      await expect(runDailyRollup(env.DB, DAY, { action: 'admin.rollup', target: DAY }))
        .rejects.toThrow(/injected rollup failure/i);
      expect(await env.DB.prepare('SELECT pv,uv,sessions FROM daily_traffic WHERE date=?1').bind(DAY).first())
        .toMatchObject({ pv: 77, uv: 7, sessions: 7 });
      expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM daily_visitors WHERE date=?1').bind(DAY).first())
        .toMatchObject({ n: 0 });
      expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM audit WHERE action='admin.rollup' AND target=?1").bind(DAY).first())
        .toMatchObject({ n: 0 });
    } finally {
      await env.DB.prepare('DROP TRIGGER IF EXISTS rollup_failure_probe').run();
    }
  });

  it('单维度日表各自去重：同 uid 跨语言/国家/设备/来源，每个值各 1 UV 且不相乘', async () => {
    const uid = '1818181818181818';
    await raw(T0, 'pv', uid, pv('en', 'VN', 'm', 'direct'));
    await raw(T0 + MIN, 'pv', uid, pv('vi', 'US', 'd', 'search'));
    await raw(T0 + 2 * MIN, 'cta', uid, {
      t: 'cta', cta: 'ios', sec: 'download', loc: 'en', path: '/', country: 'VN', bot: 0,
    });
    await raw(T0 + 3 * MIN, 'cta', uid, {
      t: 'cta', cta: 'android', sec: 'download', loc: 'en', path: '/', country: 'VN', bot: 0,
    });

    await runDailyRollup(env.DB, DAY);
    expect((await env.DB.prepare(`
      SELECT dimension,value,pv,uv,cta_visitors
      FROM daily_dimensions WHERE date=?1 ORDER BY dimension,value
    `).bind(DAY).all()).results).toEqual([
      { dimension: 'country', value: 'US', pv: 1, uv: 1, cta_visitors: null },
      { dimension: 'country', value: 'VN', pv: 1, uv: 1, cta_visitors: null },
      { dimension: 'device', value: 'd', pv: 1, uv: 1, cta_visitors: null },
      { dimension: 'device', value: 'm', pv: 1, uv: 1, cta_visitors: null },
      { dimension: 'locale', value: 'en', pv: 1, uv: 1, cta_visitors: 1 },
      { dimension: 'locale', value: 'vi', pv: 1, uv: 1, cta_visitors: 0 },
      { dimension: 'ref_class', value: 'direct', pv: 1, uv: 1, cta_visitors: null },
      { dimension: 'ref_class', value: 'search', pv: 1, uv: 1, cta_visitors: null },
    ]);
  });

  it('blocked 缺 bot 仍计数，显式 bot=1 不进入屏蔽统计', async () => {
    await raw(T0, 'blocked', null, { t: 'blocked', c: 'CN', p: 'page' });
    await raw(T0 + 1, 'blocked', null, { t: 'blocked', c: 'CN', p: 'page', bot: 0 });
    await raw(T0 + 2, 'blocked', null, { t: 'blocked', c: 'CN', p: 'page', bot: 1 });

    expect(await runDailyRollup(env.DB, DAY)).toEqual({ scannedEvents: 3, processedEvents: 3, rejectedEvents: 0 });
    expect(await env.DB.prepare('SELECT country,hits FROM daily_blocked WHERE date=?1').bind(DAY).first())
      .toMatchObject({ country: 'CN', hits: 2 });
  });

  it('旧 validator 的同快照隔离记录不会永久压住当前规则已接受的事件', async () => {
    const payload = JSON.stringify({
      t: 'pv', path: '/validator-now-valid', loc: 'en', dev: 'm', ref: 'direct',
      us: '', um: '', uc: '', country: 'VN', bot: 0,
    });
    const source = await env.DB.prepare(
      "INSERT INTO raw_events(ts,type,uid,payload) VALUES(?1,'pv','6666666666666666',?2) RETURNING id",
    ).bind(T0, payload).first<{ id: number }>();
    await env.DB.prepare(`
      INSERT INTO rollup_rejected_events (
        raw_event_id,event_ts,event_type,date,reason,validator_fingerprint,payload,first_seen_at,last_seen_at,attempts
      ) VALUES (?1,?2,'pv',?3,'invalid-event-shape','legacy-validator-v0',?4,?5,?5,7)
    `).bind(source!.id, T0, DAY, payload, T0).run();

    expect(await runDailyRollup(env.DB, DAY)).toEqual({ scannedEvents: 1, processedEvents: 1, rejectedEvents: 0 });
    expect(await env.DB.prepare('SELECT path,pv FROM daily_page WHERE date=?1').bind(DAY).first())
      .toMatchObject({ path: '/validator-now-valid', pv: 1 });
  });

  it('字符串资格与采集层共用 UTF-8 字节上限，并拒绝 NUL', async () => {
    const acceptedPath = '/' + '😀'.repeat(49); // 197 UTF-8 bytes
    const oversizedPath = '/' + '😀'.repeat(50); // 201 UTF-8 bytes
    const nulPath = '/nul' + String.fromCharCode(0) + 'tail';
    const base = { t: 'pv', loc: 'en', dev: 'm', ref: 'direct', us: '', um: '', uc: '', country: 'VN', bot: 0 };
    await raw(T0, 'pv', '7777777777777777', { ...base, path: acceptedPath });
    await raw(T0 + 1, 'pv', '8888888888888888', { ...base, path: oversizedPath });
    await raw(T0 + 2, 'pv', '9999999999999999', { ...base, path: nulPath });

    expect(await runDailyRollup(env.DB, DAY)).toEqual({ scannedEvents: 3, processedEvents: 1, rejectedEvents: 2 });
    expect(await env.DB.prepare('SELECT path,pv FROM daily_page WHERE date=?1').bind(DAY).first())
      .toMatchObject({ path: acceptedPath, pv: 1 });
    expect(await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM rollup_rejected_events WHERE date=?1 AND reason='invalid-event-shape'",
    ).bind(DAY).first()).toMatchObject({ n: 2 });
  });

  it('字段形状非法的 JSON 对象逐行幂等隔离，好数据继续汇总', async () => {
    await raw(T0, 'pv', '1010101010101010', {
      t: 'pv', path: '/', loc: null, dev: 'm', ref: 'direct', us: '', um: '', uc: '', country: 'VN', bot: 0,
    });
    await raw(T0 + 1, 'pv', '2020202020202020', {
      t: 'pv', path: true, loc: 'en', dev: 'm', ref: 'direct', us: '', um: '', uc: '', country: 'VN', bot: 0,
    });
    await raw(T0 + 2, 'vit', '3030303030303030', {
      t: 'vit', lcp: null, cls: 0.1, path: '/', dev: 'm', country: 'VN', bot: 0,
    });
    await raw(T0 + 3, 'vit', '4040404040404040', {
      t: 'vit', lcp: 1000, cls: '0.2', path: '/', dev: 'm', country: 'VN', bot: 0,
    });
    await raw(T0 + 4, 'pv', '5050505050505050', {
      t: 'pv', path: '/', loc: 'en', dev: 'm', ref: 'direct', us: '', um: '', uc: '', country: 'VN', bot: null,
    });
    await raw(T0 + 5, 'e404', null, { t: 'e404', path: '/shape-valid' });

    const first = await runDailyRollup(env.DB, DAY);
    expect(first).toEqual({ scannedEvents: 6, processedEvents: 1, rejectedEvents: 5 });
    expect(await env.DB.prepare('SELECT path,hits FROM daily_notfound WHERE date=?1').bind(DAY).first())
      .toMatchObject({ path: '/shape-valid', hits: 1 });
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM daily_page WHERE date=?1').bind(DAY).first())
      .toMatchObject({ n: 0 });
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM daily_vitals WHERE date=?1').bind(DAY).first())
      .toMatchObject({ n: 0 });
    expect((await env.DB.prepare(
      'SELECT reason,attempts FROM rollup_rejected_events WHERE date=?1 ORDER BY raw_event_id',
    ).bind(DAY).all()).results).toEqual(Array.from({ length: 5 }, () => ({ reason: 'invalid-event-shape', attempts: 1 })));

    expect(await runDailyRollup(env.DB, DAY)).toEqual(first);
    expect(await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM rollup_rejected_events WHERE date=?1 AND reason='invalid-event-shape' AND attempts=2",
    ).bind(DAY).first()).toMatchObject({ n: 5 });

    const repaired = await env.DB.prepare("SELECT id FROM raw_events WHERE uid='1010101010101010'").first<{ id: number }>();
    await env.DB.prepare('UPDATE raw_events SET payload=?1 WHERE id=?2').bind(JSON.stringify({
      t: 'pv', path: '/repaired', loc: 'en', dev: 'm', ref: 'direct', us: '', um: '', uc: '', country: 'VN', bot: 0,
    }), repaired!.id).run();
    expect(await runDailyRollup(env.DB, DAY)).toEqual({ scannedEvents: 6, processedEvents: 2, rejectedEvents: 4 });
    expect(await env.DB.prepare('SELECT path,pv FROM daily_page WHERE date=?1').bind(DAY).first())
      .toMatchObject({ path: '/repaired', pv: 1 });
    expect(await env.DB.prepare('SELECT attempts FROM rollup_rejected_events WHERE raw_event_id=?1').bind(repaired!.id).first())
      .toMatchObject({ attempts: 2 });
  });

  it('定时入口同样汇总合法行并隔离坏行', async () => {
    await raw(T0, 'e404', null, { t: 'e404', path: '/cron-valid' });
    await env.DB.prepare("INSERT INTO raw_events (ts,type,uid,payload) VALUES (?1,'e404',NULL,'null')").bind(T0 + 1).run();
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await dailyJob(env, Date.parse('2026-08-16T00:10:00.000Z'));

    expect(await env.DB.prepare('SELECT path,hits FROM daily_notfound WHERE date=?1').bind(DAY).first())
      .toMatchObject({ path: '/cron-valid', hits: 1 });
    expect(await env.DB.prepare('SELECT reason,attempts FROM rollup_rejected_events WHERE date=?1').bind(DAY).first())
      .toMatchObject({ reason: 'non-object-json', attempts: 1 });
    expect(warning).toHaveBeenCalledWith('daily rollup completed with rejected events', {
      day: DAY,
      rejectedEvents: 1,
    });
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
