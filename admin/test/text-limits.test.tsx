// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { LOCALES, type Locale } from '../../schema/src/locales';
import catalog from '../src/lib/text-layout-limits.json';
import manifest from '../../worker/seed/copy-manifest.json';
import { countInputCharacters, getTextLimit } from '../src/lib/text-limits';
import { TextLimitHint } from '../src/lib/text-limit-hint';

type Measurement = {
  limits?: Partial<Record<Locale, number>>;
  references?: Partial<Record<Locale, string>>;
  previewReasons?: Partial<Record<Locale, string>>;
  basis?: 'reference' | 'container';
};
type TestRule = Measurement & { kind: string; description: string; instances?: Record<string, Measurement> };
const rules = catalog.fields as Record<string, TestRule>;
// A regression fixture, not a constraint on copy materialized for a publish build.
const APPROVED_ENGLISH_HERO = 'NexGrid\nLet compute flow';
const byLocale = <T,>(value: T) => Object.fromEntries(LOCALES.map((locale) => [locale, value])) as Record<Locale, T>;
function withRule(key: string, value: TestRule, test: () => void) {
  const original = rules[key], version = catalog.version;
  rules[key] = value;
  catalog.version = 2;
  try { test(); } finally { catalog.version = version; if (original) rules[key] = original; else delete rules[key]; }
}
const fieldId = (key: string, locale: Locale, instance?: string) => key === 'sku.name' ? `/skus/${instance}/name`
  : key === 'sku.tagline' ? `/skus/${instance}/tagline/${locale}`
  : key === 'announcement.text' ? `/announcement/text/${locale}` : `/copy/${locale}/${key}`;
afterEach(cleanup);

it('counts graphemes, spaces, format markers and normalized line breaks without altering input', () => {
  const value = 'a\r\nb\rc\n';
  expect(countInputCharacters(value)).toBe(6);
  expect(value).toBe('a\r\nb\rc\n');
  for (const locale of LOCALES) {
    expect(countInputCharacters('a\u0301👍🏽👨‍👩‍👧‍👦🇻🇳', locale)).toBe(4);
    expect(countInputCharacters(' 中文\n', locale)).toBe(4);
    expect(countInputCharacters('[[GPU]]', locale)).toBe(7);
    expect(countInputCharacters('{name}', locale)).toBe(6);
  }
});

it.each([
  ['/copy/vi/hero.title', 'hero.title'], ['/skus/nex~1plus/tagline/vi', 'sku.tagline'],
  ['/skus/nex~1plus/name', 'sku.name'], ['/faq/items/faq~01/q/vi', 'faq.q'],
  ['/faq/items/new-item/a/vi', 'faq.a'], ['/announcement/text/vi', 'announcement.text'],
  ['/seo/pages/legal-privacy/title/vi', 'seo.title'], ['/seo/pages/home/description/vi', 'seo.description'],
  ['/legal/appPrivacy/md/vi', 'legal.md'], ['/footer/contactEmail', 'footer.contactEmail'],
  ['/geo/blockPage/title/vi', 'geo.title'], ['/geo/blockPage/body/vi', 'geo.body'],
  ['/downloads/android/url', 'link'], ['/announcement/href', 'link'],
])('resolves stable field %s to its family', (field, key) => {
  const result = getTextLimit(field, 'vi');
  expect(result.key).toBe(key);
  expect(result.kind).not.toBe('uncalibrated');
});

it('covers every copy key and represents missing numeric advice explicitly in all nine locales', () => {
  for (const key of manifest.editable) for (const locale of LOCALES) {
    const result = getTextLimit(fieldId(key, locale), locale);
    expect(result.kind, key + '/' + locale).not.toBe('uncalibrated');
    if (result.kind === 'bounded' && result.limit === undefined) expect(result.previewReason, key + '/' + locale).toBeTruthy();
  }
});

