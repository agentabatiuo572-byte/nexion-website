/** 撰写源语言:后台以此语种为原文,其余语种为译文(占位符/换行比对、翻译任务源文、参考语言默认值都认它)。 */
export const SOURCE_LOCALE = 'zh' as const satisfies Locale;
/** Content languages and public selection share one contract. English is the default route. */
export const LOCALES = ['en', 'vi', 'es', 'pt', 'fr', 'de', 'ja', 'ko', 'zh'] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_ENABLED_LOCALES = ['en', 'zh', 'vi', 'es', 'pt', 'fr', 'de', 'ja', 'ko'] as const satisfies readonly Locale[];
export const LEGACY_ENABLED_LOCALES = ['en', 'vi'] as const satisfies readonly Locale[];
export const LOCALE_NAMES: Record<Locale, string> = {
  en: '英语', vi: '越南语', es: '西班牙语', pt: '葡萄牙语', fr: '法语',
  de: '德语', ja: '日语', ko: '韩语', zh: '中文',
};
export const LOCALE_NATIVE_NAMES: Record<Locale, string> = {
  en: 'English', vi: 'Tiếng Việt', es: 'Español', pt: 'Português', fr: 'Français',
  de: 'Deutsch', ja: '日本語', ko: '한국어', zh: '中文',
};
export const isLocale = (value: string): value is Locale => (LOCALES as readonly string[]).includes(value);
/** All authored languages are retained, including disabled ones. Order binds publication hashes. */
export const MATERIALIZED_FILES = [...LOCALES.map((locale) => `src/i18n/${locale}.json`), 'src/config/site.json'] as const;
