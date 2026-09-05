-- 日汇总坏事件隔离账：保留原始载荷与重复尝试次数，避免损坏、非对象或字段形状非法的事件阻断整日合法事件。
-- 不设 raw_events 外键；raw_events 90 天清理后，本表仍需保留可审计证据。
CREATE TABLE rollup_rejected_events (
  raw_event_id INTEGER PRIMARY KEY,
  event_ts INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  date TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('invalid-json', 'non-object-json', 'invalid-event-shape')),
  validator_fingerprint TEXT NOT NULL,
  payload TEXT NOT NULL,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 1 CHECK (attempts >= 1)
);

CREATE INDEX idx_rollup_rejected_date ON rollup_rejected_events (date, raw_event_id);
CREATE INDEX idx_rollup_rejected_last_seen ON rollup_rejected_events (last_seen_at);
