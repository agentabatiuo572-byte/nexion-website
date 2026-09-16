import assert from 'node:assert/strict';
import { LOCALES } from '../schema/src/locales.ts';
import { i18nParity } from './gate-i18n-parity.mjs';

let checks = 0;
const check = (condition) => { assert.ok(condition); checks++; };
const dictionaries = () => Object.fromEntries(LOCALES.map((locale) => [locale, {
  section: { title: 'Title', count: 'Count {n}', optional: '' },
}]));
for (const enabled of [['en', 'vi'], [...LOCALES], ['en', 'vi', 'zh']]) {
  const dicts = dictionaries();
  for (const locale of LOCALES.filter((locale) => !enabled.includes(locale))) {
    dicts[locale].section.title = '';
    dicts[locale].section.count = '';
  }
  check(i18nParity(dicts, enabled).length === 0);
  for (const locale of enabled.filter((locale) => locale !== 'en')) {
    const empty = structuredClone(dicts);
    empty[locale].section.title = ' ';
    check(i18nParity(empty, enabled).some((line) => line.includes(`${locale}.section.title`)));
    const mismatch = structuredClone(dicts);
    mismatch[locale].section.count = 'Count {wrong}';
    check(i18nParity(mismatch, enabled).some((line) => line.includes(`${locale}.section.count`)));
  }
  // 🔴 全量档([..LOCALES])没有禁用语言:缺-key/多-key/旧值三条只在有禁用语言时可测,跳过。
  const disabled = LOCALES.find((locale) => !enabled.includes(locale));
  if (disabled) {
    const missing = structuredClone(dicts);
    delete missing[disabled].section.count;
    check(i18nParity(missing, enabled).some((line) => line.includes(`${disabled} 缺 key`)));
    const extra = structuredClone(dicts);
    extra[disabled].section.extra = '';
    check(i18nParity(extra, enabled).some((line) => line.includes(`${disabled} 多出 key`)));
    const authored = structuredClone(dicts);
    authored[disabled].section.count = 'Count {wrong}';
    check(i18nParity(authored, enabled).some((line) => line.includes(`${disabled}.section.count`)));
  }
}
check(i18nParity(dictionaries(), undefined).length === 0);
const missingDefault = dictionaries();
missingDefault.ko.section.title = '';
check(i18nParity(missingDefault, undefined).some((line) => line.includes('ko.section.title')));
assert.throws(() => i18nParity(dictionaries(), ['vi'])); checks++;
const malformed = dictionaries();
malformed.en.section.title = 123;
malformed.zh.section.extra = null;
check(i18nParity(malformed, ['en', 'vi']).some((line) => line.includes('en.section.title')));
check(i18nParity(malformed, ['en', 'vi']).some((line) => line.includes('zh 多出 key')));
console.log(`[i18n-parity] ${checks} pass`);
