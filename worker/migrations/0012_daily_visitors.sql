-- Exact daily site-wide UV/session totals. Dimension rows cannot be summed without double-counting visitors.
CREATE TABLE daily_visitors (
  date TEXT PRIMARY KEY,
  uv INTEGER NOT NULL DEFAULT 0 CHECK (uv >= 0),
  sessions INTEGER NOT NULL DEFAULT 0 CHECK (sessions >= 0),
  cta_visitors INTEGER NOT NULL DEFAULT 0 CHECK (cta_visitors >= 0)
);
