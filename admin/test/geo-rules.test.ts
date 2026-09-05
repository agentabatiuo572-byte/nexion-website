import { describe, expect, it } from 'vitest';
import { sameGeoRules, type GeoRulesValue } from '../src/lib/geo-rules';

const rules = (): GeoRulesValue => ({
  enabled: true,
  countries: ['CN'],
  blockPage: { title: { zh: '标题', en: 'Title' }, body: { zh: '正文', en: 'Body' } },
});

describe('sameGeoRules', () => {
  it('confirms a response-loss write only when readback matches the attempted rule', () => {
    expect(sameGeoRules(rules(), rules())).toBe(true);
    expect(sameGeoRules({ ...rules(), enabled: false }, rules())).toBe(false);
  });
});
