import en from './en.json';
import vi from './vi.json';
import zh from './zh.json';
import { loadBuildFixture } from '../lib/build-fixture';

export const locales = ['en', 'vi', 'zh'] as const;
export type Locale = (typeof locales)[number];

const dicts: Record<Locale, unknown> = {
  en: loadBuildFixture('en.json', en),
  vi: loadBuildFixture('vi.json', vi),
  zh: loadBuildFixture('zh.json', zh),
};

/* ponytail: 静态站字典查找,不引 i18n 库;key 缺失回退 en 再回退 key 本身
   (三语 parity 由 scripts/verify.mjs 门保证,回退只是运行时兜底) */
function lookup(dict: unknown, key: string): string | undefined {
  let cur: unknown = dict;
  for (const part of key.split('.')) {
    if (typeof cur !== 'object' || cur === null) return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return typeof cur === 'string' ? cur : undefined;
}

export function useT(locale: Locale) {
  return (key: string, vars?: Record<string, string | number>): string => {
    let s = lookup(dicts[locale], key) ?? lookup(dicts.en, key) ?? key;
    if (vars) for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(String(v));
    return s;
  };
}

export function localeFromUrl(pathname: string): Locale {
  const seg = pathname.split('/').filter(Boolean)[0];
  return (locales as readonly string[]).includes(seg) ? (seg as Locale) : 'en';
}

/** 物化后的动态编号集合（当前用于 FAQ）。只认 en 中同时存在的 qN/aN，parity 门守三语同形。 */
export function numberedTranslationPairs(section: string): number[] {
  const value = section.split('.').reduce<unknown>((cur, part) => {
    if (typeof cur !== 'object' || cur === null) return undefined;
    return (cur as Record<string, unknown>)[part];
  }, dicts.en);
  if (typeof value !== 'object' || value === null) return [];
  const record = value as Record<string, unknown>;
  return Object.keys(record)
    .map((key) => /^q(\d+)$/.exec(key))
    .filter((match): match is RegExpExecArray => Boolean(match && typeof record[`a${match[1]}`] === 'string'))
    .map((match) => Number(match[1]))
    .sort((a, b) => a - b);
}
