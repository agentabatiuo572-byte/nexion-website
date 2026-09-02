-- 驾驶舱内容榜与质量卡缺的两张日汇总表(PRD CON03-③ 要求「页面 PV 榜」与「404 命中」,
-- 但 §5.3 九表没有承载面——2026-08-31 包⑧ 补齐;raw_events 90 天会滚掉,榜单必须落永久日表)。
CREATE TABLE daily_page (
  date TEXT NOT NULL, path TEXT NOT NULL, locale TEXT NOT NULL,
  pv INTEGER NOT NULL DEFAULT 0, uv INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (date, path, locale)
);
CREATE TABLE daily_notfound (
  date TEXT NOT NULL, path TEXT NOT NULL,
  hits INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (date, path)
);
