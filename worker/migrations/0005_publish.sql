-- 发布流水线(PRD CON13):发布锁 + 步骤日志。版本表在 0001 已建。
CREATE TABLE publish_lock (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  version_id INTEGER NOT NULL,
  acquired_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL      -- TTL 15 分钟;超时自动释放并把该版标 failed(E3)
);
CREATE TABLE publish_steps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  version_id INTEGER NOT NULL,
  step TEXT NOT NULL,              -- materialize | gates | build | swap
  status TEXT NOT NULL,            -- running | ok | failed
  detail TEXT,                     -- 机器原文(门名/日志尾),UI 折叠展示
  started_at INTEGER NOT NULL,
  ended_at INTEGER
);
CREATE INDEX idx_steps_version ON publish_steps (version_id, id);
