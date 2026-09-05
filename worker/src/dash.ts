import { Hono } from 'hono';
import { METRIC_CONVERSION_CTA_IDS } from '../../schema/src/event-contract';
import type { Env } from './env';
import { loadRules } from './geo';
import {
  ROLLUP_VERSION,
  VALID_HUMAN_BEACON_EVENT_SQL,
  VALID_HUMAN_BLOCKED_EVENT_SQL,
} from './rollup';

/* 驾驶舱聚合(PRD CON03)。口径全部照 ③ 字典,不在此处新造定义:
   · 北极星转化率 = 当期 cta 点击「访客数」÷ 当期 UV(不是点击数÷UV)
   · 滚达率 = 触发对应 sec 事件的访客数 ÷ UV
   · Bot 只入占比,不进流量;blocked 独立分桶;直通访问不计
   · 今日为实时预览(直查原始事件),口径以次日汇总为准 —— 前端必须标注(E2)
   🔴 缺数据就是缺数据:一律回 null / 空数组,由前端显示「—」或空态,禁插值禁估算。
   单卡失败互不拖垮:每组独立 try,失败该组回 { error: true }(E3 的卡内重试语义)。 */

const DAY_MS = 86_400_000;
const dayStr = (t: number) => new Date(t).toISOString().slice(0, 10);
const sqlText = (value: string) => `'${value.replaceAll("'", "''")}'`;
const CONVERSION_CTA_SQL = METRIC_CONVERSION_CTA_IDS.map(sqlText).join(', ');

interface SectionError { error: true }
type Maybe<T> = T | SectionError;

interface UniqueCoverage {
  hasData: boolean;
  global: boolean;
  dimensions: boolean;
}

