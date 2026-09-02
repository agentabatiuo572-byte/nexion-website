// T19 验收(plan;继承 CON03-A1/A2/E1/E2/③ 口径字典)。
import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { app } from '../src/index';

const IP = { 'cf-connecting-ip': '203.0.113.77', 'content-type': 'application/json' };
const PW = 'dash-suite-password!';
const DAY = 86_400_000;
const dayStr = (t: number) => new Date(t).toISOString().slice(0, 10);
const today = dayStr(Date.now());
const yesterday = dayStr(Date.now() - DAY);

async function login(): Promise<string> {
  await app.request('/api/auth/setup', { method: 'POST', headers: IP, body: JSON.stringify({ token: env.SETUP_TOKEN, password: PW }) }, env);
  const res = await app.request('/api/auth/login', { method: 'POST', headers: IP, body: JSON.stringify({ password: PW }) }, env);
  return `nx_sid=${(res.headers.get('set-cookie') ?? '').match(/nx_sid=([^;]+)/)?.[1]}`;
}

async function dash(cookie: string, range = 7) {
  const res = await app.request(`/api/dash?range=${range}`, { headers: { cookie } }, env);
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, any>;
}

beforeEach(async () => {
  for (const t of ['audit', 'sessions', 'login_throttle', 'auth_account', 'config_versions', 'config_draft', 'raw_events',
    'daily_traffic', 'daily_cta', 'daily_section', 'daily_faq', 'daily_learn', 'daily_vitals', 'daily_errors', 'daily_blocked', 'daily_bot', 'daily_page', 'daily_notfound'])
    await env.DB.prepare(`DELETE FROM ${t}`).run();
});

/** 造一组可手算的日汇总:昨天 en/VN 100pv/40uv,今天 vi/VN 60pv/30uv */
async function seed() {
  await env.DB.batch([
    env.DB.prepare("INSERT INTO daily_traffic (date,locale,country,device,ref_class,pv,uv,sessions) VALUES (?1,'en','VN','m','direct',100,40,45)").bind(yesterday),
    env.DB.prepare("INSERT INTO daily_traffic (date,locale,country,device,ref_class,pv,uv,sessions) VALUES (?1,'vi','VN','d','search',60,30,32)").bind(today),
    env.DB.prepare("INSERT INTO daily_cta (date,cta_id,locale,clicks,uniq) VALUES (?1,'ios','en',10,8)").bind(yesterday),
    env.DB.prepare("INSERT INTO daily_cta (date,cta_id,locale,clicks,uniq) VALUES (?1,'android','vi',5,4)").bind(today),
    env.DB.prepare("INSERT INTO daily_section (date,section_id,uniq) VALUES (?1,'download',50)").bind(yesterday),
    env.DB.prepare("INSERT INTO daily_section (date,section_id,uniq) VALUES (?1,'trust',20)").bind(yesterday),
    env.DB.prepare("INSERT INTO daily_page (date,path,locale,pv,uv) VALUES (?1,'/',' en',90,38)").bind(yesterday),
    env.DB.prepare("INSERT INTO daily_page (date,path,locale,pv,uv) VALUES (?1,'/vi/','vi',60,30)").bind(today),
    env.DB.prepare("INSERT INTO daily_notfound (date,path,hits) VALUES (?1,'/old-page',7)").bind(today),
    env.DB.prepare("INSERT INTO daily_errors (date,msg_hash,count) VALUES (?1,'abc',3)").bind(today),
    env.DB.prepare("INSERT INTO daily_vitals (date,lcp_p75,cls_p75,n) VALUES (?1,2100,0.04,50)").bind(today),
    env.DB.prepare("INSERT INTO daily_bot (date,bot_share,bot_pv,human_pv) VALUES (?1,0.2,20,80)").bind(today),
    env.DB.prepare("INSERT INTO daily_blocked (date,country,hits) VALUES (?1,'CN',12)").bind(today),
  ]);
}

