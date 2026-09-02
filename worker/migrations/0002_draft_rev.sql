-- 草稿乐观锁计数(CON04-E3:双标签页后保存者 409)
ALTER TABLE config_draft ADD COLUMN draft_rev INTEGER NOT NULL DEFAULT 1;
