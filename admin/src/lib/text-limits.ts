import { LOCALES, type Locale } from '../../../schema/src/locales';
import limits from './text-layout-limits.json';

type Measurement = {
  limits?: Partial<Record<Locale, number>>;
  references?: Partial<Record<Locale, string>>;
  previewReasons?: Partial<Record<Locale, string>>;
  basis?: 'reference' | 'container';
};
type Rule = Measurement & {
  kind: 'bounded' | 'flowing' | 'metadata' | 'seo' | 'system';
  description: string;
  syntax?: 'template' | 'why';
  instances?: Record<string, Measurement>;
};
export type TextLimit = Pick<Rule, 'description' | 'syntax' | 'basis'> & {
  key: string;
  kind: Rule['kind'] | 'uncalibrated';
  limit?: number;
  reference?: string;
  previewReason?: string;
};

/** Count input characters; line-ending normalization never changes the stored value. */
export function countInputCharacters(value: string, locale?: Locale): number {
  let count = 0;
  for (const _ of new Intl.Segmenter(locale, { granularity: 'grapheme' }).segment(value.replace(/\r\n?/g, '\n'))) count++;
  return count;
}

function fieldKey(fieldId: string): string {
  const parts = fieldId.slice(1).split('/').map((part) => part.replaceAll('~1', '/').replaceAll('~0', '~'));
  if (!fieldId.startsWith('/')) return '';
  if (parts[0] === 'copy' && parts.length === 3) return parts[2]!;
  if (parts[0] === 'skus' && parts[2] === 'name' && parts.length === 3) return 'sku.name';
  if (parts[0] === 'skus' && parts[2] === 'tagline' && parts.length === 4) return 'sku.tagline';
  if (parts[0] === 'faq' && parts[1] === 'items' && ['q', 'a'].includes(parts[3] ?? '') && parts.length === 5) return 'faq.' + parts[3];
  if (parts[0] === 'announcement' && parts[1] === 'text' && parts.length === 3) return 'announcement.text';
  if (parts[0] === 'seo' && parts[1] === 'pages' && ['title', 'description'].includes(parts[3] ?? '') && parts.length === 5) return 'seo.' + parts[3];
  if (parts[0] === 'legal' && parts[2] === 'md' && parts.length === 4) return 'legal.md';
  if (fieldId === '/footer/contactEmail') return 'footer.contactEmail';
  if (parts[0] === 'geo' && parts[1] === 'blockPage' && ['title', 'body'].includes(parts[2] ?? '') && parts.length === 4) return 'geo.' + parts[2];
  if ((parts[0] === 'downloads' && parts[2] === 'url' && parts.length === 3) || fieldId === '/announcement/href') return 'link';
  return '';
}

/** Unknown or incomplete calibration is never presented as an unlimited or safe field. */
export function getTextLimit(fieldId: string, locale: Locale): TextLimit {
  const key = fieldKey(fieldId);
  const rule = Object.hasOwn(limits.fields, key) ? (limits.fields as Record<string, Rule>)[key] : undefined;
  if (!rule) return { key, kind: 'uncalibrated', description: '尚未校准建议长度' };
  const { kind, description, syntax } = rule;
  if (kind === 'bounded' && limits.version !== 2) return { key, kind, description, syntax,
    previewReason: '旧建议值正在重新核验，请结合前台预览检查。' };
  let measurement: Measurement = rule;
  if (key === 'sku.name' || key === 'sku.tagline') {
    const skuId = fieldId.split('/')[2]!.replaceAll('~1', '/').replaceAll('~0', '~');
    const instance = Object.hasOwn(rule.instances ?? {}, skuId) ? rule.instances![skuId] : undefined;
    if (!instance) return { key, kind, description, syntax, previewReason: '这个产品尚无对应的排版测量结果，请结合前台预览检查。' };
    measurement = instance;
  }
  const languages = key === 'sku.name' ? LOCALES : [locale];
  const values = languages.map((language) => measurement.limits?.[language]);
  const reason = languages.map((language) => measurement.previewReasons?.[language]).find(Boolean);
  const reliable = !reason && values.every((value) => Number.isInteger(value) && value! > 0);
  const limit = kind === 'bounded' && reliable ? Math.min(...values as number[]) : undefined;
  const previewReason = reason || (kind === 'bounded' && limit === undefined
    ? key === 'sku.name' ? '共用名称尚未取得全部语言的可靠字数建议，请结合前台预览检查。'
      : '此处暂不提供可靠的字数建议，请结合前台预览检查。'
    : undefined);
  return { key, kind, description, syntax, basis: measurement.basis ?? rule.basis,
    limit, reference: measurement.references?.[locale], previewReason };
}
