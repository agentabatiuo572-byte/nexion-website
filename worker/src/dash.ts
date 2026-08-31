import { Hono } from 'hono';
import type { Env } from './env';
import { loadRules } from './geo';

/* 驾驶舱聚合(PRD CON03)。口径全部照 ③ 字典,不在此处新造定义:
   · 北极星转化率 = 当期 cta 点击「访客数」÷ 当期 UV(不是点击数÷UV)
   · 滚达率 = 触发对应 sec 事件的访客数 ÷ UV
   · Bot 只入占比,不进流量;blocked 独立分桶;直通访问不计
   · 今日为实时预览(直查原始事件),口径以次日汇总为准 —— 前端必须标注(E2)
   🔴 缺数据就是缺数据:一律回 null / 空数组,由前端显示「—」或空态,禁插值禁估算。
   单卡失败互不拖垮:每组独立 try,失败该组回 { error: true }(E3 的卡内重试语义)。 */

const DAY_MS = 86_400_000;
const dayStr = (t: number) => new Date(t).toISOString().slice(0, 10);

/** 分组独立执行:任一组抛错只影响它自己 */
async function section<T>(fn: () => Promise<T>): Promise<T | { error: true }> {
  try {
    return await fn();
  } catch {
    return { error: true };
  }
}

export const dashRoutes = new Hono<{ Bindings: Env }>();

