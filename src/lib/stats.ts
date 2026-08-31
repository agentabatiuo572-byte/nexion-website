/* [FEAT-WEB03] 平台统计数据契约 — server-canonical,字段名与 App PRD §12 线名一致。
   双模:snapshot(v1 默认,构建期常量)/ sse(接真后端 GET+SSE /api/platform/stats)。
   降级链(PRD WEB03 异常1/2):sse 失败 → 无缝回快照(不闪不清零)。
   🔴 快照单源 = 官网后台配置(2026-08-31 CON06/CON16 接管:src/config/site.json 由控制台
   配置物化,禁在此手改数字)。种子期数值 = App 锚字面镜像(28_432/4_812/156/47/99.7,
   出处见官网后台 PRD CON06);上线前主人在控制台真值化——R49-F1 生产门拦截仍等于锚值的快照。
   R45(主人拍板 B8):千分位/小数点随语言;价格(USD)保持国际 $ 写法,见 skus.ts。 */
import site from '../config/site.json';
import type { Locale } from '../i18n';

export interface PlatformStats {
  activeDevices: number;
  activeJobs: number;
  nodes: number;
  countries: number;
  uptime: number;
}

export const STATS_SNAPSHOT: PlatformStats = {
  activeDevices: site.stats.activeDevices,
  activeJobs: site.stats.activeJobs,
  nodes: site.stats.nodes,
  countries: site.stats.countries,
  uptime: site.stats.uptime,
};

/** 快照口径日(展示 "Data as of" 小字;随控制台配置物化) */
export const STATS_SNAPSHOT_AT = site.stats.asOf;

export type StatsMode = 'snapshot' | 'sse';

export function statsMode(): StatsMode {
  return import.meta.env.PUBLIC_STATS_MODE === 'sse' && import.meta.env.PUBLIC_STATS_URL ? 'sse' : 'snapshot';
}

/** 数字格式的 BCP-47 标签:vi 千分位 `.` 小数 `,`;zh/en 同 en-US 分组 */
export function localeTag(locale: Locale): string {
  return locale === 'vi' ? 'vi-VN' : locale === 'zh' ? 'zh-CN' : 'en-US';
}

/** 数字展示:<100K 千分位;≥99,950 起 K/M 化(阈值语义同 App compactNumber,防 999.9K 假进位) */
export function fmtStat(n: number, decimals = 0, locale: Locale = 'en'): string {
  if (!Number.isFinite(n)) return '';
  const tag = localeTag(locale);
  if (n >= 999_500) return `${(n / 1_000_000).toLocaleString(tag, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}M`;
  if (n >= 99_950) return `${(n / 1_000).toLocaleString(tag, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}K`;
  return n.toLocaleString(tag, { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}
