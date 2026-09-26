import type { Env } from './env';
import { LOCALES } from '../../schema/src/locales';
import { prepareAudit, type AuditEntry } from './audit';
import {
  METRIC_CTA_IDS,
  METRIC_CTA_SECTION_IDS,
  METRIC_CONVERSION_CTA_IDS,
  METRIC_FAQ_ID_PREFIX,
  METRIC_SECTION_IDS,
  METRIC_TEXT_BYTES,
  GATE_ASN_MAX,
  GATE_EVENT_TYPE,
  GATE_LIST_VERSION_MAX,
  GATE_REASONS,
  GATE_VERDICTS,
} from '../../schema/src/event-contract';

/* 日汇总引擎(PRD CON03-③ 口径字典 + §5.3)。幂等:同一 D1 batch 内先删该日再写。
   聚合键的基数没有业务上界，因此每张汇总表只发一条 INSERT…SELECT；整批最多 31 条 SQL，
   不再按聚合键生成语句。损坏/非对象/字段形状非法的事件按 raw_event_id 幂等写入隔离表，合法事件继续汇总。 */

const SESSION_GAP_MS = 30 * 60_000;
const RETENTION_DAYS = 90;
export const ROLLUP_VERSION = 2;

const DAILY_TABLES = [
  'daily_traffic',
  'daily_visitors',
  'daily_dimensions',
  'daily_cta',
  'daily_section',
  'daily_faq',
  'daily_learn',
  'daily_vitals',
  'daily_errors',
  'daily_blocked',
  'daily_bot',
  'daily_page',
  'daily_notfound',
  'daily_gate',
] as const;

/** 2 个固定前置语句 + 14 DELETE + 14 INSERT…SELECT + 1 条可选人工审计。 */
export const ROLLUP_BATCH_STATEMENT_LIMIT = 31;

export interface RollupResult {
  scannedEvents: number;
  processedEvents: number;
  rejectedEvents: number;
}

