-- 官网后台 D1 初始结构。契约:PRD §5(SiteConfig/事件/日汇总)+ CON01/13/14。
-- 命名与 PRD §5.3 一致;原始事件 90 天滚动清理由每日 cron 负责(T6)。

-- ===== 配置与发布(CON13)=====
CREATE TABLE config_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  status TEXT NOT NULL,               -- validating|publishing|live|failed(draft 单独存 config_draft)
  payload TEXT NOT NULL,              -- SiteConfig 全量快照(JSON)
  reason TEXT,                        -- 高敏发布理由
  fail_reason TEXT,                   -- 门红时的机器原因(映射为大白话在 API 层)
  created_by TEXT NOT NULL DEFAULT 'admin',
  created_at INTEGER NOT NULL,        -- ms epoch
  published_at INTEGER
);

CREATE TABLE config_draft (
  id INTEGER PRIMARY KEY CHECK (id = 1),  -- 单行草稿
  payload TEXT NOT NULL,
  base_revision INTEGER NOT NULL,         -- 乐观锁(CON04-E3)
  updated_at INTEGER NOT NULL
);

-- ===== 审计(CON14,append-only:无 UPDATE/DELETE 路径)=====
CREATE TABLE audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  actor TEXT NOT NULL DEFAULT 'admin',
  action TEXT NOT NULL,               -- 动作字典见 PRD CON14-③
  target TEXT,
  before_summary TEXT,
  after_summary TEXT,
  reason TEXT
);
CREATE INDEX idx_audit_ts ON audit (ts);
CREATE INDEX idx_audit_action ON audit (action, ts);

-- ===== 认证(CON01)=====
CREATE TABLE auth_account (
  id INTEGER PRIMARY KEY CHECK (id = 1), -- 单管理员
  password_hash TEXT NOT NULL,           -- PBKDF2-SHA256 ≥600k
  salt TEXT NOT NULL,
  initialized_at INTEGER NOT NULL
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,           -- 会话令牌只存哈希
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL            -- 7 天滑动续期
);

CREATE TABLE login_throttle (
  key TEXT PRIMARY KEY,                  -- ip 维度
  fail_count INTEGER NOT NULL DEFAULT 0,
  window_start INTEGER NOT NULL,
  locked_until INTEGER
);

-- ===== 原始事件(§5.2;90 天滚动清理)=====
CREATE TABLE raw_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  type TEXT NOT NULL,                    -- pv|sec|cta|faq|learn|vit|err|blocked
  uid TEXT,                              -- 当日盐哈希 16hex;blocked 无 uid
  payload TEXT NOT NULL                  -- 各类型契约字段(JSON,json_extract 汇总)
);
CREATE INDEX idx_events_ts ON raw_events (ts);
CREATE INDEX idx_events_type_ts ON raw_events (type, ts);

-- ===== 日汇总 9 表(§5.3;永久保留)=====
CREATE TABLE daily_traffic (
  date TEXT NOT NULL, locale TEXT NOT NULL, country TEXT NOT NULL,
  device TEXT NOT NULL, ref_class TEXT NOT NULL,
  pv INTEGER NOT NULL DEFAULT 0, uv INTEGER NOT NULL DEFAULT 0, sessions INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (date, locale, country, device, ref_class)
);
CREATE TABLE daily_cta (
  date TEXT NOT NULL, cta_id TEXT NOT NULL, locale TEXT NOT NULL,
  clicks INTEGER NOT NULL DEFAULT 0, uniq INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (date, cta_id, locale)
);
CREATE TABLE daily_section (
  date TEXT NOT NULL, section_id TEXT NOT NULL,
  uniq INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (date, section_id)
);
CREATE TABLE daily_faq (
  date TEXT NOT NULL, faq_id TEXT NOT NULL,
  opens INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (date, faq_id)
);
CREATE TABLE daily_learn (
  date TEXT NOT NULL, slug TEXT NOT NULL,
  reads INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (date, slug)
);
CREATE TABLE daily_vitals (
  date TEXT PRIMARY KEY,
  lcp_p75 REAL, cls_p75 REAL, n INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE daily_errors (
  date TEXT NOT NULL, msg_hash TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (date, msg_hash)
);
CREATE TABLE daily_blocked (
  date TEXT NOT NULL, country TEXT NOT NULL,
  hits INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (date, country)
);
CREATE TABLE daily_bot (
  date TEXT PRIMARY KEY,
  bot_share REAL NOT NULL DEFAULT 0
);
