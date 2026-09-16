import assert from 'node:assert/strict';
import { LOCALES } from '../schema/src/locales.ts';
import { resolveEnabledLocales, localizedPath, localeNumberTag } from '../src/lib/locale-policy.ts';
assert.deepEqual(resolveEnabledLocales(undefined), [...LOCALES]);
assert.deepEqual(resolveEnabledLocales(['zh', 'en']), ['en', 'zh']);
assert.deepEqual(resolveEnabledLocales(['en']), ['en']);
for (const bad of [[], ['zh'], ['en', 'unknown'], ['en', 'en'], 'en', null]) assert.throws(() => resolveEnabledLocales(bad));
for (const locale of LOCALES) {
  assert.equal(localizedPath(locale, '/'), locale === 'en' ? '/' : `/${locale}/`);
  assert.equal(localizedPath(locale, '/learn/example/'), `${locale === 'en' ? '' : `/${locale}`}/learn/example/`);
  assert.doesNotThrow(() => new Intl.NumberFormat(localeNumberTag(locale)).format(12345.6));
}
console.log('[locale-policy] 36 pass');