export function isUtcDay(day: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
  const timestamp = Date.parse(`${day}T00:00:00.000Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === day;
}

function dayRangeUtc(day: string): { from: number; to: number } {
  if (!isUtcDay(day)) throw new RangeError(`invalid UTC day: ${day}`);
  const from = Date.parse(`${day}T00:00:00.000Z`);
  return { from, to: from + 86_400_000 };
}

/** nearest-rank p75:sorted[ceil(0.75·n)-1]；保留为口径单测与调用方共用辅助。 */
export function p75(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.max(0, Math.ceil(0.75 * s.length) - 1)]!;
}

/* json_valid 只证明 JSON 语法成立；JSON.parse('null') 等仍不是事件对象。
   内层 CASE 保证 json_type 永远不会接触损坏 JSON。 */
const OBJECT_PAYLOAD_PREDICATE = `
  json_valid(payload) = 1
  AND json_type(CASE WHEN json_valid(payload) = 1 THEN payload ELSE '{}' END) = 'object'
`;

const jsonType = (field: string) => `json_type(payload, '$.${field}')`;
const jsonValue = (field: string) => `json_extract(payload, '$.${field}')`;
const sqlText = (value: string) => `'${value.replaceAll("'", "''")}'`;
const CONVERSION_CTA_IDS_SQL = METRIC_CONVERSION_CTA_IDS.map(sqlText).join(', ');

function textField(field: string, minLength?: number, maxLength?: number): string {
  const value = jsonValue(field);
  const bytes = `CAST(${value} AS BLOB)`;
  const checks = [`${jsonType(field)} = 'text'`, `instr(${bytes}, X'00') = 0`];
  if (minLength !== undefined) checks.push(`length(${bytes}) >= ${minLength}`);
  if (maxLength !== undefined) checks.push(`length(${bytes}) <= ${maxLength}`);
  return checks.join(' AND ');
}

function enumField(field: string, values: readonly string[]): string {
  return `${jsonType(field)} = 'text' AND ${jsonValue(field)} IN (${values.map(sqlText).join(', ')})`;
}

function numberField(field: string, min: number, max: number): string {
  return `${jsonType(field)} IN ('integer', 'real') AND ${jsonValue(field)} BETWEEN ${min} AND ${max}`;
}

const eventTag = (type: string) => `${jsonType('t')} = 'text' AND ${jsonValue('t')} = ${sqlText(type)}`;

/* 唯一的 bot 分类表达式：对缺失键也固定返回 0，保持旧 JS `p.bot === 1` 的真人口径。 */
const BOT_FLAG_SQL = `CASE
  WHEN ${jsonType('bot')} IN ('integer', 'real') AND ${jsonValue('bot')} = 1 THEN 1
  ELSE 0
END`;

/* 正常入口会写 0/1；唯一历史兼容口是键不存在。显式 null、布尔、字符串和其它数值都不是合法字段形状。 */
const BOT_FIELD_SHAPE_PREDICATE = `
  ${jsonType('bot')} IS NULL
  OR (${jsonType('bot')} IN ('integer', 'real') AND ${jsonValue('bot')} IN (0, 1))
`;
const BEACON_META_PREDICATE = `(${textField('country', 1, METRIC_TEXT_BYTES.country)} AND (${BOT_FIELD_SHAPE_PREDICATE}))`;
const FAQ_FIELD_PREDICATE = `
  ${textField('faq', 2, METRIC_TEXT_BYTES.faq)}
  AND substr(${jsonValue('faq')}, 1, 1) = ${sqlText(METRIC_FAQ_ID_PREFIX)}
  AND substr(${jsonValue('faq')}, 2, 1) BETWEEN '1' AND '9'
  AND substr(${jsonValue('faq')}, 2) NOT GLOB '*[^0-9]*'
`;

/* 与 EventSchema 及服务端 blocked/e404 载荷契约对齐。每个分支用 CASE 收口成 0/1，
   避免缺字段时 SQL NULL 穿透到 NOT/WHERE 的三值逻辑。 */
const EVENT_SHAPE_SQL = `CASE type
  WHEN 'pv' THEN CASE WHEN (
    ${eventTag('pv')}
    AND ${textField('path', 1, METRIC_TEXT_BYTES.path)}
    AND ${enumField('loc', LOCALES)}
    AND ${enumField('dev', ['m', 'd'])}
    AND ${enumField('ref', ['direct', 'internal', 'search', 'social', 'referral'])}
    AND ${textField('us', 0, METRIC_TEXT_BYTES.short)}
    AND ${textField('um', 0, METRIC_TEXT_BYTES.short)}
    AND ${textField('uc', 0, METRIC_TEXT_BYTES.short)}
    AND ${BEACON_META_PREDICATE}
  ) THEN 1 ELSE 0 END
  WHEN 'sec' THEN CASE WHEN (
    ${eventTag('sec')}
    AND ${enumField('sec', METRIC_SECTION_IDS)}
    AND ${textField('path', 1, METRIC_TEXT_BYTES.path)}
    AND ${BEACON_META_PREDICATE}
  ) THEN 1 ELSE 0 END
  WHEN 'cta' THEN CASE WHEN (
    ${eventTag('cta')}
    AND ${enumField('cta', METRIC_CTA_IDS)}
    AND ${enumField('sec', METRIC_CTA_SECTION_IDS)}
    AND ${enumField('loc', LOCALES)}
    AND ${textField('path', 1, METRIC_TEXT_BYTES.path)}
    AND ${BEACON_META_PREDICATE}
  ) THEN 1 ELSE 0 END
  WHEN 'faq' THEN CASE WHEN (
    ${eventTag('faq')}
    AND (${FAQ_FIELD_PREDICATE})
    AND ${enumField('loc', LOCALES)}
    AND ${BEACON_META_PREDICATE}
  ) THEN 1 ELSE 0 END
  WHEN 'vit' THEN CASE WHEN (
    ${eventTag('vit')}
    AND ${numberField('lcp', 0, 120_000)}
    AND ${numberField('cls', 0, 10)}
    AND ${textField('path', 1, METRIC_TEXT_BYTES.path)}
    AND ${enumField('dev', ['m', 'd'])}
    AND ${BEACON_META_PREDICATE}
  ) THEN 1 ELSE 0 END
  WHEN 'err' THEN CASE WHEN (
    ${eventTag('err')}
    AND ${textField('h', 1, 16)}
    AND ${textField('path', 1, METRIC_TEXT_BYTES.path)}
    AND ${BEACON_META_PREDICATE}
  ) THEN 1 ELSE 0 END
  WHEN 'blocked' THEN CASE WHEN (
    ${eventTag('blocked')}
    AND ${textField('c', 1, METRIC_TEXT_BYTES.country)}
    AND ${textField('p', 1, METRIC_TEXT_BYTES.blockedPathClass)}
    AND (${BOT_FIELD_SHAPE_PREDICATE})
  ) THEN 1 ELSE 0 END
  WHEN 'e404' THEN CASE WHEN (
    ${eventTag('e404')}
    AND ${textField('path', 1, METRIC_TEXT_BYTES.path)}
    AND (${BOT_FIELD_SHAPE_PREDICATE})
  ) THEN 1 ELSE 0 END
  WHEN 'gate' THEN CASE WHEN (
    ${eventTag('gate')}
    AND ${enumField('v', GATE_VERDICTS)}
    AND ${enumField('r', GATE_REASONS)}
    AND ${textField('ua', 0, METRIC_TEXT_BYTES.short)}
    AND (${jsonType('asn')} = 'null' OR (${jsonType('asn')} IN ('integer', 'real') AND ${jsonValue('asn')} BETWEEN 0 AND ${GATE_ASN_MAX}))
    AND ${textField('p', 1, METRIC_TEXT_BYTES.blockedPathClass)}
    AND ${numberField('lv', 1, GATE_LIST_VERSION_MAX)}
    AND ${numberField('e', 0, 1)}
  ) THEN 1 ELSE 0 END
  ELSE 0
END`;

/* 外层 CASE 是安全边界：字段函数永远不会接触损坏或非对象 JSON；结果始终为真/假。 */
const EVENT_PAYLOAD_PREDICATE = `CASE
  WHEN (${OBJECT_PAYLOAD_PREDICATE}) THEN (${EVENT_SHAPE_SQL})
  ELSE 0
END = 1`;

const BEACON_EVENT_TYPES = ['pv', 'sec', 'cta', 'faq', 'vit', 'err'] as const;
const SERVER_EVENT_TYPES = ['blocked', 'e404', GATE_EVENT_TYPE] as const;
const UID_SHAPE_PREDICATE = `
  typeof(source.uid) = 'text'
  AND length(CAST(source.uid AS BLOB)) = 16
  AND instr(CAST(source.uid AS BLOB), X'00') = 0
  AND source.uid NOT GLOB '*[^0-9a-f]*'
`;
const EVENT_ENVELOPE_PREDICATE = `CASE
  WHEN source.type IN (${BEACON_EVENT_TYPES.map(sqlText).join(', ')}) THEN CASE WHEN (${UID_SHAPE_PREDICATE}) THEN 1 ELSE 0 END
  WHEN source.type IN (${SERVER_EVENT_TYPES.map(sqlText).join(', ')}) THEN CASE WHEN source.uid IS NULL THEN 1 ELSE 0 END
  ELSE 0
END = 1`;
const EVENT_VALID_PREDICATE = `(${EVENT_PAYLOAD_PREDICATE}) AND (${EVENT_ENVELOPE_PREDICATE})`;

/** Shared with the live dashboard so raw previews cannot accept shapes that the daily rollup rejects. */
export const VALID_HUMAN_BEACON_EVENT_SQL = `
  source.type IN (${BEACON_EVENT_TYPES.map(sqlText).join(', ')})
  AND (${EVENT_VALID_PREDICATE})
  AND (${BOT_FLAG_SQL}) = 0
`;
export const VALID_HUMAN_BLOCKED_EVENT_SQL = `
  source.type = 'blocked'
  AND (${EVENT_VALID_PREDICATE})
  AND (${BOT_FLAG_SQL}) = 0
`;

let validatorFingerprintPromise: Promise<string> | undefined;
function validatorFingerprint(): Promise<string> {
  validatorFingerprintPromise ??= crypto.subtle
    .digest('SHA-256', new TextEncoder().encode(EVENT_VALID_PREDICATE))
    .then((digest) => [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join(''));
  return validatorFingerprintPromise;
}

const rejectedSnapshotMatch = (fingerprintParameter: string) => `
  rejected.raw_event_id = source.id
  AND rejected.event_ts = source.ts
  AND rejected.event_type = source.type
  AND rejected.payload = source.payload
  AND rejected.validator_fingerprint = ${fingerprintParameter}
`;

/* quarantine 前置语句只判一次完整字段资格；summary 与后续聚合都按隔离账里记录的
   raw_event 原始快照识别坏行，避免把完整谓词复制进另外 12 棵 SQLite AST。CASE 把坏载荷
   变成 NULL，即使 SQLite 内联 CTE，json_extract 也不会接触它。
   参数契约固定：?1=day、?2=from、?3=to、?4=validator fingerprint；流量语句另用 ?5=session gap。 */
const DAY_EVENTS_CTE = `
WITH sanitized AS (
  SELECT
    source.id,
    source.ts,
    source.type,
    COALESCE(source.uid, '') AS uid,
    CASE WHEN NOT EXISTS (
      SELECT 1
      FROM rollup_rejected_events AS rejected
      WHERE ${rejectedSnapshotMatch('?4')}
    ) THEN source.payload ELSE NULL END AS payload
  FROM raw_events AS source
  WHERE source.ts >= ?2 AND source.ts < ?3
),
events AS (
  SELECT id, ts, type, uid, payload
  FROM sanitized
  WHERE payload IS NOT NULL
)
`;

const HUMAN_SESSION_CTES = `
, human_activity AS (
  SELECT id, ts, uid
  FROM events
  WHERE type IN (${BEACON_EVENT_TYPES.map(sqlText).join(', ')})
    AND (${BOT_FLAG_SQL}) = 0
),
activity_boundaries AS (
  SELECT
    *,
    LAG(ts) OVER (PARTITION BY uid ORDER BY ts, id) AS previous_ts
  FROM human_activity
),
sessionized_activity AS (
  SELECT
    *,
    SUM(CASE WHEN previous_ts IS NULL OR ts - previous_ts > ?5 THEN 1 ELSE 0 END)
      OVER (PARTITION BY uid ORDER BY ts, id ROWS UNBOUNDED PRECEDING) AS session_no
  FROM activity_boundaries
),
session_pv AS (
  SELECT
    activity.id,
    activity.ts,
    activity.uid,
    activity.session_no,
    CAST(json_extract(event.payload, '$.loc') AS TEXT) AS locale,
    CAST(json_extract(event.payload, '$.country') AS TEXT) AS country,
    CAST(json_extract(event.payload, '$.dev') AS TEXT) AS device,
    CAST(json_extract(event.payload, '$.ref') AS TEXT) AS ref_class
  FROM sessionized_activity AS activity
  JOIN events AS event ON event.id = activity.id
  WHERE event.type = 'pv'
),
ranked_session_pv AS (
  SELECT
    *,
    ROW_NUMBER() OVER (PARTITION BY uid, session_no ORDER BY ts, id) AS pv_rank
  FROM session_pv
)
`;

const TRAFFIC_SQL = DAY_EVENTS_CTE + HUMAN_SESSION_CTES + `
, event_totals AS (
  SELECT locale, country, device, ref_class, COUNT(*) AS pv, COUNT(DISTINCT uid) AS uv
  FROM session_pv
  GROUP BY locale, country, device, ref_class
),
session_totals AS (
  SELECT
    locale,
    country,
    device,
    ref_class,
    COUNT(*) AS sessions
  FROM ranked_session_pv
  WHERE pv_rank = 1
  GROUP BY locale, country, device, ref_class
)
INSERT INTO daily_traffic (date, locale, country, device, ref_class, pv, uv, sessions)
SELECT ?1, e.locale, e.country, e.device, e.ref_class, e.pv, e.uv, COALESCE(s.sessions, 0)
FROM event_totals AS e
LEFT JOIN session_totals AS s
  ON s.locale = e.locale
 AND s.country = e.country
 AND s.device = e.device
 AND s.ref_class = e.ref_class
`;

const VISITORS_SQL = DAY_EVENTS_CTE + HUMAN_SESSION_CTES + `
, visitor_counts AS (
  SELECT COUNT(DISTINCT uid) AS uv
  FROM human_activity
),
session_counts AS (
  SELECT COUNT(*) AS sessions
  FROM activity_boundaries
  WHERE previous_ts IS NULL OR ts - previous_ts > ?5
),
cta_counts AS (
  SELECT COUNT(DISTINCT uid) AS cta_visitors
  FROM events
  WHERE type = 'cta'
    AND (${BOT_FLAG_SQL}) = 0
    AND ${enumField('cta', METRIC_CONVERSION_CTA_IDS)}
)
INSERT INTO daily_visitors (date, uv, sessions, cta_visitors, rollup_version)
SELECT ?1, visitor_counts.uv, session_counts.sessions, cta_counts.cta_visitors, ${ROLLUP_VERSION}
FROM visitor_counts, session_counts, cta_counts
WHERE visitor_counts.uv > 0
`;

const DIMENSIONS_SQL = DAY_EVENTS_CTE + `
, dimension_events AS (
  SELECT 'locale' AS dimension, CAST(json_extract(payload, '$.loc') AS TEXT) AS value, type, uid,
         CASE WHEN type = 'cta' THEN CAST(json_extract(payload, '$.cta') AS TEXT) ELSE NULL END AS cta_id
  FROM events
  WHERE type IN ('pv', 'cta', 'faq') AND (${BOT_FLAG_SQL}) = 0
  UNION ALL
  SELECT 'country', CAST(json_extract(payload, '$.country') AS TEXT), type, uid, NULL
  FROM events
  WHERE type IN (${BEACON_EVENT_TYPES.map(sqlText).join(', ')}) AND (${BOT_FLAG_SQL}) = 0
  UNION ALL
  SELECT 'device', CAST(json_extract(payload, '$.dev') AS TEXT), type, uid, NULL
  FROM events
  WHERE type IN ('pv', 'vit') AND (${BOT_FLAG_SQL}) = 0
  UNION ALL
  SELECT 'ref_class', CAST(json_extract(payload, '$.ref') AS TEXT), type, uid, NULL
  FROM events
  WHERE type = 'pv' AND (${BOT_FLAG_SQL}) = 0
)
INSERT INTO daily_dimensions (date, dimension, value, pv, uv, cta_visitors)
SELECT
  ?1,
  dimension,
  value,
  SUM(CASE WHEN type = 'pv' THEN 1 ELSE 0 END),
  COUNT(DISTINCT uid),
  CASE WHEN dimension = 'locale' THEN COUNT(DISTINCT CASE
    WHEN type = 'cta' AND cta_id IN (${CONVERSION_CTA_IDS_SQL}) THEN uid
  END) ELSE NULL END
FROM dimension_events
GROUP BY dimension, value
`;

const PAGE_SQL = DAY_EVENTS_CTE + `
, page_events AS (
  SELECT
    COALESCE(CAST(json_extract(payload, '$.path') AS TEXT), '/') AS path,
    COALESCE(CAST(json_extract(payload, '$.loc') AS TEXT), 'en') AS locale,
    uid
  FROM events
  WHERE type = 'pv'
    AND (${BOT_FLAG_SQL}) = 0
)
INSERT INTO daily_page (date, path, locale, pv, uv)
SELECT ?1, path, locale, COUNT(*), COUNT(DISTINCT uid)
FROM page_events
GROUP BY path, locale
`;

const NOTFOUND_SQL = DAY_EVENTS_CTE + `
INSERT INTO daily_notfound (date, path, hits)
SELECT ?1, COALESCE(CAST(json_extract(payload, '$.path') AS TEXT), '/'), COUNT(*)
FROM events
WHERE type = 'e404'
  AND (${BOT_FLAG_SQL}) = 0
GROUP BY COALESCE(CAST(json_extract(payload, '$.path') AS TEXT), '/')
`;

const CTA_SQL = DAY_EVENTS_CTE + `
, cta_events AS (
  SELECT
    COALESCE(CAST(json_extract(payload, '$.cta') AS TEXT), 'undefined') AS cta_id,
    COALESCE(CAST(json_extract(payload, '$.loc') AS TEXT), 'undefined') AS locale,
    uid
  FROM events
  WHERE type = 'cta'
    AND (${BOT_FLAG_SQL}) = 0
)
INSERT INTO daily_cta (date, cta_id, locale, clicks, uniq)
SELECT ?1, cta_id, locale, COUNT(*), COUNT(DISTINCT uid)
FROM cta_events
GROUP BY cta_id, locale
`;

const SECTION_SQL = DAY_EVENTS_CTE + `
INSERT INTO daily_section (date, section_id, uniq)
SELECT
  ?1,
  COALESCE(CAST(json_extract(payload, '$.sec') AS TEXT), 'undefined'),
  COUNT(DISTINCT uid)
FROM events
WHERE type = 'sec'
  AND (${BOT_FLAG_SQL}) = 0
GROUP BY COALESCE(CAST(json_extract(payload, '$.sec') AS TEXT), 'undefined')
`;

const FAQ_SQL = DAY_EVENTS_CTE + `
INSERT INTO daily_faq (date, faq_id, opens)
SELECT
  ?1,
  COALESCE(CAST(json_extract(payload, '$.faq') AS TEXT), 'undefined'),
  COUNT(*)
FROM events
WHERE type = 'faq'
  AND (${BOT_FLAG_SQL}) = 0
GROUP BY COALESCE(CAST(json_extract(payload, '$.faq') AS TEXT), 'undefined')
`;

const LEARN_SQL = DAY_EVENTS_CTE + `
, raw_paths AS (
  SELECT COALESCE(CAST(json_extract(payload, '$.path') AS TEXT), '/') AS path
  FROM events
  WHERE type = 'pv'
    AND (${BOT_FLAG_SQL}) = 0
),
locale_paths AS (
  SELECT CASE
    WHEN substr(path, 1, 4) IN (${LOCALES.filter((locale) => locale !== 'en').map((locale) => "'/" + locale + "/'").join(', ')}) THEN substr(path, 4)
    ELSE path
  END AS path
  FROM raw_paths
),
trimmed_paths AS (
  SELECT CASE
    WHEN substr(path, -1) = '/' THEN substr(path, 1, length(path) - 1)
    ELSE path
  END AS path
  FROM locale_paths
),
articles AS (
  SELECT substr(path, 8) AS slug
  FROM trimmed_paths
  WHERE substr(path, 1, 7) = '/learn/'
    AND length(substr(path, 8)) > 0
    AND instr(substr(path, 8), '/') = 0
)
INSERT INTO daily_learn (date, slug, reads)
SELECT ?1, slug, COUNT(*)
FROM articles
GROUP BY slug
`;

const VITALS_SQL = DAY_EVENTS_CTE + `
, samples AS (
  SELECT
    id,
    CAST(json_extract(payload, '$.lcp') AS REAL) AS lcp,
    CAST(json_extract(payload, '$.cls') AS REAL) AS cls
  FROM events
  WHERE type = 'vit'
    AND (${BOT_FLAG_SQL}) = 0
),
sample_count AS (
  SELECT COUNT(*) AS n FROM samples
),
lcp_ranked AS (
  SELECT lcp, ROW_NUMBER() OVER (ORDER BY lcp, id) AS rank FROM samples
),
cls_ranked AS (
  SELECT cls, ROW_NUMBER() OVER (ORDER BY cls, id) AS rank FROM samples
)
INSERT INTO daily_vitals (date, lcp_p75, cls_p75, n)
SELECT
  ?1,
  (SELECT lcp FROM lcp_ranked WHERE rank = CAST((3 * sample_count.n + 3) / 4 AS INTEGER)),
  (SELECT cls FROM cls_ranked WHERE rank = CAST((3 * sample_count.n + 3) / 4 AS INTEGER)),
  sample_count.n
FROM sample_count
WHERE sample_count.n > 0
`;

const ERRORS_SQL = DAY_EVENTS_CTE + `
INSERT INTO daily_errors (date, msg_hash, count)
SELECT
  ?1,
  COALESCE(CAST(json_extract(payload, '$.h') AS TEXT), 'undefined'),
  COUNT(*)
FROM events
WHERE type = 'err'
  AND (${BOT_FLAG_SQL}) = 0
GROUP BY COALESCE(CAST(json_extract(payload, '$.h') AS TEXT), 'undefined')
`;

const BLOCKED_SQL = DAY_EVENTS_CTE + `
INSERT INTO daily_blocked (date, country, hits)
SELECT
  ?1,
  COALESCE(CAST(json_extract(payload, '$.c') AS TEXT), 'XX'),
  COUNT(*)
FROM events
WHERE type = 'blocked'
  AND (${BOT_FLAG_SQL}) = 0
GROUP BY COALESCE(CAST(json_extract(payload, '$.c') AS TEXT), 'XX')
`;

const BOT_SQL = DAY_EVENTS_CTE + `
, bot_counts AS (
  SELECT
    SUM(${BOT_FLAG_SQL}) AS bot_pv,
    SUM(1 - (${BOT_FLAG_SQL})) AS human_pv
  FROM events
  WHERE type = 'pv'
)
INSERT INTO daily_bot (date, bot_share, bot_pv, human_pv)
SELECT
  ?1,
  ROUND(bot_pv * 1.0 / (bot_pv + human_pv), 3),
  bot_pv,
  human_pv
FROM bot_counts
WHERE bot_pv + human_pv > 0
`;

const GATE_SQL = DAY_EVENTS_CTE + `
, gate_counts AS (
  SELECT
    CAST(json_extract(payload, '$.v') AS TEXT) AS verdict,
    CAST(json_extract(payload, '$.r') AS TEXT) AS reason,
    COUNT(*) AS hits,
    SUM(CASE WHEN CAST(json_extract(payload, '$.e') AS INTEGER) = 1 THEN 1 ELSE 0 END) AS enforced_hits
  FROM events
  WHERE type = ${sqlText(GATE_EVENT_TYPE)}
  GROUP BY 1, 2
)
INSERT INTO daily_gate (date, verdict, reason, hits, enforced_hits)
SELECT ?1, verdict, reason, hits, enforced_hits
FROM gate_counts
`;

/**
 * 汇总、坏行隔离和可选人工审计在同一个 D1 batch 事务中提交。
 * 返回值来自隔离后的 summary 前置语句，手动 API 可据此如实报告部分隔离。
 */
export async function runDailyRollup(db: D1Database, day: string, audit?: AuditEntry): Promise<RollupResult> {
  const { from, to } = dayRangeUtc(day);
  const now = Date.now();
  const fingerprint = await validatorFingerprint();

  const quarantine = db.prepare(`
    INSERT INTO rollup_rejected_events (
      raw_event_id, event_ts, event_type, date, reason, validator_fingerprint,
      payload, first_seen_at, last_seen_at, attempts
    )
    SELECT
      source.id,
      source.ts,
      source.type,
      ?1,
      CASE
        WHEN EXISTS (
          SELECT 1 FROM rollup_rejected_events AS rejected
          WHERE ` + rejectedSnapshotMatch('?5') + `
        ) THEN (
          SELECT rejected.reason FROM rollup_rejected_events AS rejected
          WHERE ` + rejectedSnapshotMatch('?5') + `
        )
        WHEN json_valid(payload) = 0 THEN 'invalid-json'
        WHEN NOT (` + OBJECT_PAYLOAD_PREDICATE + `) THEN 'non-object-json'
        ELSE 'invalid-event-shape'
      END,
      ?5,
      source.payload,
      ?4,
      ?4,
      1
    FROM raw_events AS source
    WHERE source.ts >= ?2 AND source.ts < ?3
      AND CASE
        WHEN EXISTS (
          SELECT 1 FROM rollup_rejected_events AS rejected
          WHERE ` + rejectedSnapshotMatch('?5') + `
        ) THEN 1
        WHEN NOT (` + EVENT_VALID_PREDICATE + `) THEN 1
        ELSE 0
      END = 1
    ON CONFLICT(raw_event_id) DO UPDATE SET
      event_ts = excluded.event_ts,
      event_type = excluded.event_type,
      date = excluded.date,
      reason = excluded.reason,
      validator_fingerprint = excluded.validator_fingerprint,
      payload = excluded.payload,
      last_seen_at = excluded.last_seen_at,
      attempts = rollup_rejected_events.attempts + 1
  `).bind(day, from, to, now, fingerprint);

  const summary = db.prepare(`
    SELECT
      COUNT(*) AS scannedEvents,
      COUNT(*) - COUNT(rejected.raw_event_id) AS processedEvents,
      COUNT(rejected.raw_event_id) AS rejectedEvents
    FROM raw_events AS source
    LEFT JOIN rollup_rejected_events AS rejected ON (` + rejectedSnapshotMatch('?3') + `)
    WHERE source.ts >= ?1 AND source.ts < ?2
  `).bind(from, to, fingerprint);

  const aggregate = (sql: string, ...extra: unknown[]) => db.prepare(sql).bind(day, from, to, fingerprint, ...extra);
  const statements: D1PreparedStatement[] = [
    quarantine,
    summary,
    ...DAILY_TABLES.map((table) => db.prepare('DELETE FROM ' + table + ' WHERE date = ?1').bind(day)),
    aggregate(PAGE_SQL),
    aggregate(NOTFOUND_SQL),
    aggregate(VISITORS_SQL, SESSION_GAP_MS),
    aggregate(DIMENSIONS_SQL),
    aggregate(TRAFFIC_SQL, SESSION_GAP_MS),
    aggregate(CTA_SQL),
    aggregate(SECTION_SQL),
    aggregate(FAQ_SQL),
    aggregate(LEARN_SQL),
    aggregate(VITALS_SQL),
    aggregate(ERRORS_SQL),
    aggregate(BLOCKED_SQL),
    aggregate(BOT_SQL),
    aggregate(GATE_SQL),
  ];
  if (audit) statements.push(prepareAudit(db, audit));

  if (statements.length > ROLLUP_BATCH_STATEMENT_LIMIT) {
    throw new Error('rollup batch statement bound exceeded: ' + statements.length);
  }

  const results = await db.batch<RollupResult>(statements);
  const row = results[1]?.results[0];
  if (!row) throw new Error('rollup summary missing');
  return {
    scannedEvents: Number(row.scannedEvents),
    processedEvents: Number(row.processedEvents),
    rejectedEvents: Number(row.rejectedEvents),
  };
}

/** 原始事件 90 天滚动清理(PRD §5.3) */
export async function pruneRawEvents(db: D1Database, now: number): Promise<number> {
  const r = await db.prepare('DELETE FROM raw_events WHERE ts < ?1').bind(now - RETENTION_DAYS * 86_400_000).run();
  return r.meta.changes ?? 0;
}

/** cron 入口:汇总昨日(UTC)+ 清理；汇总失败时不清理，保留原始事件供重试。 */
export async function dailyJob(env: Env, now = Date.now()): Promise<void> {
  const yesterday = new Date(now - 86_400_000).toISOString().slice(0, 10);
  const result = await runDailyRollup(env.DB, yesterday);
  if (result.rejectedEvents > 0) {
    console.warn('daily rollup completed with rejected events', {
      day: yesterday,
      rejectedEvents: result.rejectedEvents,
    });
  }
  await pruneRawEvents(env.DB, now);
}
