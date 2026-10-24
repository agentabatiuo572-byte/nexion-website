import { describe, expect, it } from 'vitest';
import { LOCALES } from '../../schema/src/locales';
import { historicalContentLabel } from '../src/lib/historical-content-label';
import { changeGroup, fieldName, humanPath } from '../src/lib/human-path';
import { fieldEditorLink, parseFieldTarget } from '../src/lib/field-target';

describe('historical token link labels', () => {
  it.each([
    ['/nex', '/uvt'], ['/nex/', '/uvt/'], ['/learn/staking-nex', '/learn/staking-uvt'],
    ['/learn/staking-nex/', '/learn/staking-uvt/'], ['staking-nex', 'staking-uvt'], ['staking-nex/', 'staking-uvt/'],
    ...LOCALES.flatMap(locale => [
      [`/${locale}/nex/`, `${locale === 'en' ? '' : '/' + locale}/uvt/`],
      [`/${locale}/learn/staking-nex`, `${locale === 'en' ? '' : '/' + locale}/learn/staking-uvt`],
    ]),
  ])('labels %s as %s, with an explicitly historical original', (original, label) => {
    expect(historicalContentLabel(original)).toEqual({ label, legacy: true, title: `历史原链接：${original}` });
  });

  it.each(['/uvt/', 'staking-uvt', '/NexGrid/', '/nexgrid/', '/nexion/', '/vi/nexion/', '/xx/nex/',
    '/nex/child/', '/learn/staking-nexion/', 'staking-nex-extra', '/learn/staking-nex-extra/',
    'https://example.com/nex/', '/search/?q=nex', '/nex/?q=unrecognized', '/unrelated/nex/', 'nex'])
  ('preserves unrelated or noncanonical historical identity %s', value => {
    expect(historicalContentLabel(value)).toEqual({ label: value, legacy: false, title: value });
  });
});

describe('legacy token field display', () => {
  it.each(LOCALES)('uses current UVT labels for %s legacy copy and SEO paths without changing editor targets', locale => {
    for (const [oldKey, key] of [['nex.pageTitle', 'uvt.pageTitle'], ['nav.nex', 'nav.uvt'],
      ['learn.topics.nex', 'learn.topics.uvt'], ['nex.cmpTypeNex', 'uvt.cmpTypeUvt'],
      ['nex.cmpVolNex', 'uvt.cmpVolUvt'], ['nex.cmpUseNex', 'uvt.cmpUseUvt']]) {
      const path = `copy.${locale}.${oldKey}`, currentPath = `copy.${locale}.${key}`;
      expect(humanPath(path)).toBe(humanPath(currentPath));
      expect(humanPath(path)).toContain('UVT');
      expect(humanPath(`/copy/${locale}/${oldKey}`)).toBe(humanPath(currentPath));
      expect(changeGroup(path)).toBe(changeGroup(currentPath));
      expect(parseFieldTarget(path).canonical).toBe(path);
      expect(fieldEditorLink(path)).toBe('/content?focus=' + encodeURIComponent(path));
    }
    const seo = `seo.pages.nex.title.${locale}`;
    expect(humanPath(seo)).toBe(humanPath(`seo.pages.uvt.title.${locale}`));
    expect(humanPath(`/seo/pages/nex/title/${locale}`)).toBe(humanPath(`seo.pages.uvt.title.${locale}`));
    expect(fieldEditorLink(seo)).toBe('/content/seo?focus=' + encodeURIComponent(seo));
  });

  it('does not substitute a brand or arbitrary field containing a similar substring', () => {
    for (const key of ['NexGrid', 'nexgrid', 'Nexion', 'nexion', 'nexExtra', 'cmpTypeNexion']) expect(fieldName(key)).toBe(key);
    expect(humanPath('copy.en.nexion.title')).toContain('nexion');
    expect(changeGroup('copy.en.nex.pageTitle')).toBe('UVT');
    expect(fieldName('nex')).toBe(fieldName('uvt'));
  });
});
