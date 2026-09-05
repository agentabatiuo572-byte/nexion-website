-- Durable idempotency ledger for Geo rule PUTs. One operation id is permanently
-- bound to one normalized request digest and its original deterministic result.
CREATE TABLE IF NOT EXISTS geo_rule_operations (
  operation_id TEXT PRIMARY KEY,
  request_fingerprint TEXT NOT NULL CHECK (length(request_fingerprint) = 64),
  result_rules TEXT NOT NULL CHECK (json_valid(result_rules)),
  result_fingerprint TEXT NOT NULL CHECK (length(result_fingerprint) = 64),
  result_version INTEGER NOT NULL CHECK (result_version > 0),
  status TEXT NOT NULL CHECK (status IN ('pending', 'applied')),
  created_at INTEGER NOT NULL,
  applied_at INTEGER
);

-- Preserve the latest pre-ledger operation when the immediately preceding
-- rollout already persisted its request digest inside the authoritative rules.
INSERT OR IGNORE INTO geo_rule_operations (
  operation_id, request_fingerprint, result_rules, result_fingerprint,
  result_version, status, created_at, applied_at
)
SELECT
  json_extract(current_rules, '$.updateOperationId'),
  json_extract(current_rules, '$.updateRequestFingerprint'),
  current_rules,
  current_fingerprint,
  version,
  CASE
    WHEN status = 'pending'
      AND pending_operation_id = json_extract(current_rules, '$.updateOperationId')
    THEN 'pending'
    ELSE 'applied'
  END,
  COALESCE(json_extract(current_rules, '$.updatedAt'), 0),
  CASE WHEN status = 'ready' THEN COALESCE(json_extract(current_rules, '$.updatedAt'), 0) ELSE NULL END
FROM geo_rule_state
WHERE json_valid(current_rules) = 1
  AND json_type(current_rules, '$.updateOperationId') = 'text'
  AND json_type(current_rules, '$.updateRequestFingerprint') = 'text'
  AND length(json_extract(current_rules, '$.updateRequestFingerprint')) = 64;
