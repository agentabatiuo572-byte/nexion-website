-- Capture the exact draft revision in the same CAS insert as its publication payload.
-- Historical versions and rollback copies have no draft revision to infer.
ALTER TABLE config_versions ADD COLUMN source_draft_rev INTEGER CHECK(source_draft_rev IS NULL OR source_draft_rev > 0);
