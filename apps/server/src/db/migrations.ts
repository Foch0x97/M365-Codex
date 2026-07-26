/**
 * 数据库迁移定义。
 *
 * 迁移只增不改：已发布的迁移不得原地修改，只能追加新版本。
 * 每个里程碑补齐自己需要的表，避免提前建出无人使用的空表。
 */

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

const M001_CORE = `
-- 通用键值设置表
CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- 对外 API Key。库中只存哈希与索引前缀，不存明文。
CREATE TABLE api_keys (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  prefix            TEXT NOT NULL,
  salt              TEXT NOT NULL,
  hash              TEXT NOT NULL,
  enabled           INTEGER NOT NULL DEFAULT 1,
  revoked_at        INTEGER,
  starts_at         INTEGER,
  expires_at        INTEGER,
  rpm_limit         INTEGER,
  daily_limit       INTEGER,
  max_concurrency   INTEGER,
  allowed_endpoints TEXT,
  allowed_models    TEXT,
  created_at        INTEGER NOT NULL,
  last_used_at      INTEGER,
  last_used_ip      TEXT
);
CREATE INDEX idx_api_keys_prefix ON api_keys (prefix);
CREATE INDEX idx_api_keys_enabled ON api_keys (enabled);

-- 管理端会话。只存会话令牌的哈希。
CREATE TABLE admin_sessions (
  id           TEXT PRIMARY KEY,
  token_hash   TEXT NOT NULL UNIQUE,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  last_seen_at INTEGER,
  client_ip    TEXT
);
CREATE INDEX idx_admin_sessions_expires_at ON admin_sessions (expires_at);

-- 审计日志：管理侧的敏感操作留痕，不记录任何凭据内容。
CREATE TABLE audit_logs (
  id         TEXT PRIMARY KEY,
  actor      TEXT NOT NULL,
  action     TEXT NOT NULL,
  target     TEXT,
  detail     TEXT,
  client_ip  TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_audit_logs_created_at ON audit_logs (created_at);
`;

export const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: 'core_settings_apikeys_admin_audit', sql: M001_CORE },
];

export const LATEST_SCHEMA_VERSION: number = MIGRATIONS.reduce(
  (max, migration) => Math.max(max, migration.version),
  0,
);
