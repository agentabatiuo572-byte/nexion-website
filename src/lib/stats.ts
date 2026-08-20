/* [FEAT-WEB03] 平台统计数据契约 — server-canonical,字段名与 App PRD §12 线名一致。
   双模:snapshot(v1 默认,构建期常量)/ sse(接真后端 GET+SSE /api/platform/stats)。
   降级链(PRD WEB03 异常1/2):sse 失败 → 无缝回快照(不闪不清零);快照在 v1 为编译期
   常量恒存在(异常2「快照缺失→整条隐藏」在 snapshot 模式不可达,SSE-only 部署才可能)。
   🔴 快照值 = App 单源锚的字面镜像,禁自造数字(mock-real-compatible):
     activeDevices ← Nexion-uniapp/src/lib/platform-stats.ts FLEET_DEVICES(28_432)
     activeJobs    ← Nexion-uniapp/src/store/app.ts L221 ACTIVE_JOBS_SEED(4_812)
     nodes/countries/uptime ← 同文件 L226-228(156 / 47 / 99.7)
   快照口径日 2026-08-20;App 锚变更时同步此处(值不同步=同品牌两套口径,回归级)。 */

export interface PlatformStats {
  activeDevices: number;
  activeJobs: number;
  nodes: number;
  countries: number;
  uptime: number;
}

export const STATS_SNAPSHOT: PlatformStats = {
  activeDevices: 28_432,
  activeJobs: 4_812,
  nodes: 156,
  countries: 47,
  uptime: 99.7,
};

/** 快照口径日(展示 "Data as of" 小字;更新快照时同步) */
export const STATS_SNAPSHOT_AT = '2026-08';

export type StatsMode = 'snapshot' | 'sse';

export function statsMode(): StatsMode {
  return import.meta.env.PUBLIC_STATS_MODE === 'sse' && import.meta.env.PUBLIC_STATS_URL ? 'sse' : 'snapshot';
}

/** 数字展示:<100K 千分位;≥99,950 起 K/M 化(阈值语义同 App compactNumber,防 999.9K 假进位) */
export function fmtStat(n: number, decimals = 0): string {
  if (!Number.isFinite(n)) return '';
  if (n >= 999_500) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 99_950) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}
