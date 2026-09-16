import { LOCALES, DEFAULT_ENABLED_LOCALES, isLocale, type Locale } from '../../schema/src/locales.ts';

/** Validate selection once; route order never depends on checkbox click order. */
export function resolveEnabledLocales(value: unknown): Locale[] {
  const selected = value === undefined ? DEFAULT_ENABLED_LOCALES : value;
  if (!Array.isArray(selected) || selected.some((l) => typeof l !== 'string' || !isLocale(l)) ||
      new Set(selected).size !== selected.length || !selected.includes('en')) {
    throw new Error('Invalid enabledLocales: unique registered languages including en are required');
  }
  return LOCALES.filter((locale) => selected.includes(locale));
}

export function localizedPath(locale: Locale, path = '/'): string {
  const normalized = `/${path.replace(/^\/+|\/+$/g, '')}`;
  return `${locale === 'en' ? '' : `/${locale}`}${normalized}${normalized === '/' ? '' : '/'}`;
}

/** Keep the existing three locales' number formats; other languages use their BCP-47 code. */
export function localeNumberTag(locale: Locale): string {
  return ({ en: 'en-US', vi: 'vi-VN', zh: 'zh-CN' } as Partial<Record<Locale, string>>)[locale] ?? locale;
}