it('keeps the approved 24-character English fixture free of false length warnings', () => {
  expect(countInputCharacters(APPROVED_ENGLISH_HERO, 'en')).toBe(24);
  const result = getTextLimit('/copy/en/hero.title', 'en');
  const { container } = render(<TextLimitHint id="default" fieldId="/copy/en/hero.title" locale="en" value={APPROVED_ENGLISH_HERO} />);
  if (result.limit === undefined) {
    expect(result.previewReason).toBeTruthy();
    expect(container.textContent).toContain(result.previewReason!);
    expect(container.querySelector('[data-limit]')).toBeNull();
  } else {
    expect(result.limit).toBeGreaterThanOrEqual(24);
    expect(result.basis).toBe('reference');
    expect(container.textContent).toContain('英语按默认断行建议约');
  }
  expect(container.firstElementChild?.getAttribute('data-count')).toBe('24');
  expect(container.firstElementChild?.getAttribute('data-text-limit-over')).toBe('false');
  expect(container.querySelector('[data-limit="16"]')).toBeNull();
  expect((container.firstElementChild as HTMLElement).style.color).not.toBe('var(--bad)');
});

it('never marks any measured default reference as over-limit, including every known SKU and locale', () => {
  const view = render(<TextLimitHint id="matrix" fieldId="/copy/en/hero.title" locale="en" value="" />);
  let checked = 0;
  for (const [key, rule] of Object.entries(rules)) {
    if (rule.kind !== 'bounded') continue;
    const instances = key.startsWith('sku.') ? Object.entries(rule.instances ?? {}) : [[undefined, rule] as const];
    if (key.startsWith('sku.')) expect(instances.length, key).toBeGreaterThan(0);
    for (const [id, measurement] of instances) for (const locale of LOCALES) {
      const reference = measurement.references?.[locale];
      expect(typeof reference, `${key}/${id ?? ''}/${locale}`).toBe('string');
      const field = fieldId(key, locale, id?.replaceAll('~', '~0').replaceAll('/', '~1'));
      const result = getTextLimit(field, locale);
      expect(result.reference).toBe(reference);
      if (result.limit !== undefined) expect(result.limit, field).toBeGreaterThanOrEqual(countInputCharacters(reference!, locale));
      else expect(result.previewReason, field).toBeTruthy();
      view.rerender(<TextLimitHint id="matrix" fieldId={field} locale={locale} value={reference!} />);
      expect(view.container.firstElementChild?.getAttribute('data-text-limit-over'), field).toBe('false');
      checked++;
    }
  }
  expect(checked).toBeGreaterThan(LOCALES.length);
});

it('resolves names and taglines by actual SKU id without applying another product minimum', () => {
  for (const key of ['sku.name', 'sku.tagline']) withRule(key, {
    kind: 'bounded', description: 'Product card', basis: 'reference', instances: {
      small: { limits: byLocale(8), references: byLocale('Phone') },
      'large/plus': { limits: byLocale(32), references: byLocale('NexGridBox Plus') },
    },
  }, () => {
    for (const locale of LOCALES) {
      expect(getTextLimit(fieldId(key, locale, 'small'), locale).limit).toBe(8);
      const large = getTextLimit(fieldId(key, locale, 'large~1plus'), locale);
      expect(large.limit).toBe(32); expect(large.reference).toBe('NexGridBox Plus'); expect(large.basis).toBe('reference');
      const unknown = getTextLimit(fieldId(key, locale, 'new-product'), locale);
      expect(unknown.kind).toBe('bounded'); expect(unknown.limit).toBeUndefined(); expect(unknown.previewReason).toContain('这个产品');
    }
  });
});

it('requires all nine measured locales before issuing a shared product-name number', () => {
  const measurements: Partial<Record<Locale, number>> = byLocale(40); measurements.ja = 30;
  withRule('sku.name', { kind: 'bounded', description: 'Name', instances: { known: { limits: measurements, references: byLocale('Known') } } }, () => {
    for (const locale of LOCALES) expect(getTextLimit('/skus/known/name', locale).limit).toBe(30);
    delete measurements.ko;
    for (const locale of LOCALES) {
      const missing = getTextLimit('/skus/known/name', locale);
      expect(missing.limit).toBeUndefined(); expect(missing.previewReason).toContain('全部语言');
    }
    measurements.ko = 40;
    rules['sku.name']!.instances!.known!.previewReasons = { ja: '此语言无法可靠测量，请检查预览。' };
    for (const locale of LOCALES) {
      const uncertain = getTextLimit('/skus/known/name', locale);
      expect(uncertain.limit).toBeUndefined(); expect(uncertain.previewReason).toContain('无法可靠测量');
    }
  });
});

