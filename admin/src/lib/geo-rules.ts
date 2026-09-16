import { LOCALES } from '../../../schema/src/locales';
import type { Tri } from './use-draft';
export interface GeoRulesValue {
  enabled: boolean;
  countries: string[];
  blockPage: { title: Partial<Tri>; body: Partial<Tri> };
}

/** updatedAt/updatedBy 是服务端元数据，不参与“回读是否等于本次意图”的判断。 */
export function sameGeoRules(a: GeoRulesValue | null | undefined, b: GeoRulesValue | null | undefined): boolean {
  if (!a || !b) return false;
  return a.enabled === b.enabled
    && a.countries.length === b.countries.length
    && a.countries.every((country, index) => country === b.countries[index])
    && LOCALES.every((locale) => a.blockPage.title[locale] === b.blockPage.title[locale]
      && a.blockPage.body[locale] === b.blockPage.body[locale]);
}
