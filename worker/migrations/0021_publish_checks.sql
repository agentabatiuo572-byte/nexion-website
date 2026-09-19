-- 发布检查明细（绿色科技风进度窗的数据源）。
-- publish_steps.detail 只存“当前窗口”（6000 字符上限且被覆盖），本表按 version 追加检查行：
-- runner 在 begin/passed/onProgress/onCommand-end 四个真实点 INSERT，status 接口按 version 返回。
-- 旧 detail 保持“当前窗口”语义不动，做向后兼容。
CREATE TABLE publish_checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  version_id INTEGER NOT NULL,
  step TEXT NOT NULL,                -- materialize | gates | build | swap
  seq INTEGER NOT NULL,              -- 同版本内单调递增，由服务端分配
  title TEXT NOT NULL,               -- 检查标题（人类可读，如门名/阶段动作）
  status TEXT NOT NULL,              -- running | ok | failed | skipped | unknown
  output TEXT,                       -- 机器原文/日志尾（可空，UI 折叠展示）
  started_at INTEGER NOT NULL,
  ended_at INTEGER
);
CREATE INDEX idx_checks_version ON publish_checks (version_id, seq, id);
CREATE UNIQUE INDEX idx_checks_version_seq ON publish_checks (version_id, seq);
CREATE INDEX idx_checks_step ON publish_checks (version_id, step, seq);
