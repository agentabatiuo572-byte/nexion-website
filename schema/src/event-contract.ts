/** Analytics low-cardinality IDs and byte limits shared by browser, ingest, and rollup. */
export const METRIC_SECTION_IDS = [
  'download',
  'stats',
  'social',
  'mission',
  'devices',
  'how',
  'path',
  'trust',
  'nex',
  'learn-entry',
  'faq',
  'final-cta',
] as const;

export const METRIC_CTA_IDS = ['ios', 'android', 'h5', 'contact'] as const;
/** Download/Web App conversion KPI. Contact stays a valid tracked CTA but is not a product conversion. */
export const METRIC_CONVERSION_CTA_IDS = ['ios', 'android', 'h5'] as const;
export const METRIC_CTA_SECTION_IDS = ['', ...METRIC_SECTION_IDS] as const;

export const METRIC_TEXT_BYTES = {
  path: 200,
  short: 64,
  section: 32,
  cta: 32,
  faq: 16,
  country: 8,
  blockedPathClass: 24,
} as const;

export const METRIC_FAQ_ID_PREFIX = 'q';
export const METRIC_FAQ_ID_PATTERN = /^q[1-9][0-9]*$/;

export function isMetricSectionId(value: string): value is (typeof METRIC_SECTION_IDS)[number] {
  return (METRIC_SECTION_IDS as readonly string[]).includes(value);
}

export function isMetricCtaId(value: string): value is (typeof METRIC_CTA_IDS)[number] {
  return (METRIC_CTA_IDS as readonly string[]).includes(value);
}

export function isMetricConversionCtaId(value: string): value is (typeof METRIC_CONVERSION_CTA_IDS)[number] {
  return (METRIC_CONVERSION_CTA_IDS as readonly string[]).includes(value);
}

export function isMetricFaqId(value: string): boolean {
  return METRIC_FAQ_ID_PATTERN.test(value);
}

export function metricFaqId(index: number): string {
  if (!Number.isSafeInteger(index) || index < 1) throw new RangeError('FAQ index must be a positive integer');
  return `q${index}`;
}

/** AI 反爬闸事件(规格 FEAT-ANTIBOT01 §3.5):server 侧写 raw_events(type='gate'),rollup 汇总进 daily_gate。 */
export const GATE_EVENT_TYPE = 'gate';
export const GATE_VERDICTS = ['pass', 'challenge', 'block'] as const;
export const GATE_REASONS = [
  'bypass_internal',
  'cookie_valid',
  'whitelist_social',
  'ai_bot_ua',
  'search_engine_ua',
  'challenge_issued',
  'turnstile_failed',
  'rate_limited',
  'gate_degraded',
] as const;
/** 名单版本号上限与 ASN 值域(rollup 形状校验用)。 */
export const GATE_LIST_VERSION_MAX = 1_000_000;
export const GATE_ASN_MAX = 4_294_967_295;
