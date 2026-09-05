// T19 验收(plan;继承 CON03-A1/A2/E1/E2/③ 口径字典)。
import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { app } from '../src/index';
import { ROLLUP_VERSION, runDailyRollup } from '../src/rollup';

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

const ctaPayload = (cta: 'ios' | 'android' | 'h5' | 'contact', bot: unknown = 0) => ({
  t: 'cta', cta, sec: cta === 'contact' ? '' : 'download', loc: 'en', path: '/', country: 'VN', bot,
});

beforeEach(async () => {
  for (const t of ['audit', 'sessions', 'login_throttle', 'auth_account', 'config_versions', 'config_draft', 'raw_events',
    'daily_traffic', 'daily_visitors', 'daily_dimensions', 'daily_cta', 'daily_section', 'daily_faq', 'daily_learn', 'daily_vitals', 'daily_errors', 'daily_blocked', 'daily_bot', 'daily_page', 'daily_notfound'])
    await env.DB.prepare(`DELETE FROM ${t}`).run();
});

/** 造一组可手算的日汇总:昨天 en/VN 100pv/40uv,今天 vi/VN 60pv/30uv */
async function seed() {
  await env.DB.batch([
    env.DB.prepare("INSERT INTO daily_traffic (date,locale,country,device,ref_class,pv,uv,sessions) VALUES (?1,'en','VN','m','direct',100,40,45)").bind(yesterday),
    env.DB.prepare("INSERT INTO daily_traffic (date,locale,country,device,ref_class,pv,uv,sessions) VALUES (?1,'vi','VN','d','search',60,30,32)").bind(today),
    env.DB.prepare(`INSERT INTO daily_visitors (date,uv,sessions,cta_visitors,rollup_version) VALUES (?1,40,45,8,${ROLLUP_VERSION})`).bind(yesterday),
    env.DB.prepare(`INSERT INTO daily_visitors (date,uv,sessions,cta_visitors,rollup_version) VALUES (?1,30,32,4,${ROLLUP_VERSION})`).bind(today),
    env.DB.prepare("INSERT INTO daily_dimensions (date,dimension,value,pv,uv,cta_visitors) VALUES (?1,'locale','en',100,40,8)").bind(yesterday),
    env.DB.prepare("INSERT INTO daily_dimensions (date,dimension,value,pv,uv,cta_visitors) VALUES (?1,'country','VN',100,40,NULL)").bind(yesterday),
    env.DB.prepare("INSERT INTO daily_dimensions (date,dimension,value,pv,uv,cta_visitors) VALUES (?1,'device','m',100,40,NULL)").bind(yesterday),
    env.DB.prepare("INSERT INTO daily_dimensions (date,dimension,value,pv,uv,cta_visitors) VALUES (?1,'ref_class','direct',100,40,NULL)").bind(yesterday),
    env.DB.prepare("INSERT INTO daily_dimensions (date,dimension,value,pv,uv,cta_visitors) VALUES (?1,'locale','vi',60,30,4)").bind(today),
    env.DB.prepare("INSERT INTO daily_dimensions (date,dimension,value,pv,uv,cta_visitors) VALUES (?1,'country','VN',60,30,NULL)").bind(today),
    env.DB.prepare("INSERT INTO daily_dimensions (date,dimension,value,pv,uv,cta_visitors) VALUES (?1,'device','d',60,30,NULL)").bind(today),
    env.DB.prepare("INSERT INTO daily_dimensions (date,dimension,value,pv,uv,cta_visitors) VALUES (?1,'ref_class','search',60,30,NULL)").bind(today),
    env.DB.prepare("INSERT INTO daily_cta (date,cta_id,locale,clicks,uniq) VALUES (?1,'ios','en',10,8)").bind(yesterday),
    env.DB.prepare("INSERT INTO daily_cta (date,cta_id,locale,clicks,uniq) VALUES (?1,'android','vi',5,4)").bind(today),
    env.DB.prepare("INSERT INTO daily_section (date,section_id,uniq) VALUES (?1,'download',50)").bind(yesterday),
    env.DB.prepare("INSERT INTO daily_section (date,section_id,uniq) VALUES (?1,'trust',20)").bind(yesterday),
    env.DB.prepare("INSERT INTO daily_page (date,path,locale,pv,uv) VALUES (?1,'/','en',90,38)").bind(yesterday),
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
    expect(d.overview.traffic.hasData).toBe(false);
    expect(d.overview.conversion.starRate).toBeNull();
    expect(d.overview.traffic.deltaUv).toBeNull();
    expect(d.trend).toEqual([]);
    expect(d.content.pages).toEqual([]);
    expect(d.quality.latest).toBeNull();
  });

  it('新唯一汇总缺历史覆盖时必须报 unavailable，不能把已有流量/CTA 静默显示成零访客', async () => {
    const cookie = await login();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO daily_traffic (date,locale,country,device,ref_class,pv,uv,sessions) VALUES (?1,'en','VN','m','direct',9,4,5)").bind(today),
      env.DB.prepare("INSERT INTO daily_cta (date,cta_id,locale,clicks,uniq) VALUES (?1,'ios','en',3,2)").bind(today),
    ]);

    const d = await dash(cookie, 1);
    expect(d.overview.traffic).toEqual({ error: true });
    expect(d.overview.conversion).toEqual({ error: true });
    expect(d.trend).toEqual({ error: true });
    expect(d.funnel).toEqual({ error: true });
    expect(d.locales).toEqual({ error: true });
    expect(d.dims).toEqual({ sources: { error: true }, countries: { error: true }, devices: { error: true } });

    // 0013 已建列但该日仍是 0012 旧摘要(version=0)，也必须继续判未覆盖。
    await env.DB.prepare('INSERT INTO daily_visitors (date,uv,sessions,cta_visitors) VALUES (?1,4,5,2)').bind(today).run();
    const stale = await dash(cookie, 1);
    expect(stale.overview.traffic).toEqual({ error: true });
    expect(stale.overview.conversion).toEqual({ error: true });
    expect(stale.trend).toEqual({ error: true });
    expect(stale.funnel).toEqual({ error: true });
  });

  it('只有全局新表、缺单维度汇总时，仅维度依赖卡报 unavailable', async () => {
    const cookie = await login();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO daily_traffic (date,locale,country,device,ref_class,pv,uv,sessions) VALUES (?1,'en','VN','m','direct',9,4,5)").bind(today),
      env.DB.prepare("INSERT INTO daily_cta (date,cta_id,locale,clicks,uniq) VALUES (?1,'ios','en',3,2)").bind(today),
      env.DB.prepare(`INSERT INTO daily_visitors (date,uv,sessions,cta_visitors,rollup_version) VALUES (?1,4,5,2,${ROLLUP_VERSION})`).bind(today),
    ]);

    const d = await dash(cookie, 1);
    expect(d.overview.traffic).toMatchObject({ pv: 9, uv: 4, sessions: 5 });
    expect(d.overview.conversion).toMatchObject({ ctaVisitors: 2 });
    expect(d.trend).toEqual([{ date: today, pv: 9, uv: 4, cta: 3 }]);
    expect(d.funnel).toMatchObject({ uv: 4, cta: 2 });
    expect(d.locales).toEqual({ error: true });
    expect(d.dims).toEqual({ sources: { error: true }, countries: { error: true }, devices: { error: true } });
  });

  it('单维度表只缺一个既有语言值也算覆盖不完整，不能返回残缺榜单', async () => {
    const cookie = await login();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO daily_traffic (date,locale,country,device,ref_class,pv,uv,sessions) VALUES (?1,'en','VN','m','direct',5,1,1)").bind(today),
      env.DB.prepare("INSERT INTO daily_traffic (date,locale,country,device,ref_class,pv,uv,sessions) VALUES (?1,'vi','VN','m','direct',4,1,0)").bind(today),
      env.DB.prepare(`INSERT INTO daily_visitors (date,uv,sessions,cta_visitors,rollup_version) VALUES (?1,1,1,0,${ROLLUP_VERSION})`).bind(today),
      env.DB.prepare("INSERT INTO daily_dimensions (date,dimension,value,pv,uv,cta_visitors) VALUES (?1,'locale','en',5,1,0)").bind(today),
      env.DB.prepare("INSERT INTO daily_dimensions (date,dimension,value,pv,uv,cta_visitors) VALUES (?1,'country','VN',9,1,NULL)").bind(today),
      env.DB.prepare("INSERT INTO daily_dimensions (date,dimension,value,pv,uv,cta_visitors) VALUES (?1,'device','m',9,1,NULL)").bind(today),
      env.DB.prepare("INSERT INTO daily_dimensions (date,dimension,value,pv,uv,cta_visitors) VALUES (?1,'ref_class','direct',9,1,NULL)").bind(today),
    ]);

    const d = await dash(cookie, 1);
    expect(d.overview.traffic).toMatchObject({ pv: 9, uv: 1 });
    expect(d.locales).toEqual({ error: true });
    expect(d.dims).toEqual({ sources: { error: true }, countries: { error: true }, devices: { error: true } });
  });

  it('A1 总览/趋势/漏斗/内容/质量口径精确对账', async () => {
    const cookie = await login();
    await seed();
    const d = await dash(cookie, 7);
    // 总览:两天合计 pv 160 / uv 70;cta 点击 15、访客 12
    expect(d.overview.traffic).toMatchObject({ pv: 160, uv: 70, hasData: true });
    expect(d.overview.downloads).toMatchObject({ ctaClicks: 15 });
    expect(d.overview.conversion).toMatchObject({ ctaVisitors: 12 });
    expect(d.overview.conversion.starRate).toBeCloseTo(12 / 70, 5); // 北极星=点击访客÷UV
    expect(d.overview.downloads.byCta.map((x: any) => x.cta_id).sort()).toEqual(['android', 'ios']);
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
    expect(d1.overview.traffic.pv).toBe(60); // 昨天不计入
    expect(d1.range).toBe(1);
    const res = await app.request('/api/dash?range=999', { headers: { cookie } }, env);
    expect(((await res.json()) as { range: number }).range).toBe(90);
  });

  it('全局日表防跨维度重复:同一访客跨语言和 CTA 时总览、趋势、漏斗只算一次', async () => {
    const cookie = await login();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO daily_traffic (date,locale,country,device,ref_class,pv,uv,sessions) VALUES (?1,'en','VN','m','direct',1,1,1)").bind(today),
      env.DB.prepare("INSERT INTO daily_traffic (date,locale,country,device,ref_class,pv,uv,sessions) VALUES (?1,'vi','US','d','search',1,1,0)").bind(today),
      env.DB.prepare("INSERT INTO daily_cta (date,cta_id,locale,clicks,uniq) VALUES (?1,'ios','en',1,1)").bind(today),
      env.DB.prepare("INSERT INTO daily_cta (date,cta_id,locale,clicks,uniq) VALUES (?1,'android','en',1,1)").bind(today),
      env.DB.prepare(`INSERT INTO daily_visitors (date,uv,sessions,cta_visitors,rollup_version) VALUES (?1,1,1,1,${ROLLUP_VERSION})`).bind(today),
      env.DB.prepare("INSERT INTO daily_dimensions (date,dimension,value,pv,uv,cta_visitors) VALUES (?1,'locale','en',1,1,1)").bind(today),
      env.DB.prepare("INSERT INTO daily_dimensions (date,dimension,value,pv,uv,cta_visitors) VALUES (?1,'locale','vi',1,1,0)").bind(today),
      env.DB.prepare("INSERT INTO daily_dimensions (date,dimension,value,pv,uv,cta_visitors) VALUES (?1,'country','VN',1,1,NULL)").bind(today),
      env.DB.prepare("INSERT INTO daily_dimensions (date,dimension,value,pv,uv,cta_visitors) VALUES (?1,'country','US',1,1,NULL)").bind(today),
      env.DB.prepare("INSERT INTO daily_dimensions (date,dimension,value,pv,uv,cta_visitors) VALUES (?1,'device','m',1,1,NULL)").bind(today),
      env.DB.prepare("INSERT INTO daily_dimensions (date,dimension,value,pv,uv,cta_visitors) VALUES (?1,'device','d',1,1,NULL)").bind(today),
      env.DB.prepare("INSERT INTO daily_dimensions (date,dimension,value,pv,uv,cta_visitors) VALUES (?1,'ref_class','direct',1,1,NULL)").bind(today),
      env.DB.prepare("INSERT INTO daily_dimensions (date,dimension,value,pv,uv,cta_visitors) VALUES (?1,'ref_class','search',1,1,NULL)").bind(today),
    ]);

    const d = await dash(cookie, 1);
    expect(d.overview.traffic).toMatchObject({ pv: 2, uv: 1, sessions: 1 });
    expect(d.overview.downloads).toMatchObject({ ctaClicks: 2 });
    expect(d.overview.conversion).toMatchObject({ ctaVisitors: 1 });
    expect(d.overview.conversion.starRate).toBe(1);
    expect(d.trend).toEqual([{ date: today, pv: 2, uv: 1, cta: 2 }]);
    expect(d.funnel).toMatchObject({ uv: 1, cta: 1 });
    expect(d.locales.find((row: any) => row.locale === 'en')).toMatchObject({ uv: 1, ctaVisitors: 1, rate: 1 });
    expect(d.locales.find((row: any) => row.locale === 'vi')).toMatchObject({ uv: 1, ctaVisitors: 0, rate: 0 });
  });

  it('环比:上一等长周期有数时给出变化率', async () => {
    const cookie = await login();
    // 当期(近 2 天)uv 30;上期(再往前 2 天)uv 15 → deltaUv = +1.0
    await env.DB.batch([
      env.DB.prepare("INSERT INTO daily_traffic (date,locale,country,device,ref_class,pv,uv,sessions) VALUES (?1,'en','US','d','direct',60,30,30)").bind(today),
      env.DB.prepare("INSERT INTO daily_traffic (date,locale,country,device,ref_class,pv,uv,sessions) VALUES (?1,'en','US','d','direct',30,15,15)").bind(dayStr(Date.now() - 3 * DAY)),
      env.DB.prepare(`INSERT INTO daily_visitors (date,uv,sessions,cta_visitors,rollup_version) VALUES (?1,30,30,0,${ROLLUP_VERSION})`).bind(today),
      env.DB.prepare(`INSERT INTO daily_visitors (date,uv,sessions,cta_visitors,rollup_version) VALUES (?1,15,15,0,${ROLLUP_VERSION})`).bind(dayStr(Date.now() - 3 * DAY)),
    ]);
    const d = await dash(cookie, 2);
    expect(d.overview.traffic.deltaUv).toBeCloseTo(1, 5);
  });

  it('E2 今日实时:直查原始事件,Bot 不计入 uv/pv;blocked 独立', async () => {
    const cookie = await login();
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO raw_events (ts,type,uid,payload) VALUES (?1,'pv','1111111111111111',?2)").bind(now, JSON.stringify({ t: 'pv', path: '/', loc: 'en', ref: 'direct', dev: 'm', us: '', um: '', uc: '', country: 'VN', bot: 0 })),
      env.DB.prepare("INSERT INTO raw_events (ts,type,uid,payload) VALUES (?1,'pv','1111111111111111',?2)").bind(now, JSON.stringify({ t: 'pv', path: '/x', loc: 'en', ref: 'direct', dev: 'm', us: '', um: '', uc: '', country: 'VN', bot: 0 })),
      env.DB.prepare("INSERT INTO raw_events (ts,type,uid,payload) VALUES (?1,'pv','2222222222222222',?2)").bind(now, JSON.stringify({ t: 'pv', path: '/', loc: 'en', ref: 'direct', dev: 'm', us: '', um: '', uc: '', country: 'VN', bot: 1 })),
      // 完整合法 CTA 载荷，与采集端及汇总的校验契约一致。
      env.DB.prepare("INSERT INTO raw_events (ts,type,uid,payload) VALUES (?1,'cta','1111111111111111',?2)").bind(now, JSON.stringify(ctaPayload('ios'))),
      env.DB.prepare("INSERT INTO raw_events (ts,type,uid,payload) VALUES (?1,'blocked',NULL,?2)").bind(now, JSON.stringify({ t: 'blocked', c: 'CN', p: 'page', bot: 0 })),
      env.DB.prepare("INSERT INTO raw_events (ts,type,uid,payload) VALUES (?1,'blocked',NULL,?2)").bind(now, JSON.stringify({ t: 'blocked', c: 'CN', p: 'page', bot: 1 })),
      env.DB.prepare("INSERT INTO raw_events (ts,type,uid,payload) VALUES (?1,'blocked',NULL,'{broken-json')").bind(now),
    ]);
    const d = await dash(cookie);
    expect(d.todayLive).toMatchObject({ pv: 2, uv: 1, cta: 1, blocked: 1 }); // bot 那条不计
  });

  it('P1-2 今日实时:点击数与 UV 同样排除爬虫(同卡内口径必须一致)', async () => {
    const cookie = await login();
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO raw_events (ts,type,uid,payload) VALUES (?1,'cta','1111111111111111',?2)").bind(now, JSON.stringify(ctaPayload('ios'))),
      env.DB.prepare("INSERT INTO raw_events (ts,type,uid,payload) VALUES (?1,'cta','2222222222222222',?2)").bind(now, JSON.stringify(ctaPayload('ios', 1))),
      env.DB.prepare("INSERT INTO raw_events (ts,type,uid,payload) VALUES (?1,'cta','3333333333333333',?2)").bind(now, JSON.stringify(ctaPayload('android', 1))),
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
    try {
    const d = await dash(cookie);
    expect(d.content.pages).toEqual({ error: true });
    expect(d.content.faq).not.toEqual({ error: true }); // 另三榜的表是健康的,不该跟着黑
    expect(d.content.learn).not.toEqual({ error: true });
    expect(d.content.sections.find((s: any) => s.section_id === 'download').uniq).toBe(50);
    expect(d.overview.traffic).toEqual({ error: true }); // 页面表也是历史覆盖证据，无法确认时失败关闭
    expect(d.funnel).toEqual({ error: true });
    // 还表:否则后续用例的 beforeEach 清表会炸(测试之间不许互相污染)
    } finally {
    await env.DB.prepare('CREATE TABLE daily_page (date TEXT NOT NULL, path TEXT NOT NULL, locale TEXT NOT NULL, pv INTEGER NOT NULL DEFAULT 0, uv INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (date, path, locale))').run();
    }
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

  it('转化口径只含 ios/android/h5：contact 保留原始 CTA，但不污染下载点击、趋势与北极星', async () => {
    const cookie = await login();
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO daily_visitors (date,uv,sessions,cta_visitors,rollup_version) VALUES (?1,1,1,1,${ROLLUP_VERSION})`).bind(today),
      env.DB.prepare("INSERT INTO daily_cta (date,cta_id,locale,clicks,uniq) VALUES (?1,'ios','en',1,1)").bind(today),
      env.DB.prepare("INSERT INTO daily_cta (date,cta_id,locale,clicks,uniq) VALUES (?1,'contact','en',4,1)").bind(today),
    ]);

    const d = await dash(cookie, 1);
    expect(d.overview.downloads.ctaClicks).toBe(1);
    expect(d.overview.downloads.byCta).toEqual([{ cta_id: 'ios', clicks: 1 }]);
    expect(d.overview.conversion.starRate).toBe(1);
    expect(d.trend).toEqual([{ date: today, pv: 0, uv: 1, cta: 1 }]);
  });

  it('只有 FAQ 等非 PV/CTA 真人历史聚合时，唯一访客覆盖必须 fail closed，不能显示真实零', async () => {
    const cookie = await login();
    await env.DB.prepare("INSERT INTO daily_faq (date,faq_id,opens) VALUES (?1,'q1',1)").bind(today).run();

    const d = await dash(cookie, 1);
    expect(d.overview.traffic).toEqual({ error: true });
    expect(d.overview.conversion).toEqual({ error: true });
    expect(d.trend).toEqual({ error: true });
    expect(d.funnel).toEqual({ error: true });
  });

  it('CTA-only 今日实时按所有合法真人 beacon 计算 UV，且排除 contact、bot 与坏 shape', async () => {
    const cookie = await login();
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO raw_events (ts,type,uid,payload) VALUES (?1,'cta','1111111111111111',?2)").bind(now, JSON.stringify(ctaPayload('ios'))),
      env.DB.prepare("INSERT INTO raw_events (ts,type,uid,payload) VALUES (?1,'cta','1111111111111111',?2)").bind(now + 1, JSON.stringify(ctaPayload('contact'))),
      env.DB.prepare("INSERT INTO raw_events (ts,type,uid,payload) VALUES (?1,'cta','2222222222222222',?2)").bind(now + 2, JSON.stringify(ctaPayload('android', 1))),
      env.DB.prepare("INSERT INTO raw_events (ts,type,uid,payload) VALUES (?1,'cta','3333333333333333',?2)").bind(now + 3, JSON.stringify({ ...ctaPayload('h5'), path: true })),
      env.DB.prepare("INSERT INTO raw_events (ts,type,uid,payload) VALUES (?1,'cta','not-valid-uid!!!',?2)").bind(now + 4, JSON.stringify(ctaPayload('h5'))),
    ]);

    const d = await dash(cookie, 1);
    expect(d.todayLive).toEqual({ pv: 0, uv: 1, cta: 1, blocked: 0 });
  });

  it('daily_visitors 在数据库层拒绝 cta_visitors 大于 uv', async () => {
    await expect(env.DB.prepare(
      `INSERT INTO daily_visitors (date,uv,sessions,cta_visitors,rollup_version) VALUES (?1,1,1,2,${ROLLUP_VERSION})`,
    ).bind(today).run()).rejects.toThrow(/constraint|check|cta_visitors/i);
  });

  it('404 总数独立全量 SUM，列表保持 Top 10', async () => {
    const cookie = await login();
    await env.DB.batch(Array.from({ length: 11 }, (_, index) =>
      env.DB.prepare('INSERT INTO daily_notfound (date,path,hits) VALUES (?1,?2,1)').bind(today, `/missing-${index}`),
    ));

    const d = await dash(cookie, 1);
    expect(d.quality.notFound).toHaveLength(10);
    expect(d.quality.notFoundTotal).toBe(11);
  });

  it('coverage 查询故障只关闭依赖唯一汇总的卡，下载、今日实时与其他独立卡继续返回', async () => {
    const cookie = await login();
    const faultyDb = new Proxy(env.DB, {
      get(target, property, receiver) {
        if (property === 'prepare') {
          return (sql: string) => {
            if (sql.includes('SELECT DISTINCT date FROM daily_traffic')) throw new Error('injected coverage failure');
            return target.prepare(sql);
          };
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const bindings = { ...env, DB: faultyDb };
    const res = await app.request('/api/dash?range=1', { headers: { cookie } }, bindings);

    expect(res.status).toBe(200);
    const d = await res.json() as Record<string, any>;
    expect(d.overview.traffic).toEqual({ error: true });
    expect(d.overview.conversion).toEqual({ error: true });
    expect(d.overview.downloads).not.toEqual({ error: true });
    expect(d.todayLive).not.toEqual({ error: true });
    expect(d.content.pages).not.toEqual({ error: true });
    expect(d.quality).not.toEqual({ error: true });
  });
});

const pvForCoverage = { t: 'pv', path: '/learn/example', loc: 'vi', dev: 'm', ref: 'direct', us: '', um: '', uc: '', country: 'VN', bot: 0 };
it.each([
  ['daily_vitals', 'device', { t: 'vit', path: '/', lcp: 100, cls: 0, dev: 'm', country: 'VN', bot: 0 }],
  ['daily_faq', 'locale', { t: 'faq', faq: 'q1', loc: 'vi', country: 'VN', bot: 0 }],
  ['daily_section', 'country', { t: 'sec', sec: 'download', path: '/', country: 'VN', bot: 0 }],
  ['daily_errors', 'country', { t: 'err', h: 'boom', path: '/', country: 'VN', bot: 0 }],
  ['daily_page', 'locale', pvForCoverage], ['daily_page', 'device', pvForCoverage], ['daily_page', 'ref_class', pvForCoverage],
  ['daily_learn', 'locale', pvForCoverage], ['daily_learn', 'device', pvForCoverage], ['daily_learn', 'ref_class', pvForCoverage],
  ['daily_bot', 'locale', pvForCoverage], ['daily_bot', 'device', pvForCoverage], ['daily_bot', 'ref_class', pvForCoverage],
  ['daily_vitals', 'country', { t: 'vit', path: '/', lcp: 100, cls: 0, dev: 'm', country: 'VN', bot: 0 }],
] as const)('%s retains evidence requiring %s even without traffic rows', async (table, dimension, payload) => {
  const cookie = await login();
  await env.DB.prepare('INSERT INTO raw_events (ts,type,uid,payload) VALUES (?1,?2,?3,?4)')
    .bind(Date.now(), payload.t, '1111111111111111', JSON.stringify(payload)).run();
  await runDailyRollup(env.DB, today);
  for (const other of ['daily_traffic', 'daily_cta', 'daily_section', 'daily_faq', 'daily_vitals', 'daily_errors', 'daily_page', 'daily_learn', 'daily_bot']) {
    if (other !== table) await env.DB.prepare('DELETE FROM ' + other).run();
  }
  const before = await dash(cookie, 1);
  expect(before.overview.traffic).toMatchObject({ uv: 1 });
  expect(before.dims.devices).not.toEqual({ error: true });
  expect(before.locales).not.toEqual({ error: true });
  await env.DB.prepare('DELETE FROM daily_dimensions WHERE dimension = ?1').bind(dimension).run();
  const after = await dash(cookie, 1);
  expect(after.overview.traffic).toMatchObject({ uv: 1 });
  expect(after.dims.devices).toEqual({ error: true });
  expect(after.locales).toEqual({ error: true });
});
