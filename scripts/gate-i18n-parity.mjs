import { LOCALES } from '../schema/src/locales.ts';
import { resolveEnabledLocales } from '../src/lib/locale-policy.ts';

export function i18nParity(dictionaries, configuredLocales) {
  const enabled = resolveEnabledLocales(configuredLocales);
  const flatten = (value, prefix = '') => Object.entries(value).flatMap(([key, text]) =>
    typeof text === 'object' && text !== null ? flatten(text, `${prefix}${key}.`) : [[`${prefix}${key}`, text]]);
  const values = Object.fromEntries(LOCALES.map((locale) => [locale, new Map(flatten(dictionaries[locale]))]));
  const variables = (value) => JSON.stringify((value.match(/\{[^{}]+\}/g) || []).sort());
  const detail = [];
  for (const locale of LOCALES) {
    for (const [key, text] of values[locale]) if (typeof text !== 'string') detail.push(`${locale}.${key}: 文案必须是字符串`);
  }
  for (const locale of LOCALES.filter((value) => value !== 'en')) {
    for (const key of values.en.keys()) if (!values[locale].has(key)) detail.push(`${locale} 缺 key: ${key}`);
    for (const key of values[locale].keys()) if (!values.en.has(key)) detail.push(`${locale} 多出 key: ${key}(en 无)`);
    for (const [key, text] of values.en) {
      const translated = values[locale].get(key);
      if (typeof text !== 'string' || typeof translated !== 'string') continue;
      // Disabled translations remain editable; only their empty values can omit placeholders.
      if (!translated.trim()) {
        if (!enabled.includes(locale)) continue;
        if (text.trim()) detail.push(`${locale}.${key}: 启用语言缺少文案`);
      }
      if (variables(text) !== variables(translated)) detail.push(`${locale}.${key}: 插值变量与 en 不一致`);
    }
  }
  return detail;
}
