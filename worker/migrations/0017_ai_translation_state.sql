ALTER TABLE config_draft ADD COLUMN write_nonce TEXT;

CREATE TABLE translation_state (
  field_id TEXT NOT NULL,
  target_locale TEXT NOT NULL,
  origin TEXT NOT NULL CHECK (origin IN ('seed', 'ai', 'manual')),
  source_hash TEXT NOT NULL,
  observed_source_hash TEXT NOT NULL,
  applied_value_hash TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK (generation >= 1),
  deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1)),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (field_id, target_locale)
);

CREATE TABLE translation_jobs (
  id TEXT PRIMARY KEY,
  field_id TEXT NOT NULL,
  target_locale TEXT NOT NULL,
  generation INTEGER NOT NULL,
  intent TEXT NOT NULL CHECK (intent IN ('auto', 'manual')),
  source_text TEXT NOT NULL,
  context TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  target_value TEXT NOT NULL,
  credential_rev INTEGER,
  execution_rev INTEGER,
  model TEXT,
  rules_version TEXT NOT NULL DEFAULT '1',
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'succeeded', 'obsolete', 'cancelled', 'failed')),
  lease_token TEXT,
  lease_until INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  result TEXT,
  error_code TEXT,
  usage TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (field_id, target_locale, generation),
  FOREIGN KEY (field_id, target_locale) REFERENCES translation_state(field_id, target_locale)
);
CREATE INDEX translation_jobs_pending ON translation_jobs(status, next_attempt_at, created_at);
