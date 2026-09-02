-- 驾驶舱验收三条 P1 的承载面(2026-08-31):
-- P1-1 下载链接定时探活(PRD CON03-③「cron 每 6h HEAD 已启用下载 URL」+ E3 运营健康红条)——此前只有按需按钮,无定时、无存储、无红条。
CREATE TABLE probe_status (
  target TEXT PRIMARY KEY,        -- ios | android | h5
  url TEXT NOT NULL,
  ok INTEGER NOT NULL,            -- 1 可达 / 0 不可达
  status INTEGER NOT NULL DEFAULT 0,
  fail_streak INTEGER NOT NULL DEFAULT 0,  -- 连续失败次数(E3 判据:≥2 次红条)
  checked_at INTEGER NOT NULL
);
-- P1-3 Bot 占比口径:daily_bot 只存 bot_share(比例),按期间聚合只能求日均值——那是「日均占比」不是「期间请求占比」,
-- 实测差近 2 倍还印成精确小数。存分子分母,期间占比 = SUM(bot_pv)/SUM(bot_pv+human_pv)。
ALTER TABLE daily_bot ADD COLUMN bot_pv INTEGER NOT NULL DEFAULT 0;
ALTER TABLE daily_bot ADD COLUMN human_pv INTEGER NOT NULL DEFAULT 0;
