/* [FEAT-WEB06] SKU 契约 — App PRD §7.1 商品表的官网镜像(本文件为唯一消费源)。
   🔴 不含收益字段(dailyUsdt/dailyNex 官网不拉取不展示,PRD §1.4-1);
   算力倍数(multiplier)为事实性展示。status 快照按 §7.1 表 status 列;
   'coming' 渲染逻辑保留(unlocksAtPhase 未达机型的预热态),当前快照无 coming 项
   ——官网无 App phase 状态面,不虚构上架节奏,接真接口后由 server 下发。
   快照口径日 2026-08-20;App PRD §7.1 表变更时同步此处。
   R45 B8:倍数千分位随语言;价格是 USD,保持国际 $1,199 写法不随语言变。 */
import type { Locale } from '../i18n';
import { localeTag } from './stats';

export interface WebSku {
  id: string;
  name: string;
  priceUSD: number;
  multiplier: number; // vs Phone 基准
  status: 'active' | 'legacy' | 'coming';
  free?: boolean;
}

export const SKUS: WebSku[] = [
  { id: 'phone', name: 'Phone', priceUSD: 0, multiplier: 1, status: 'active', free: true },
  { id: 'cloud-share', name: 'Cloud Share', priceUSD: 19.9, multiplier: 3, status: 'active' },
  { id: 's1', name: 'NexGridBox S1', priceUSD: 649, multiplier: 117, status: 'legacy' },
  { id: 'pro', name: 'NexGridBox Pro', priceUSD: 1_199, multiplier: 217, status: 'legacy' },
  { id: 'pro-v2', name: 'NexGridBox Pro v2', priceUSD: 1_319, multiplier: 233, status: 'active' },
  { id: 'rack-p1', name: 'NexGridRack P1', priceUSD: 4_499, multiplier: 750, status: 'legacy' },
  { id: 'rack-p2', name: 'NexGridRack P2', priceUSD: 7_499, multiplier: 1_250, status: 'active' },
];

export function fmtPrice(n: number): string {
  return n === 0 ? '' : `$${n.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
}

export function fmtMultiplier(n: number, locale: Locale = 'en'): string {
  return `${n.toLocaleString(localeTag(locale))}×`;
}
