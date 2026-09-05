-- Service readiness, durable dispatch and stable owner survive HTTP / process restarts.
CREATE TABLE publish_runner (
  runner_id TEXT PRIMARY KEY,
  last_seen_at INTEGER NOT NULL
);
ALTER TABLE config_versions ADD COLUMN runner_id TEXT;
CREATE TABLE publish_dispatch (
  version_id INTEGER PRIMARY KEY,
  state TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  last_error TEXT,
  run_id TEXT
);
