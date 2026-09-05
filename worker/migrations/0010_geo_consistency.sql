-- D1 is the linearizable source of truth for Geo rules. KV is only the
-- eventually-consistent edge materialization. This migration deliberately
-- leaves the singleton row absent: deployment blocks ordinary writes until an
-- authenticated operator explicitly adopts the displayed legacy KV snapshot.
-- Deployment must quiesce the pre-0010 writer before that adoption; no read
-- from an eventually-consistent legacy key can prove which concurrent write
-- was newest. The INSERT below is the first linearizable authority decision.
CREATE TABLE geo_rule_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  status TEXT NOT NULL CHECK (status IN ('ready', 'pending')),
  current_rules TEXT NOT NULL,
  current_fingerprint TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  pending_kind TEXT CHECK (pending_kind IN ('bootstrap', 'update')),
  pending_operation_id TEXT UNIQUE,
  -- While pending, current_* is already the authoritative target. These two
  -- columns retain the exact prior authority for audit and reconciliation
  -- diagnostics; recovery never promotes a KV observation back into D1.
  pending_previous_rules TEXT,
  pending_previous_fingerprint TEXT,
  pending_started_at INTEGER,
  pending_before_summary TEXT,
  pending_after_summary TEXT,
  pending_reason TEXT,
  CHECK (
    (
      status = 'ready'
      AND pending_kind IS NULL AND pending_operation_id IS NULL
      AND pending_previous_rules IS NULL AND pending_previous_fingerprint IS NULL AND pending_started_at IS NULL
      AND pending_before_summary IS NULL AND pending_after_summary IS NULL AND pending_reason IS NULL
    )
    OR
    (
      status = 'pending'
      AND pending_kind IS NOT NULL AND pending_operation_id IS NOT NULL
      AND pending_previous_rules IS NOT NULL AND pending_previous_fingerprint IS NOT NULL AND pending_started_at IS NOT NULL
      AND pending_before_summary IS NOT NULL AND pending_after_summary IS NOT NULL AND pending_reason IS NOT NULL
    )
  )
);

-- A UNIQUE insert is the atomic one-time redemption primitive. Cloudflare KV
-- cannot provide this guarantee because its get -> put sequence is not CAS.
CREATE TABLE geo_bypass_redemptions (
  jti TEXT PRIMARY KEY,
  redeemed_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX idx_geo_bypass_redemptions_expires ON geo_bypass_redemptions (expires_at);
