import { isLocale } from '../../../schema/src/locales.ts';

/** Presentation only: historical rows retain their identity, order and recorded counts. */
export function historicalContentLabel(value: string): { label: string; legacy: boolean; title: string } {
  let label = value;
  const path = /^\/(?:(?<locale>[a-z]{2})\/)?(?<page>nex|learn\/staking-nex)(?<slash>\/?)$/.exec(value);
  if (path && (!path.groups?.locale || isLocale(path.groups.locale))) {
    const locale = path.groups?.locale;
    const prefix = locale && locale !== 'en' ? `/${locale}` : '';
    label = `${prefix}/${path.groups?.page === 'nex' ? 'uvt' : 'learn/staking-uvt'}${path.groups?.slash}`;
  } else if (value === 'staking-nex' || value === 'staking-nex/') {
    label = value.replace('staking-nex', 'staking-uvt');
  }
  const legacy = label !== value;
  return { label, legacy, title: legacy ? `历史原链接：${value}` : value };
}