it('shows an explicit neutral preview reason without inventing a number or a red failure', () => {
  withRule('test.preview', { kind: 'bounded', description: 'Shared content', references: { en: 'Known' }, previewReasons: { en: '同区域内容决定剩余空间，请结合前台预览检查。' } }, () => {
    const { container } = render(<TextLimitHint id="preview" fieldId="/copy/en/test.preview" locale="en" value={'W'.repeat(100)} />);
    expect(container.textContent).toContain('已输入 100 字符');
    expect(container.textContent).toContain('同区域内容决定剩余空间');
    expect(container.textContent).not.toContain('尚未校准');
    expect(container.querySelector('[data-limit]')).toBeNull();
    expect(container.firstElementChild?.getAttribute('data-text-limit-over')).toBe('false');
    expect((container.firstElementChild as HTMLElement).style.color).not.toBe('var(--bad)');
  });
});

it('fails closed for obsolete bounded recommendations while retaining non-layout classifications', () => {
  withRule('test.obsolete', { kind: 'bounded', description: 'Title', limits: { en: 1 } }, () => {
    catalog.version = 1;
    const result = getTextLimit('/copy/en/test.obsolete', 'en');
    expect(result.limit).toBeUndefined(); expect(result.previewReason).toContain('旧建议值正在重新核验');
    expect(getTextLimit('/legal/privacy/md/en', 'en').kind).toBe('flowing');
    expect(getTextLimit('/copy/en/nav.ariaMain', 'en').kind).toBe('metadata');
    const { container } = render(<TextLimitHint id="old" fieldId="/copy/en/test.obsolete" locale="en" value="NexGrid" />);
    expect(container.querySelector('[data-limit]')).toBeNull();
    expect(container.firstElementChild?.getAttribute('data-text-limit-over')).toBe('false');
  });
});

it('uses reference wording and a neutral newline-change reminder even below the recommendation', () => {
  withRule('test.reference', { kind: 'bounded', description: 'Title', basis: 'reference', limits: { en: 30 }, references: { en: APPROVED_ENGLISH_HERO } }, () => {
    const props = { id: 'reference', fieldId: '/copy/en/test.reference', locale: 'en' as const };
    const view = render(<TextLimitHint {...props} value="Short title" />);
    expect(view.container.textContent).toContain('英语按默认断行建议约 30 字符');
    expect(view.container.textContent).toContain('手动换行数量与默认文案不同');
    expect(view.container.firstElementChild?.getAttribute('data-text-limit-over')).toBe('false');
    expect((view.container.firstElementChild as HTMLElement).style.color).not.toBe('var(--bad)');
    view.rerender(<TextLimitHint {...props} value={'a'.repeat(31)} />);
    expect(view.container.textContent).toContain('可能增加行数或改变原有排版比例');
    expect(view.container.textContent).not.toContain('内容被截断');
    view.rerender(<TextLimitHint {...props} value={APPROVED_ENGLISH_HERO.replace('\n', '\r\n')} />);
    expect(view.container.textContent).not.toContain('手动换行数量');
  });
});

it('warns above physical container advice, clears when shortened and retains soft action wording', () => {
  withRule('test.container', { kind: 'bounded', description: 'Button', basis: 'container', limits: { en: 8 }, references: { en: 'Open' } }, () => {
    const props = { id: 'container', fieldId: '/copy/en/test.container', locale: 'en' as const };
    const view = render(<TextLimitHint {...props} value={'a\u0301'.repeat(8)} />);
    expect(view.container.firstElementChild?.getAttribute('data-text-limit-over')).toBe('false');
    view.rerender(<TextLimitHint {...props} value={'a\u0301'.repeat(9)} />);
    expect(view.container.textContent).toContain('已超出建议长度 1 字符');
    expect(view.container.textContent).toContain('内容被截断');
    expect(view.container.textContent).toContain('仅超出排版建议时仍可保存和发布，原有系统校验仍适用');
    expect((view.container.firstElementChild as HTMLElement).style.color).toBe('var(--bad)');
    expect(view.container.querySelector('[role="alert"],[aria-live],[aria-invalid]')).toBeNull();
    view.rerender(<TextLimitHint {...props} value="" />);
    expect(view.container.textContent).toContain('已输入 0 字符');
    expect(view.container.firstElementChild?.getAttribute('data-text-limit-over')).toBe('false');
    view.rerender(<TextLimitHint {...props} value={'a'.repeat(9)} immediate />);
    expect(view.container.textContent).toContain('仍可应用规则'); expect(view.container.textContent).not.toContain('保存和发布');
  });
});