/** A new table can exist while old aggregate dates are still absent from it; absence must not become a displayed zero. */
async function uniqueCoverage(db: D1Database, from: string, to: string): Promise<UniqueCoverage> {
  const activityTables = ['daily_traffic', 'daily_cta', 'daily_section', 'daily_faq', 'daily_vitals', 'daily_errors', 'daily_page', 'daily_learn', 'daily_bot'] as const;
  // D1 limits compound SELECT terms; each nested group has at most five.
  const dateQueries = activityTables.map((table) => 'SELECT DISTINCT date FROM ' + table + ' WHERE date BETWEEN ?1 AND ?2' + (table === 'daily_bot' ? ' AND human_pv > 0' : ''));
  const activitySql = 'SELECT date FROM (' + dateQueries.slice(0, 5).join(' UNION ') + ') UNION SELECT date FROM (' + dateQueries.slice(5).join(' UNION ') + ')';
  const dates = await db.prepare(activitySql).bind(from, to).all<{ date: string }>();
  const requiredDates = new Set(dates.results.map((row) => row.date));
  const activityDates = requiredDates.size;

  let visitorDates = 0;
  try {
    visitorDates = (await db.prepare('SELECT COUNT(*) AS n FROM daily_visitors WHERE date BETWEEN ?1 AND ?2')
      .bind(from, to).first<{ n: number }>())?.n ?? 0;
  } catch {
    return activityDates === 0
      ? { hasData: false, global: true, dimensions: true }
      : { hasData: true, global: false, dimensions: false };
  }

  if (activityDates === 0 && visitorDates === 0) return { hasData: false, global: true, dimensions: true };

  try {
    const visitors = await db.prepare('SELECT date, rollup_version FROM daily_visitors WHERE date BETWEEN ?1 AND ?2')
      .bind(from, to).all<{ date: string; rollup_version: number }>();
    const coveredDates = new Set(visitors.results.filter((row) => row.rollup_version === ROLLUP_VERSION).map((row) => row.date));
    if (visitors.results.some((row) => row.rollup_version !== ROLLUP_VERSION) || [...requiredDates].some((date) => !coveredDates.has(date))) {
      return { hasData: true, global: false, dimensions: false };
    }
  } catch {
    return { hasData: true, global: false, dimensions: false };
  }

  // Every human beacon supplies country; FAQ also supplies locale and vit supplies device.
  // Page/learn/human-bot summaries prove PV existed, so all PV dimensions must exist.
  // Recover exact values only where aggregates retain them (traffic and page locale).
  try {
    const missing = await db.prepare(`
      WITH traffic_required AS (
        SELECT DISTINCT traffic.date, fields.key AS dimension, CAST(fields.value AS TEXT) AS value
        FROM daily_traffic AS traffic,
             json_each(json_object(
               'locale', traffic.locale,
               'country', traffic.country,
               'device', traffic.device,
               'ref_class', traffic.ref_class
             )) AS fields
        WHERE traffic.date BETWEEN ?1 AND ?2
      ), required_values AS (
        SELECT date, dimension, value FROM traffic_required
        UNION
        SELECT cta.date, 'locale', cta.locale
        FROM daily_cta AS cta
        WHERE cta.date BETWEEN ?1 AND ?2
        UNION
        SELECT date, 'locale', locale FROM daily_page WHERE date BETWEEN ?1 AND ?2
      ), required_kinds AS (
        SELECT date, 'country' AS dimension FROM daily_visitors WHERE date BETWEEN ?1 AND ?2 AND uv > 0
        UNION
        SELECT date, 'locale' FROM daily_faq WHERE date BETWEEN ?1 AND ?2
        UNION
        SELECT date, 'device' FROM daily_vitals WHERE date BETWEEN ?1 AND ?2
        UNION
        SELECT date, fields.value FROM (
          SELECT date FROM daily_page WHERE date BETWEEN ?1 AND ?2
          UNION SELECT date FROM daily_learn WHERE date BETWEEN ?1 AND ?2
          UNION SELECT date FROM daily_bot WHERE date BETWEEN ?1 AND ?2 AND human_pv > 0
        ), json_each('["locale","device","ref_class"]') AS fields
      ), missing_required AS (
        SELECT required.date, required.dimension, required.value
        FROM required_values AS required
        LEFT JOIN daily_dimensions AS dimensions
          ON dimensions.date = required.date
         AND dimensions.dimension = required.dimension
         AND dimensions.value = required.value
        WHERE dimensions.date IS NULL
      ), missing_kinds AS (
        SELECT required.date, required.dimension FROM required_kinds AS required
        WHERE NOT EXISTS (
          SELECT 1 FROM daily_dimensions AS dimensions
          WHERE dimensions.date = required.date AND dimensions.dimension = required.dimension
        )
      ), missing_all AS (
        SELECT visitors.date
        FROM daily_visitors AS visitors
        WHERE visitors.date BETWEEN ?1 AND ?2
          AND NOT EXISTS (SELECT 1 FROM daily_dimensions AS dimensions WHERE dimensions.date = visitors.date)
      )
      SELECT (SELECT COUNT(*) FROM missing_required)
           + (SELECT COUNT(*) FROM missing_kinds)
           + (SELECT COUNT(*) FROM missing_all) AS n
    `).bind(from, to).first<{ n: number }>();
    return { hasData: true, global: true, dimensions: (missing?.n ?? 0) === 0 };
  } catch {
    return { hasData: true, global: true, dimensions: false };
  }
}

function requireCoverage(coverage: Maybe<UniqueCoverage>, field: 'global' | 'dimensions'): UniqueCoverage {
  if ('error' in coverage || !coverage[field]) throw new Error('analytics summary unavailable');
  return coverage;
}

