-- Widen only the provider constraint. Copy every control, credential, lease and usage value.
-- D1 applies a migration transactionally; no credential re-encryption is needed for Zen.
CREATE TABLE ai_connection_next (
  id INTEGER PRIMARY KEY CHECK (id=1),
  provider TEXT NOT NULL DEFAULT 'zen' CHECK (provider IN ('zen','gemini')),
  model TEXT NOT NULL DEFAULT 'gpt-5.4-mini',
  root_initialized INTEGER NOT NULL DEFAULT 0,
  credential_rev INTEGER NOT NULL DEFAULT 0,
  settings_rev INTEGER NOT NULL DEFAULT 0,
  execution_rev INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0,1)),
  key_ciphertext TEXT,
  key_iv TEXT,
  key_version INTEGER,
  connection_status TEXT NOT NULL DEFAULT 'unconfigured',
  last_test_at INTEGER,
  operation_seq INTEGER NOT NULL DEFAULT 0,
  operation_id TEXT,
  operation_status TEXT NOT NULL DEFAULT 'none',
  operation_error TEXT,
  operation_kind TEXT,
  call_lease_token TEXT,
  call_lease_until INTEGER,
  call_sent INTEGER NOT NULL DEFAULT 0,
  call_purpose TEXT,
  call_day TEXT,
  call_characters INTEGER NOT NULL DEFAULT 0,
  usage_day TEXT NOT NULL DEFAULT '',
  daily_character_limit INTEGER NOT NULL DEFAULT 50000,
  sent_characters INTEGER NOT NULL DEFAULT 0,
  call_count INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  unknown_usage_count INTEGER NOT NULL DEFAULT 0,
  test_day TEXT NOT NULL DEFAULT '',
  test_count INTEGER NOT NULL DEFAULT 0,
  next_test_at INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0
);
INSERT INTO ai_connection_next (
  id,provider,model,root_initialized,credential_rev,settings_rev,execution_rev,enabled,
  key_ciphertext,key_iv,key_version,connection_status,last_test_at,operation_seq,operation_id,
  operation_status,operation_error,operation_kind,call_lease_token,call_lease_until,call_sent,
  call_purpose,call_day,call_characters,usage_day,daily_character_limit,sent_characters,call_count,
  input_tokens,output_tokens,unknown_usage_count,test_day,test_count,next_test_at,updated_at
)
SELECT
  id,provider,model,root_initialized,credential_rev,settings_rev,execution_rev,enabled,
  key_ciphertext,key_iv,key_version,connection_status,last_test_at,operation_seq,operation_id,
  operation_status,operation_error,operation_kind,call_lease_token,call_lease_until,call_sent,
  call_purpose,call_day,call_characters,usage_day,daily_character_limit,sent_characters,call_count,
  input_tokens,output_tokens,unknown_usage_count,test_day,test_count,next_test_at,updated_at
FROM ai_connection;
DROP TABLE ai_connection;
ALTER TABLE ai_connection_next RENAME TO ai_connection;
