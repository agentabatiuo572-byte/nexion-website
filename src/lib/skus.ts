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

/* 单源 = 官网后台配置物化(2026-08-31 CON07/CON16 接管):src/config/site.json 只含
   visible=true 的 SKU,已按控制台排序;结构由 schema zod 上游担保(status 枚举/字段全)。
   改阵容/价格走控制台(产品事实字段=高敏,须与 App PRD §7.1 一致),禁在此手改。 */
import site from '../config/site.json';

export const SKUS: WebSku[] = site.skus as WebSku[];

export function fmtPrice(n: number): string {
  return n === 0 ? '' : `$${n.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
}

export function fmtMultiplier(n: number, locale: Locale = 'en'): string {
  return `${n.toLocaleString(localeTag(locale))}×`;
}
