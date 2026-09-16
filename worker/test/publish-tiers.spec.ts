import { describe, expect, it } from 'vitest';
import { classifyChangedPaths } from '../../schema/src/publish-tiers.js';

describe('classifyChangedPaths', () => {
  it('纯文案改动判 content-only', () => {
    expect(classifyChangedPaths([
      'copy.zh.hero.scrollHint',
      'copy.en.trust.title',
      'faq.items[2].answer.zh',
      'skus[0].tagline.en',
      'announcement.text.vi',
      'seo.pages.home.title.zh',
      'legal.terms.md.en',
      'legal.privacy.updatedAt',
      'footer.contactEmail',
    ])).toBe('content-only');
  });

  it('结构/数值/开关改动判 config-shape', () => {
    for (const paths of [
      ['enabledLocales'],
      ['stats.growth.daily.nodes'],
      ['skus[0].priceUSD'],
      ['skus[1].status'],
      ['announcement.enabled'],
      ['announcement.href'],
      ['downloads.ios.url'],
      ['seo.pages.home.title.zh', 'skus[0].priceUSD'],
    ]) expect(classifyChangedPaths(paths)).toBe('config-shape');
  });

  it('空改动与未知路径 fail-closed 按全量', () => {
    expect(classifyChangedPaths([])).toBe('config-shape');
    expect(classifyChangedPaths(['some.future.field'])).toBe('config-shape');
  });
});
