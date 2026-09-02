/* 平台数字的线性增长公式 —— 站上、后台预览、门,三处共用这一份。

   🔴 主人 2026-09-01 拍板:平台数字**全部后台模拟,不接真实数据**,但要有线性增长机制。
   于是配置里存的是「起算日那天的值 + 每日增量」,而不是一个写死的数。

   为什么公式住在 schema 而不是站上:站上要用它渲染、后台要用它预览「今天显示多少」、
   门要用它判「配置合不合理」。三处各写一份必漂 —— 这正是本项目反复踩过的那一族
   (见 docs/changes/2026-09-01-cross-surface-string-structural-reflection.md)。 */

export interface StatsGrowth {
  enabled: boolean;
  since: string; // YYYY-MM-DD
  daily: { activeDevices: number; activeJobs: number; nodes: number; countries: number };
}

export type GrowingKey = keyof StatsGrowth['daily'];

/** 起算日到 `now` 的整天数;起算日在未来时按 0(不倒着算) */
export function daysSince(since: string, now: number): number {
  const t0 = Date.parse(`${since}T00:00:00Z`);
  if (!Number.isFinite(t0)) return 0;
  return Math.max(0, Math.floor((now - t0) / 86_400_000));
}

/** 某个字段今天该显示的值。关掉增长、没配、或该字段没有日增量 → 原样返回基准值。 */
export function grownValue(base: number, key: GrowingKey, growth: StatsGrowth | undefined, now: number): number {
  if (!growth?.enabled) return base;
  const per = growth.daily?.[key];
  if (!per) return base;
  return Math.round(base + per * daysSince(growth.since, now));
}