/** 分组独立执行:任一组抛错只影响它自己 */
async function section<T>(fn: () => Promise<T>): Promise<Maybe<T>> {
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
  const [currentCoverage, previousCoverage] = await Promise.all([
    section(() => uniqueCoverage(db, from, today)),
    section(() => uniqueCoverage(db, prevFrom, prevTo)),
  ]);

  const trafficTotals = async (a: string, b: string, coverage: UniqueCoverage) => {
    if (!coverage.hasData) return { pv: 0, uv: 0, sessions: 0 };
    const [traffic, visitors] = await Promise.all([
      db.prepare('SELECT COALESCE(SUM(pv),0) pv FROM daily_traffic WHERE date BETWEEN ?1 AND ?2')
        .bind(a, b).first<{ pv: number }>(),
      db.prepare('SELECT COALESCE(SUM(uv),0) uv, COALESCE(SUM(sessions),0) sessions FROM daily_visitors WHERE date BETWEEN ?1 AND ?2')
        .bind(a, b).first<{ uv: number; sessions: number }>(),
    ]);
    return { pv: traffic?.pv ?? 0, uv: visitors?.uv ?? 0, sessions: visitors?.sessions ?? 0 };
  };
  const conversionTotals = async (a: string, b: string, coverage: UniqueCoverage) => {
    if (!coverage.hasData) return { uv: 0, ctaVisitors: 0 };
    const row = await db.prepare(`
      SELECT COALESCE(SUM(uv),0) uv, COALESCE(SUM(cta_visitors),0) ctaVisitors,
             COALESCE(SUM(CASE WHEN uv < 0 OR cta_visitors < 0 OR cta_visitors > uv THEN 1 ELSE 0 END),0) invalidRows
      FROM daily_visitors WHERE date BETWEEN ?1 AND ?2
    `).bind(a, b).first<{ uv: number; ctaVisitors: number; invalidRows: number }>();
    const uv = row?.uv ?? 0;
    const ctaVisitors = row?.ctaVisitors ?? 0;
    if ((row?.invalidRows ?? 0) > 0 || ctaVisitors > uv) throw new Error('invalid conversion summary');
    return { uv, ctaVisitors };
  };
  const clickTotals = async (a: string, b: string) => (
    await db.prepare(`
      SELECT COALESCE(SUM(clicks),0) clicks FROM daily_cta
      WHERE date BETWEEN ?1 AND ?2 AND cta_id IN (${CONVERSION_CTA_SQL})
    `).bind(a, b).first<{ clicks: number }>()
  )?.clicks ?? 0;

  // ---- 总览三卡:流量、下载、转化各自失败 ----
  const [traffic, downloads, conversion] = await Promise.all([
    section(async () => {
      const current = requireCoverage(currentCoverage, 'global');
      const previous = requireCoverage(previousCoverage, 'global');
      const [cur, prev] = await Promise.all([
        trafficTotals(from, today, current),
        trafficTotals(prevFrom, prevTo, previous),
      ]);
      return {
        ...cur,
        deltaUv: prev.uv > 0 ? (cur.uv - prev.uv) / prev.uv : null,
        hasData: current.hasData,
      };
    }),
    section(async () => {
      const [cur, prev, byCta] = await Promise.all([
        clickTotals(from, today),
        clickTotals(prevFrom, prevTo),
        db.prepare(`
          SELECT cta_id, COALESCE(SUM(clicks),0) clicks FROM daily_cta
          WHERE date BETWEEN ?1 AND ?2 AND cta_id IN (${CONVERSION_CTA_SQL})
          GROUP BY cta_id ORDER BY clicks DESC
        `).bind(from, today).all<{ cta_id: string; clicks: number }>(),
      ]);
      return {
        ctaClicks: cur,
        byCta: byCta.results,
        deltaCta: prev > 0 ? (cur - prev) / prev : null,
      };
    }),
    section(async () => {
      const current = requireCoverage(currentCoverage, 'global');
      const previous = requireCoverage(previousCoverage, 'global');
      const [cur, prev] = await Promise.all([
        conversionTotals(from, today, current),
        conversionTotals(prevFrom, prevTo, previous),
      ]);
      return {
        ctaVisitors: cur.ctaVisitors,
        starRate: cur.uv > 0 ? cur.ctaVisitors / cur.uv : null,
        starRatePrev: prev.uv > 0 ? prev.ctaVisitors / prev.uv : null,
      };
    }),
  ]);
  const overview = { traffic, downloads, conversion };

  // ---- 趋势(按日)----
  const trend = await section(async () => {
    const coverage = requireCoverage(currentCoverage, 'global');
    if (!coverage.hasData) return [];
    const t = (
      await db
        .prepare(`WITH traffic AS (
          SELECT date, COALESCE(SUM(pv),0) pv
          FROM daily_traffic WHERE date BETWEEN ?1 AND ?2 GROUP BY date
        ), dates AS (
          SELECT date FROM traffic
          UNION
          SELECT date FROM daily_visitors WHERE date BETWEEN ?1 AND ?2
        )
        SELECT dates.date, COALESCE(traffic.pv,0) pv, COALESCE(visitors.uv,0) uv
        FROM dates
        LEFT JOIN traffic ON traffic.date = dates.date
        LEFT JOIN daily_visitors AS visitors ON visitors.date = dates.date
        ORDER BY dates.date`)
        .bind(from, today)
        .all<{ date: string; pv: number; uv: number }>()
    ).results;
    const cta = (
      await db
        .prepare(`SELECT date, COALESCE(SUM(clicks),0) clicks FROM daily_cta
          WHERE date BETWEEN ?1 AND ?2 AND cta_id IN (${CONVERSION_CTA_SQL}) GROUP BY date`)
        .bind(from, today)
        .all<{ date: string; clicks: number }>()
    ).results;
    const cm = new Map(cta.map((r) => [r.date, r.clicks]));
    return t.map((r) => ({ ...r, cta: cm.get(r.date) ?? 0 }));
  });

  // ---- 漏斗:访客 → 滚达下载区 → 滚达信任区 → CTA 点击 ----
  const funnel = await section(async () => {
    const coverage = requireCoverage(currentCoverage, 'global');
    if (!coverage.hasData) return { uv: 0, download: 0, trust: 0, cta: 0 };
    const totals = await conversionTotals(from, today, coverage);
    const secOf = async (id: string) =>
      (await db.prepare('SELECT COALESCE(SUM(uniq),0) n FROM daily_section WHERE date BETWEEN ?1 AND ?2 AND section_id = ?3').bind(from, today, id).first<{ n: number }>())!.n;
    const [download, trust] = await Promise.all([secOf('download'), secOf('trust')]);
    return { uv: totals.uv, download, trust, cta: totals.ctaVisitors };
  });

  // ---- 分语言:占比 + 各自转化率(越南市场运营关键)----
  const locales = await section(async () => {
    const coverage = requireCoverage(currentCoverage, 'dimensions');
    if (!coverage.hasData) return [];
    const t = (await db.prepare(`
      SELECT value AS locale, COALESCE(SUM(uv),0) uv, COALESCE(SUM(pv),0) pv,
             COALESCE(SUM(cta_visitors),0) ctaVisitors
      FROM daily_dimensions
      WHERE date BETWEEN ?1 AND ?2 AND dimension = 'locale'
      GROUP BY value
    `).bind(from, today).all<{ locale: string; uv: number; pv: number; ctaVisitors: number }>()).results;
    if (t.some((row) => row.ctaVisitors < 0 || row.ctaVisitors > row.uv)) {
      throw new Error('invalid locale conversion summary');
    }
    const total = t.reduce((s, r) => s + r.uv, 0);
    return t
      .map((r) => ({ ...r, share: total ? r.uv / total : 0, rate: r.uv ? r.ctaVisitors / r.uv : null }))
      .sort((a, b) => b.uv - a.uv);
  });

  // ---- 来源 / 国家 / 设备 ----
  const dimension = (kind: 'ref_class' | 'country' | 'device') => section(async () => {
    const coverage = requireCoverage(currentCoverage, 'dimensions');
    if (!coverage.hasData) return [];
    return (await db.prepare(`
      SELECT value AS k, COALESCE(SUM(uv),0) uv, COALESCE(SUM(pv),0) pv
      FROM daily_dimensions WHERE date BETWEEN ?1 AND ?2 AND dimension = ?3
      GROUP BY value ORDER BY uv DESC LIMIT 20
    `).bind(from, today, kind).all<{ k: string; uv: number; pv: number }>()).results;
  });
  const [sources, countries, devices] = await Promise.all([
    dimension('ref_class'), dimension('country'), dimension('device'),
  ]);
  const dims = { sources, countries, devices };

  /* ---- 内容四榜:各自独立成组(复测 R2-P2「没真拆」:此前四榜同在一个 section 里,
     任一张表出问题四张卡一起黑,而其余三张表是健康的)。隔离粒度必须与展示粒度一致。 ---- */
  const [pages, faq, learn, sections] = await Promise.all([
    section(async () =>
      (await db
        .prepare('SELECT path, locale, COALESCE(SUM(pv),0) pv, COALESCE(SUM(uv),0) uv FROM daily_page WHERE date BETWEEN ?1 AND ?2 GROUP BY path, locale ORDER BY pv DESC LIMIT 15')
        .bind(from, today)
        .all<{ path: string; locale: string; pv: number; uv: number }>()).results,
    ),
    section(async () =>
      (await db.prepare('SELECT faq_id, COALESCE(SUM(opens),0) opens FROM daily_faq WHERE date BETWEEN ?1 AND ?2 GROUP BY faq_id ORDER BY opens DESC LIMIT 15').bind(from, today).all<{ faq_id: string; opens: number }>()).results,
    ),
    section(async () =>
      (await db.prepare('SELECT slug, COALESCE(SUM(reads),0) reads FROM daily_learn WHERE date BETWEEN ?1 AND ?2 GROUP BY slug ORDER BY reads DESC LIMIT 15').bind(from, today).all<{ slug: string; reads: number }>()).results,
    ),
    section(async () =>
      (await db.prepare('SELECT section_id, COALESCE(SUM(uniq),0) uniq FROM daily_section WHERE date BETWEEN ?1 AND ?2 GROUP BY section_id ORDER BY uniq DESC').bind(from, today).all<{ section_id: string; uniq: number }>()).results,
    ),
  ]);
  const content = { pages, faq, learn, sections };

  // ---- 质量:LCP/CLS p75(按天取样本加权近似)+ JS 错误 + 404 ----
  const quality = await section(async () => {
    const v = (
      await db.prepare('SELECT date, lcp_p75, cls_p75, n FROM daily_vitals WHERE date BETWEEN ?1 AND ?2 ORDER BY date DESC').bind(from, today).all<{ date: string; lcp_p75: number; cls_p75: number; n: number }>()
    ).results;
    // 🔴 p75 不能跨天再求平均得到真 p75;取「最近一天的 p75」为展示值,并回样本量供前端标注口径
    const latest = v[0] ?? null;
    /* 🔴 每个指标只由**自己的表**决定有无数据(复测 R2-P3):此前前端把「JS 报错」的显示
       绑在 daily_vitals 上,导致「有报错、没性能样本」时真实告警被显示成「—」——
       而那恰恰是脚本早崩、最该看到报错的那天。API 直接回 null/数值,前端不再做跨表推断。 */
    const errRow = (
      await db.prepare('SELECT COALESCE(SUM(count),0) n, COUNT(*) rows FROM daily_errors WHERE date BETWEEN ?1 AND ?2').bind(from, today).first<{ n: number; rows: number }>()
    )!;
    const [nf, nfTotal] = await Promise.all([
      db.prepare('SELECT path, COALESCE(SUM(hits),0) hits FROM daily_notfound WHERE date BETWEEN ?1 AND ?2 GROUP BY path ORDER BY hits DESC LIMIT 10')
        .bind(from, today).all<{ path: string; hits: number }>(),
      db.prepare('SELECT COALESCE(SUM(hits),0) hits, COUNT(*) rows FROM daily_notfound WHERE date BETWEEN ?1 AND ?2')
        .bind(from, today).first<{ hits: number; rows: number }>(),
    ]);
    return {
      latest,
      errors: errRow.rows > 0 ? errRow.n : null,
      notFound: nf.results,
      notFoundTotal: (nfTotal?.rows ?? 0) > 0 ? (nfTotal?.hits ?? 0) : null,
    };
  });

  // ---- 运营健康:Bot 占比 + 屏蔽 + 下载探活状态(探活由前端按需触发,这里给规则/统计)----
  const health = await section(async () => {
    /* 🔴 Bot 占比按**请求加权**算(验收 P1-3:此前 AVG(bot_share) 是各日占比的无权重平均,
       实测与真实占比差近 2 倍还印成精确小数)。0004 迁移前的旧行没有分子分母 → 该期间回 null,
       前端显「—」并标注「口径升级前的历史区间无法回算」,不拿旧口径的数冒充。 */
    const botRow = await db
      .prepare(
        `SELECT COALESCE(SUM(bot_pv),0) b, COALESCE(SUM(human_pv),0) h, COUNT(*) n,
                SUM(CASE WHEN bot_pv + human_pv > 0 THEN 1 ELSE 0 END) covered
         FROM daily_bot WHERE date BETWEEN ?1 AND ?2`,
      )
      .bind(from, today)
      .first<{ b: number; h: number; n: number; covered: number | null }>();
    const denom = (botRow?.b ?? 0) + (botRow?.h ?? 0);
    const bot = denom > 0 ? botRow!.b / denom : null;
    /* 覆盖度(复测 R2-P2):混合窗(部分日期是 0004 迁移前的旧行、无分子分母)时,
       只按有分母的那几天算却宣称「全期加权」= 冒充。回传覆盖天数,由前端标注
       「仅覆盖 N/M 天」;全窗无分母时 bot=null 并标 legacy。0004 上线后 30/90 天档必然混合,
       这不是极端场景。 */
    const botDays = { covered: botRow?.covered ?? 0, total: botRow?.n ?? 0 };
    const botLegacy = botDays.total > 0 && botDays.covered === 0;
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
      botShare: bot, botLegacy, botDays, blocked, blockedTop,
      blockedShare: blocked + pvForShare > 0 ? blocked / (blocked + pvForShare) : null,
      geo: geo ? { enabled: geo.rules.enabled, countries: geo.rules.countries.length, degraded: geo.degraded } : null,
      lastPublish,
      probes: probes.map((p) => ({ ...p, ok: p.ok === 1, alert: p.ok !== 1 && p.fail_streak >= 2 })),
    };
  });

  // ---- 今日实时预览(E2:直查原始事件,标注口径以次日汇总为准)----
  const todayLive = await section(async () => {
    const t0 = Date.parse(`${today}T00:00:00.000Z`);
    const row = (await db.prepare(`
      SELECT
        COALESCE(SUM(CASE WHEN source.type = 'pv' THEN 1 ELSE 0 END),0) pv,
        COUNT(DISTINCT source.uid) uv,
        COALESCE(SUM(CASE
          WHEN source.type = 'cta' AND json_extract(source.payload, '$.cta') IN (${CONVERSION_CTA_SQL}) THEN 1
          ELSE 0
        END),0) cta
      FROM raw_events AS source
      WHERE source.ts >= ?1 AND (${VALID_HUMAN_BEACON_EVENT_SQL})
    `)
      .bind(t0)
      .first<{ pv: number; uv: number; cta: number }>())!;
    const blocked = (await db.prepare(`
      SELECT COUNT(*) n FROM raw_events AS source
      WHERE source.ts >= ?1 AND (${VALID_HUMAN_BLOCKED_EVENT_SQL})
    `).bind(t0).first<{ n: number }>())!.n;
    return { ...row, blocked };
  });

  return c.json({ range: days, from, to: today, overview, trend, funnel, locales, dims, content, quality, health, todayLive });
});