describe('CON03 驾驶舱聚合', () => {
  it('未登录 401', async () => {
    expect((await app.request('/api/dash', {}, env)).status).toBe(401);
  });

  it('E1 无数据:总览 hasData=false、榜单空数组、比率 null(不造 0% 假环比)', async () => {
    const cookie = await login();
    const d = await dash(cookie);
    expect(d.overview.hasData).toBe(false);
    expect(d.overview.starRate).toBeNull();
    expect(d.overview.deltaUv).toBeNull();
    expect(d.trend).toEqual([]);
    expect(d.content.pages).toEqual([]);
    expect(d.quality.latest).toBeNull();
  });

  it('A1 总览/趋势/漏斗/内容/质量口径精确对账', async () => {
    const cookie = await login();
    await seed();
    const d = await dash(cookie, 7);
    // 总览:两天合计 pv 160 / uv 70;cta 点击 15、访客 12
    expect(d.overview).toMatchObject({ pv: 160, uv: 70, ctaClicks: 15, ctaVisitors: 12, hasData: true });
    expect(d.overview.starRate).toBeCloseTo(12 / 70, 5); // 北极星=点击访客÷UV
    expect(d.overview.byCta.map((x: any) => x.cta_id).sort()).toEqual(['android', 'ios']);
    // 趋势:两天两行,今天 cta=5
    expect(d.trend.length).toBe(2);
    expect(d.trend.find((r: any) => r.date === today)).toMatchObject({ pv: 60, uv: 30, cta: 5 });
    // 漏斗:uv 70 → download 50 → trust 20 → cta 12
    expect(d.funnel).toMatchObject({ uv: 70, download: 50, trust: 20, cta: 12 });
    // 分语言:en uv40 rate 8/40;vi uv30 rate 4/30
    const en = d.locales.find((x: any) => x.locale === 'en');
    const vi = d.locales.find((x: any) => x.locale === 'vi');
    expect(en.rate).toBeCloseTo(0.2, 5);
    expect(vi.rate).toBeCloseTo(4 / 30, 5);
    expect(en.share + vi.share).toBeCloseTo(1, 5);
    // 维度:国家合并同名(VN 两天 uv 70)
    expect(d.dims.countries.find((x: any) => x.k === 'VN').uv).toBe(70);
    expect(d.dims.sources.map((x: any) => x.k).sort()).toEqual(['direct', 'search']);
    // 内容 + 质量
    expect(d.content.pages.length).toBe(2);
    expect(d.content.sections.find((x: any) => x.section_id === 'download').uniq).toBe(50);
    expect(d.quality.latest).toMatchObject({ lcp_p75: 2100, cls_p75: 0.04, n: 50 });
    expect(d.quality.errors).toBe(3);
    expect(d.quality.notFoundTotal).toBe(7);
    // 运营健康
    expect(d.health.blocked).toBe(12);
    expect(d.health.botShare).toBeCloseTo(0.2, 5);
    expect(d.health.geo).toMatchObject({ enabled: false });
  });

  it('A2 区间边界:range=1 只含今天;超范围钳制到 90', async () => {
    const cookie = await login();
    await seed();
    const d1 = await dash(cookie, 1);
    expect(d1.overview.pv).toBe(60); // 昨天不计入
    expect(d1.range).toBe(1);
    const res = await app.request('/api/dash?range=999', { headers: { cookie } }, env);
    expect(((await res.json()) as { range: number }).range).toBe(90);
  });

  it('环比:上一等长周期有数时给出变化率', async () => {
    const cookie = await login();
    // 当期(近 2 天)uv 30;上期(再往前 2 天)uv 15 → deltaUv = +1.0
    await env.DB.batch([
      env.DB.prepare("INSERT INTO daily_traffic (date,locale,country,device,ref_class,pv,uv,sessions) VALUES (?1,'en','US','d','direct',60,30,30)").bind(today),
      env.DB.prepare("INSERT INTO daily_traffic (date,locale,country,device,ref_class,pv,uv,sessions) VALUES (?1,'en','US','d','direct',30,15,15)").bind(dayStr(Date.now() - 3 * DAY)),
    ]);
    const d = await dash(cookie, 2);
    expect(d.overview.deltaUv).toBeCloseTo(1, 5);
  });

  it('E2 今日实时:直查原始事件,Bot 不计入 uv/pv;blocked 独立', async () => {
    const cookie = await login();
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO raw_events (ts,type,uid,payload) VALUES (?1,'pv','u1',?2)").bind(now, JSON.stringify({ t: 'pv', path: '/', bot: 0 })),
      env.DB.prepare("INSERT INTO raw_events (ts,type,uid,payload) VALUES (?1,'pv','u1',?2)").bind(now, JSON.stringify({ t: 'pv', path: '/x', bot: 0 })),
      env.DB.prepare("INSERT INTO raw_events (ts,type,uid,payload) VALUES (?1,'pv','bot1',?2)").bind(now, JSON.stringify({ t: 'pv', path: '/', bot: 1 })),
      // 故意不带 bot 字段:缺字段应按「非爬虫」计(采集端总会写,但判据不能因缺字段把真人算成爬虫)
      env.DB.prepare("INSERT INTO raw_events (ts,type,uid,payload) VALUES (?1,'cta','u1',?2)").bind(now, JSON.stringify({ t: 'cta', cta: 'ios' })),
      env.DB.prepare("INSERT INTO raw_events (ts,type,uid,payload) VALUES (?1,'blocked',NULL,?2)").bind(now, JSON.stringify({ t: 'blocked', c: 'CN' })),
    ]);
    const d = await dash(cookie);
    expect(d.todayLive).toMatchObject({ pv: 2, uv: 1, cta: 1, blocked: 1 }); // bot 那条不计
  });

  it('P1-2 今日实时:点击数与 UV 同样排除爬虫(同卡内口径必须一致)', async () => {
    const cookie = await login();
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO raw_events (ts,type,uid,payload) VALUES (?1,'cta','u1',?2)").bind(now, JSON.stringify({ t: 'cta', cta: 'ios', bot: 0 })),
      env.DB.prepare("INSERT INTO raw_events (ts,type,uid,payload) VALUES (?1,'cta','bot1',?2)").bind(now, JSON.stringify({ t: 'cta', cta: 'ios', bot: 1 })),
      env.DB.prepare("INSERT INTO raw_events (ts,type,uid,payload) VALUES (?1,'cta','bot2',?2)").bind(now, JSON.stringify({ t: 'cta', cta: 'android', bot: 1 })),
    ]);
    const d = await dash(cookie);
    expect(d.todayLive.cta).toBe(1); // 3 条里只有 1 条非爬虫
  });

  it('P1-3 爬虫占比按请求加权(非日均值);旧口径区间回 null 不冒充', async () => {
    const cookie = await login();
    // 两天:D1 bot 90/human 10(90%),D2 bot 10/human 90(10%)。
    // 日均值 = 50%(错);请求加权 = 100/200 = 50%… 换组能区分的数:
    // D1 bot 90/human 10;D2 bot 5/human 195 → 日均 (0.9+0.025)/2=46.3%;加权 95/300=31.7%
    await env.DB.batch([
      env.DB.prepare('INSERT INTO daily_bot (date,bot_share,bot_pv,human_pv) VALUES (?1,0.9,90,10)').bind(yesterday),
      env.DB.prepare('INSERT INTO daily_bot (date,bot_share,bot_pv,human_pv) VALUES (?1,0.025,5,195)').bind(today),
    ]);
    const d = await dash(cookie);
    expect(d.health.botShare).toBeCloseTo(95 / 300, 4); // 加权口径
    expect(d.health.botShare).not.toBeCloseTo((0.9 + 0.025) / 2, 3); // 明确不是日均值
    expect(d.health.botLegacy).toBe(false);
    // 旧口径行(无分子分母)→ null + legacy 标记,不拿旧数冒充
    await env.DB.prepare('DELETE FROM daily_bot').run();
    await env.DB.prepare('INSERT INTO daily_bot (date,bot_share,bot_pv,human_pv) VALUES (?1,0.42,0,0)').bind(today).run();
    const d2 = await dash(cookie);
    expect(d2.health.botShare).toBeNull();
    expect(d2.health.botLegacy).toBe(true);
  });

  it('P1-1 下载探活状态入库并给出红条判据(连续 ≥2 次失败)', async () => {
    const cookie = await login();
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare('INSERT INTO probe_status (target,url,ok,status,fail_streak,checked_at) VALUES (?1,?2,?3,?4,?5,?6)').bind('android', 'https://play.example/x', 0, 0, 2, now),
      env.DB.prepare('INSERT INTO probe_status (target,url,ok,status,fail_streak,checked_at) VALUES (?1,?2,?3,?4,?5,?6)').bind('h5', 'https://app.example', 1, 200, 0, now),
    ]);
    const d = await dash(cookie);
    const byTarget = Object.fromEntries((d.health.probes as Array<{ target: string; alert: boolean; ok: boolean }>).map((p) => [p.target, p]));
    expect(byTarget.android).toMatchObject({ ok: false, alert: true }); // 连续 2 次 → 红条
    expect(byTarget.h5).toMatchObject({ ok: true, alert: false });
    // 单次失败不报红(防抖:商店偶发抖动不该惊动运营)
    await env.DB.prepare('UPDATE probe_status SET fail_streak = 1 WHERE target = ?1').bind('android').run();
    const d2 = await dash(cookie);
    expect((d2.health.probes as Array<{ target: string; alert: boolean }>).find((p) => p.target === 'android')!.alert).toBe(false);
  });

  it('最近发布排除初始种子行(种子不是一次发布)', async () => {
    const cookie = await login();
    await app.request('/api/config', { headers: { cookie } }, env); // 触发种子化
    const d = await dash(cookie);
    expect(d.health.lastPublish).toBeNull(); // 只有种子行时不谎报「最近发布成功」
  });

  it('E3/R2-P2 隔离粒度=展示粒度:弄坏页面榜的表,只有那一榜 error,另三榜照常出数', async () => {
    const cookie = await login();
    await seed();
    await env.DB.prepare('DROP TABLE daily_page').run(); // 只弄坏「页面 PV 榜」依赖的表
    const d = await dash(cookie);
    expect(d.content.pages).toEqual({ error: true });
    expect(d.content.faq).not.toEqual({ error: true }); // 另三榜的表是健康的,不该跟着黑
    expect(d.content.learn).not.toEqual({ error: true });
    expect(d.content.sections.find((s: any) => s.section_id === 'download').uniq).toBe(50);
    expect(d.overview.pv).toBe(160); // 其余组不受影响
    expect(d.funnel.uv).toBe(70);
    // 还表:否则后续用例的 beforeEach 清表会炸(测试之间不许互相污染)
    await env.DB.prepare('CREATE TABLE daily_page (date TEXT NOT NULL, path TEXT NOT NULL, locale TEXT NOT NULL, pv INTEGER NOT NULL DEFAULT 0, uv INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (date, path, locale))').run();
  });

  it('R2-P2 爬虫占比混合窗:标注覆盖天数,不把半个窗口冒充全期', async () => {
    const cookie = await login();
    await env.DB.batch([
      env.DB.prepare('INSERT INTO daily_bot (date,bot_share,bot_pv,human_pv) VALUES (?1,0.9,90,10)').bind(today), // 新口径行
      env.DB.prepare('INSERT INTO daily_bot (date,bot_share,bot_pv,human_pv) VALUES (?1,0.42,0,0)').bind(yesterday), // 旧口径行(无分母)
    ]);
    const d = await dash(cookie);
    expect(d.health.botShare).toBeCloseTo(0.9, 4); // 有分母的那天
    expect(d.health.botDays).toEqual({ covered: 1, total: 2 }); // 覆盖度如实回传 → 前端标注
    expect(d.health.botLegacy).toBe(false); // 不是「全窗无分母」
  });

  it('R2-P3 质量指标各看各的表:有报错但无性能样本时,报错数照样出(不被藏成「—」)', async () => {
    const cookie = await login();
    await env.DB.prepare("INSERT INTO daily_errors (date,msg_hash,count) VALUES (?1,'boom',14)").bind(today).run();
    const d = await dash(cookie); // daily_vitals 空
    expect(d.quality.latest).toBeNull();
    expect(d.quality.errors).toBe(14); // 关键:不因另一张表没数据而变 null
    expect(d.quality.notFoundTotal).toBeNull(); // 自己的表没数据才是 null
  });
});
