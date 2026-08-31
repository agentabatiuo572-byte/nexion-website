import { expandFaqPaths, isCollectionBacked, unflatten, type CopyManifest, type Nested } from './manifest.js';
import { LOCALES, SCHEMA_VERSION, type Locale, type SiteConfig } from './site-config.js';

/* 物化器(CON16-A1/A2):SiteConfig → 站构建消费物。
   字节稳定契约:JSON 2 空格缩进 + LF + 收尾换行,嵌套顺序=各语言清单原文件顺序;
   集合背书位(faq.qN·aN、devices.tagline.*)由集合按 sort 序回填。
   等价性基线(§6-4):种子配置物化 ≡ 仓内现文件逐字节一致——gate:equivalence 守。 */

export function serialize(obj: unknown): string {
  return JSON.stringify(obj, null, 2) + '\n';
}

function visibleFaq(c: SiteConfig) {
  return c.faq.items.filter((i) => i.visible).sort((a, b) => a.sort - b.sort);
}

/** 单语言 i18n JSON 物化 */
export function materializeI18n(c: SiteConfig, manifest: CopyManifest, locale: Locale): string {
  const faq = visibleFaq(c);
  const paths = expandFaqPaths(manifest[locale].paths, faq.length);
  const skuById = new Map(c.skus.map((s) => [s.id, s]));
  const nested: Nested = unflatten(paths, (p) => {
    if (!isCollectionBacked(p)) return c.copy[locale][p];
    const mFaq = /^faq\.(q|a)(\d+)$/.exec(p);
    if (mFaq) {
      const item = faq[Number(mFaq[2]) - 1];
      if (!item) return undefined;
      return mFaq[1] === 'q' ? item.q[locale] : item.a[locale];
    }
    const mTag = /^devices\.tagline\.(.+)$/.exec(p);
    if (mTag) return skuById.get(mTag[1]!)?.tagline[locale];
    return undefined;
  });
  return serialize(nested);
}

/** 站点结构化配置(src/config/site.json):stats/skus/downloads 现消费,其余字段随包⑥ 渐进接线 */
export function materializeSiteJson(c: SiteConfig): string {
  const site = {
    schemaVersion: SCHEMA_VERSION,
    stats: c.stats,
    skus: c.skus
      .filter((s) => s.visible)
      .sort((a, b) => a.sort - b.sort)
      .map(({ id, name, priceUSD, multiplier, status, free }) => ({ id, name, priceUSD, multiplier, status, ...(free ? { free } : {}) })),
    downloads: c.downloads,
    announcement: c.announcement,
    seo: c.seo,
    footer: c.footer,
  };
  return serialize(site);
}

export interface Materialized {
  i18n: Record<Locale, string>;
  siteJson: string;
}
export function materializeAll(c: SiteConfig, manifest: CopyManifest): Materialized {
  return {
    i18n: Object.fromEntries(LOCALES.map((l) => [l, materializeI18n(c, manifest, l)])) as Record<Locale, string>,
    siteJson: materializeSiteJson(c),
  };
}
