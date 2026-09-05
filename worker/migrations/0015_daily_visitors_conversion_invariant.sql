-- Conversion visitors are a subset of all human visitors. Rebuild so existing
-- installations receive the same invariant as fresh databases.
CREATE TABLE daily_visitors_v2 (
  date TEXT PRIMARY KEY,
  uv INTEGER NOT NULL DEFAULT 0 CHECK (uv >= 0),
  sessions INTEGER NOT NULL DEFAULT 0 CHECK (sessions >= 0),
  cta_visitors INTEGER NOT NULL DEFAULT 0 CHECK (cta_visitors >= 0 AND cta_visitors <= uv),
  rollup_version INTEGER NOT NULL DEFAULT 0 CHECK (rollup_version >= 0)
);

-- A corrupt historical row aborts this migration instead of being clamped or discarded.
INSERT INTO daily_visitors_v2 (date, uv, sessions, cta_visitors, rollup_version)
SELECT date, uv, sessions, cta_visitors, rollup_version
FROM daily_visitors;

DROP TABLE daily_visitors;
ALTER TABLE daily_visitors_v2 RENAME TO daily_visitors;