it('handles N-1/N/N+1 only where a reliable measurement exists in all nine locales', () => {
  const view = render(<TextLimitHint id="matrix" fieldId="/copy/en/hero.title" locale="en" value="" />);
  const expected = Object.entries(rules).filter(([, rule]) => rule.kind === 'bounded')
    .reduce((total, [key, rule]) => total + (key.startsWith('sku.') ? Object.keys(rule.instances ?? {}).length : 1) * LOCALES.length, 0);
  let checked = 0, previewed = 0;
  for (const [key, rule] of Object.entries(rules)) {
    if (rule.kind !== 'bounded') continue;
    const ids = key.startsWith('sku.') ? Object.keys(rule.instances ?? {}) : [undefined];
    for (const id of ids) for (const locale of LOCALES) {
      const field = fieldId(key, locale, id?.replaceAll('~', '~0').replaceAll('/', '~1'));
      const { limit, previewReason } = getTextLimit(field, locale);
      if (limit === undefined) { expect(previewReason).toBeTruthy(); previewed++; continue; }
      for (const delta of [-1, 0, 1]) {
        view.rerender(<TextLimitHint id="matrix" fieldId={field} locale={locale} value={'a\u0301'.repeat(limit + delta)} />);
        expect(view.container.firstElementChild?.getAttribute('data-count')).toBe(String(limit + delta));
        expect(view.container.firstElementChild?.getAttribute('data-text-limit-over')).toBe(String(delta > 0));
        checked++;
      }
    }
  }
  expect(checked + previewed * 3).toBe(expected * 3);
});

it('shows the email-specific mobile preview reason without promising wrapping or inventing a text cap', () => {
  const description = '邮件地址可能无法换行，请检查手机端预览；不按普通文案设置字数建议，原有邮箱校验仍适用。';
  const value = 'a'.repeat(64) + '@example.com';
  withRule('footer.contactEmail', { kind: 'system', description }, () => {
    const view = render(<TextLimitHint id="email" fieldId="/footer/contactEmail" locale="en" value={value} />);
    for (const locale of LOCALES) {
      view.rerender(<TextLimitHint id="email" fieldId="/footer/contactEmail" locale={locale} value={value} />);
      expect(view.container.firstElementChild?.getAttribute('data-count')).toBe('76');
      expect(view.container.textContent).toContain(description);
      expect(view.container.textContent).not.toContain('可自动换行');
      expect(view.container.textContent).not.toContain('建议最多');
      expect(view.container.querySelector('[data-limit]')).toBeNull();
      expect(view.container.firstElementChild?.getAttribute('data-text-limit-over')).toBe('false');
      expect((view.container.firstElementChild as HTMLElement).style.color).not.toBe('var(--bad)');
    }
  });
});

it('distinguishes unknown fields, flowing documents, metadata, links and immediately applied Geo copy', () => {
  expect(getTextLimit('/copy/en/new.unmapped', 'en')).toEqual({ key: 'new.unmapped', kind: 'uncalibrated', description: '尚未校准建议长度' });
  expect(getTextLimit('/copy/en/__proto__', 'en').kind).toBe('uncalibrated');
  const view = render(<TextLimitHint id="hint" fieldId="/copy/en/new.unmapped" locale="en" value="sample" />);
  expect(view.container.textContent).toContain('尚未校准'); expect(view.container.textContent).not.toContain('无固定');
  view.rerender(<TextLimitHint id="hint" fieldId="/legal/privacy/md/en" locale="en" value="# Title" />);
  expect(view.container.textContent).toContain('可自动换行，无固定排版上限');
  view.rerender(<TextLimitHint id="hint" fieldId="/copy/en/nav.ariaMain" locale="en" value="Main" />);
  expect(view.container.textContent).toContain('辅助说明'); expect(view.container.textContent).not.toContain('排版错乱');
  view.rerender(<TextLimitHint id="hint" fieldId="/copy/en/why.portraitAlt" locale="en" value="Portrait of {name}" />);
  expect(view.container.textContent).toContain('占位符'); expect(view.container.textContent).not.toContain('宽度');
  view.rerender(<TextLimitHint id="hint" fieldId="/downloads/ios/url" locale="en" value="https://example.com" />);
  expect(view.container.textContent).not.toContain('排版错乱');
  view.rerender(<TextLimitHint id="hint" fieldId="/geo/blockPage/title/en" locale="en" value="Regional service availability" immediate />);
  expect(view.container.textContent).not.toContain('保存和发布');
});
