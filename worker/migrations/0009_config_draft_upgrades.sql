-- Preserve the exact pre-upgrade draft and bind the one-time marker to its row.
-- Published version payloads are immutable and are never migrated in place.
CREATE TABLE config_draft_upgrades (
  draft_id INTEGER NOT NULL REFERENCES config_draft(id) ON DELETE CASCADE,
  upgrade_key TEXT NOT NULL,
  original_payload TEXT NOT NULL,
  original_rev INTEGER NOT NULL,
  upgraded_rev INTEGER NOT NULL,
  applied_at INTEGER NOT NULL,
  commit_nonce TEXT NOT NULL,
  PRIMARY KEY (draft_id, upgrade_key)
);
