import { LEGACY_ENABLED_LOCALES, LOCALES } from './locales.js';

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const addedLocales = LOCALES.filter((locale) => !['en', 'vi', 'zh'].includes(locale));

/** Add missing language slots without editing any existing value. Validation follows this adapter.
 * Missing original en/vi/zh fields and unknown fields remain visible to validation, never repaired away.
 */
export function addLegacyLocaleFields(input: unknown, copyKeys: readonly string[]): unknown {
  const output: unknown = structuredClone(input);
  if (!isObject(output)) return output;
  if (!Object.hasOwn(output, 'enabledLocales')) output.enabledLocales = [...LEGACY_ENABLED_LOCALES];
  const fill = (value: unknown, make: () => unknown = () => '') => {
    if (isObject(value)) for (const locale of addedLocales) {
      if (!Object.hasOwn(value, locale)) value[locale] = make();
    }
  };
  fill(output.copy, () => Object.fromEntries(copyKeys.map((key) => [key, ''])));
  if (Array.isArray(output.skus)) for (const sku of output.skus) if (isObject(sku)) fill(sku.tagline);
  if (isObject(output.faq) && Array.isArray(output.faq.items)) {
    for (const item of output.faq.items) if (isObject(item)) { fill(item.q); fill(item.a); }
  }
  if (isObject(output.announcement)) fill(output.announcement.text);
  if (isObject(output.seo) && isObject(output.seo.pages)) {
    for (const page of Object.values(output.seo.pages)) if (isObject(page)) { fill(page.title); fill(page.description); }
  }
  if (isObject(output.legal)) for (const document of Object.values(output.legal)) if (isObject(document)) fill(document.md);
  return output;
}
