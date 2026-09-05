export interface GeoRulesValue {
  enabled: boolean;
  countries: string[];
  blockPage: { title: { zh: string; en: string }; body: { zh: string; en: string } };
}

/** updatedAt/updatedBy 是服务端元数据，不参与“回读是否等于本次意图”的判断。 */
export function sameGeoRules(a: GeoRulesValue | null | undefined, b: GeoRulesValue | null | undefined): boolean {
  if (!a || !b) return false;
  return a.enabled === b.enabled
    && a.countries.length === b.countries.length
    && a.countries.every((country, index) => country === b.countries[index])
    && a.blockPage.title.zh === b.blockPage.title.zh
    && a.blockPage.title.en === b.blockPage.title.en
    && a.blockPage.body.zh === b.blockPage.body.zh
    && a.blockPage.body.en === b.blockPage.body.en;
}