dashRoutes.get('/', async (c) => {
  const days = Math.min(Math.max(Number(c.req.query('range') ?? 7) || 7, 1), 90);
  const now = Date.now();
  const today = dayStr(now);
  const from = dayStr(now - (days - 1) * DAY_MS);
  const prevFrom = dayStr(now - (2 * days - 1) * DAY_MS);
  const prevTo = dayStr(now - days * DAY_MS);
  const db = c.env.DB;

  // ---- 总览 + 环比(上一个等长周期)----
  const overview = await section(async () => {
    const sum = async (a: string, b: string) =>
      (await db
        .prepare('SELECT COALESCE(SUM(pv),0) pv, COALESCE(SUM(uv),0) uv, COALESCE(SUM(sessions),0) sessions FROM daily_traffic WHERE date BETWEEN ?1 AND ?2')
        .bind(a, b)
        .first<{ pv: number; uv: number; sessions: number }>())!;
    const cta = async (a: string, b: string) =>
      (await db
        .prepare('SELECT COALESCE(SUM(clicks),0) clicks, COALESCE(SUM(uniq),0) uniq FROM daily_cta WHERE date BETWEEN ?1 AND ?2')
        .bind(a, b)
        .first<{ clicks: number; uniq: number }>())!;
    const [cur, prev, curCta, prevCta] = await Promise.all([sum(from, today), sum(prevFrom, prevTo), cta(from, today), cta(prevFrom, prevTo)]);
    const byCta = (
      await db
        .prepare('SELECT cta_id, COALESCE(SUM(clicks),0) clicks FROM daily_cta WHERE date BETWEEN ?1 AND ?2 GROUP BY cta_id ORDER BY clicks DESC')
        .bind(from, today)
        .all<{ cta_id: string; clicks: number }>()
    ).results;
    /* 🔴 转化率口径:uniq 是「按 (日, cta, 语言) 去重的访客数」之和,跨日/跨键会重复计人,
       因此它是**上界**而非精确唯一访客;当期 UV 同理是各日 uv 之和(跨日重复计)。
       两者同为「按日相加」的口径,比值在同口径下可比,但不等于「唯一访客转化率」——
       面板必须标注口径,不做假精确(数字可信不自曝)。 */
    const rate = cur.uv > 0 ? curCta.uniq / cur.uv : null;
    const prevRate = prev.uv > 0 ? prevCta.uniq / prev.uv : null;
    return {
      pv: cur.pv, uv: cur.uv, sessions: cur.sessions,
      ctaClicks: curCta.clicks, ctaVisitors: curCta.uniq, byCta,
      starRate: rate, starRatePrev: prevRate,
      deltaUv: prev.uv > 0 ? (cur.uv - prev.uv) / prev.uv : null,
      deltaCta: prevCta.clicks > 0 ? (curCta.clicks - prevCta.clicks) / prevCta.clicks : null,
      hasData: cur.pv > 0 || cur.uv > 0,
    };
  });

  // ---- 趋势(按日)----
  const trend = await section(async () => {
    const t = (
      await db
        .prepare('SELECT date, COALESCE(SUM(pv),0) pv, COALESCE(SUM(uv),0) uv FROM daily_traffic WHERE date BETWEEN ?1 AND ?2 GROUP BY date ORDER BY date')
        .bind(from, today)
        .all<{ date: string; pv: number; uv: number }>()
    ).results;
    const cta = (
      await db
        .prepare('SELECT date, COALESCE(SUM(clicks),0) clicks FROM daily_cta WHERE date BETWEEN ?1 AND ?2 GROUP BY date')
        .bind(from, today)
        .all<{ date: string; clicks: number }>()
    ).results;
    const cm = new Map(cta.map((r) => [r.date, r.clicks]));
    return t.map((r) => ({ ...r, cta: cm.get(r.date) ?? 0 }));
  });

  // ---- 漏斗:访客 → 滚达下载区 → 滚达信任区 → CTA 点击 ----
  const funnel = await section(async () => {
    const uv = (await db.prepare('SELECT COALESCE(SUM(uv),0) uv FROM daily_traffic WHERE date BETWEEN ?1 AND ?2').bind(from, today).first<{ uv: number }>())!.uv;
    const secOf = async (id: string) =>
      (await db.prepare('SELECT COALESCE(SUM(uniq),0) n FROM daily_section WHERE date BETWEEN ?1 AND ?2 AND section_id = ?3').bind(from, today, id).first<{ n: number }>())!.n;
    const [download, trust] = await Promise.all([secOf('download'), secOf('trust')]);
    const ctaUniq = (await db.prepare('SELECT COALESCE(SUM(uniq),0) n FROM daily_cta WHERE date BETWEEN ?1 AND ?2').bind(from, today).first<{ n: number }>())!.n;
    return { uv, download, trust, cta: ctaUniq };
  });

  // ---- 分语言:占比 + 各自转化率(越南市场运营关键)----
  const locales = await section(async () => {
    const t = (
      await db
        .prepare('SELECT locale, COALESCE(SUM(uv),0) uv, COALESCE(SUM(pv),0) pv FROM daily_traffic WHERE date BETWEEN ?1 AND ?2 GROUP BY locale')
        .bind(from, today)
        .all<{ locale: string; uv: number; pv: number }>()
    ).results;
    const cta = (
      await db
        .prepare('SELECT locale, COALESCE(SUM(uniq),0) uniq FROM daily_cta WHERE date BETWEEN ?1 AND ?2 GROUP BY locale')
        .bind(from, today)
        .all<{ locale: string; uniq: number }>()
    ).results;
    const cm = new Map(cta.map((r) => [r.locale, r.uniq]));
    const total = t.reduce((s, r) => s + r.uv, 0);
    return t
      .map((r) => ({ locale: r.locale, uv: r.uv, pv: r.pv, share: total ? r.uv / total : 0, rate: r.uv ? (cm.get(r.locale) ?? 0) / r.uv : null }))
      .sort((a, b) => b.uv - a.uv);
  });

  // ---- 来源 / 国家 / 设备 ----
  const dims = await section(async () => {
    const group = async (col: string) =>
      (
        await db
          .prepare(`SELECT ${col} AS k, COALESCE(SUM(uv),0) uv, COALESCE(SUM(pv),0) pv FROM daily_traffic WHERE date BETWEEN ?1 AND ?2 GROUP BY ${col} ORDER BY uv DESC LIMIT 20`)
          .bind(from, today)
          .all<{ k: string; uv: number; pv: number }>()
      ).results;
    const [sources, countries, devices] = await Promise.all([group('ref_class'), group('country'), group('device')]);
    return { sources, countries, devices };
  });

  // ---- 内容榜:页面 / FAQ / learn / 板块曝光 ----
  const content = await section(async () => {
    const pages = (
      await db
        .prepare('SELECT path, locale, COALESCE(SUM(pv),0) pv, COALESCE(SUM(uv),0) uv FROM daily_page WHERE date BETWEEN ?1 AND ?2 GROUP BY path, locale ORDER BY pv DESC LIMIT 15')
        .bind(from, today)
        .all<{ path: string; locale: string; pv: number; uv: number }>()
    ).results;
    const faq = (
      await db.prepare('SELECT faq_id, COALESCE(SUM(opens),0) opens FROM daily_faq WHERE date BETWEEN ?1 AND ?2 GROUP BY faq_id ORDER BY opens DESC LIMIT 15').bind(from, today).all<{ faq_id: string; opens: number }>()
    ).results;
    const learn = (
      await db.prepare('SELECT slug, COALESCE(SUM(reads),0) reads FROM daily_learn WHERE date BETWEEN ?1 AND ?2 GROUP BY slug ORDER BY reads DESC LIMIT 15').bind(from, today).all<{ slug: string; reads: number }>()
    ).results;
    const sections = (
      await db.prepare('SELECT section_id, COALESCE(SUM(uniq),0) uniq FROM daily_section WHERE date BETWEEN ?1 AND ?2 GROUP BY section_id ORDER BY uniq DESC').bind(from, today).all<{ section_id: string; uniq: number }>()
    ).results;
    return { pages, faq, learn, sections };
  });

  // ---- 质量:LCP/CLS p75(按天取样本加权近似)+ JS 错误 + 404 ----
  const quality = await section(async () => {
    const v = (
      await db.prepare('SELECT date, lcp_p75, cls_p75, n FROM daily_vitals WHERE date BETWEEN ?1 AND ?2 ORDER BY date DESC').bind(from, today).all<{ date: string; lcp_p75: number; cls_p75: number; n: number }>()
    ).results;
    // 🔴 p75 不能跨天再求平均得到真 p75;取「最近一天的 p75」为展示值,并回样本量供前端标注口径
    const latest = v[0] ?? null;
    const errs = (
      await db.prepare('SELECT COALESCE(SUM(count),0) n FROM daily_errors WHERE date BETWEEN ?1 AND ?2').bind(from, today).first<{ n: number }>()
    )!.n;
    const nf = (
      await db.prepare('SELECT path, COALESCE(SUM(hits),0) hits FROM daily_notfound WHERE date BETWEEN ?1 AND ?2 GROUP BY path ORDER BY hits DESC LIMIT 10').bind(from, today).all<{ path: string; hits: number }>()
    ).results;
    return { latest, errors: errs, notFound: nf, notFoundTotal: nf.reduce((s, r) => s + r.hits, 0) };
  });

  // ---- 运营健康:Bot 占比 + 屏蔽 + 下载探活状态(探活由前端按需触发,这里给规则/统计)----
  const health = await section(async () => {
    /* 🔴 Bot 占比按**请求加权**算(验收 P1-3:此前 AVG(bot_share) 是各日占比的无权重平均,
       实测与真实占比差近 2 倍还印成精确小数)。0004 迁移前的旧行没有分子分母 → 该期间回 null,
       前端显「—」并标注「口径升级前的历史区间无法回算」,不拿旧口径的数冒充。 */
    const botRow = await db
      .prepare('SELECT COALESCE(SUM(bot_pv),0) b, COALESCE(SUM(human_pv),0) h, COUNT(*) n FROM daily_bot WHERE date BETWEEN ?1 AND ?2')
      .bind(from, today)
      .first<{ b: number; h: number; n: number }>();
    const denom = (botRow?.b ?? 0) + (botRow?.h ?? 0);
    const bot = denom > 0 ? botRow!.b / denom : null;
    const botLegacy = (botRow?.n ?? 0) > 0 && denom === 0; // 有行但没分母 = 旧口径数据
    const blocked = (await db.prepare('SELECT COALESCE(SUM(hits),0) n FROM daily_blocked WHERE date BETWEEN ?1 AND ?2').bind(from, today).first<{ n: number }>())!.n;
    const blockedTop = (
      await db.prepare('SELECT country, COALESCE(SUM(hits),0) hits FROM daily_blocked WHERE date BETWEEN ?1 AND ?2 GROUP BY country ORDER BY hits DESC LIMIT 5').bind(from, today).all<{ country: string; hits: number }>()
    ).results;
    const geo = await loadRules(c.env).catch(() => null);
    // 「最近发布」要排除初始种子行(created_by=system):把种子说成一次发布会误导(验收 P2)
    const lastPublish = await db
      .prepare("SELECT id, status, published_at, fail_reason FROM config_versions WHERE created_by <> 'system' ORDER BY id DESC LIMIT 1")
      .first<{ id: number; status: string; published_at: number | null; fail_reason: string | null }>();
    // 下载链接定时探活状态(P1-1):连续失败 ≥2 次即红条(CON03-E3)
    const probes = (
      await db.prepare('SELECT target, url, ok, status, fail_streak, checked_at FROM probe_status').all<{ target: string; url: string; ok: number; status: number; fail_streak: number; checked_at: number }>()
    ).results;
    // 被屏蔽占比(P2:面板缺占比):口径同 geo 面板 = 拦截数 ÷(拦截 + 人类 pv)
    const pvForShare = (await db.prepare('SELECT COALESCE(SUM(pv),0) pv FROM daily_traffic WHERE date BETWEEN ?1 AND ?2').bind(from, today).first<{ pv: number }>())!.pv;
    return {
      botShare: bot, botLegacy, blocked, blockedTop,
      blockedShare: blocked + pvForShare > 0 ? blocked / (blocked + pvForShare) : null,
      geo: geo ? { enabled: geo.rules.enabled, countries: geo.rules.countries.length, degraded: geo.degraded } : null,
      lastPublish,
      probes: probes.map((p) => ({ ...p, ok: p.ok === 1, alert: p.ok !== 1 && p.fail_streak >= 2 })),
    };
  });

  // ---- 今日实时预览(E2:直查原始事件,标注口径以次日汇总为准)----
  const todayLive = await section(async () => {
    const t0 = Date.parse(`${today}T00:00:00.000Z`);
    const row = (await db
      .prepare("SELECT COUNT(*) pv, COUNT(DISTINCT uid) uv FROM raw_events WHERE type='pv' AND ts >= ?1 AND IFNULL(json_extract(payload,'$.bot'),0) = 0")
      .bind(t0)
      .first<{ pv: number; uv: number }>())!;
    // 🔴 cta 同样要排 bot(验收 P1-2:此前只有 pv 过滤,同一张卡内 UV 排 bot、点击不排,
    //    与日汇总口径(rollup 对 cta 明确 if(isBot) break)也不一致 → 爬虫刷一波今天暴涨明天掉回)
    const cta = (await db
      .prepare("SELECT COUNT(*) n FROM raw_events WHERE type='cta' AND ts >= ?1 AND IFNULL(json_extract(payload,'$.bot'),0) = 0")
      .bind(t0)
      .first<{ n: number }>())!.n;
    const blocked = (await db.prepare("SELECT COUNT(*) n FROM raw_events WHERE type='blocked' AND ts >= ?1").bind(t0).first<{ n: number }>())!.n;
    return { ...row, cta, blocked };
  });

  return c.json({ range: days, from, to: today, overview, trend, funnel, locales, dims, content, quality, health, todayLive });
});
