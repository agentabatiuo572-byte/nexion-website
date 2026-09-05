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
