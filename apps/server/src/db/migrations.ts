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

const M002_ACCOUNTS = `
-- Microsoft 账号。同一 (租户, 对象) 只保留一条，重复授权走更新而非新增。
CREATE TABLE accounts (
  id            TEXT PRIMARY KEY,
  tid           TEXT NOT NULL,
  oid           TEXT NOT NULL,
  email         TEXT,
  display_name  TEXT,
  status        TEXT NOT NULL DEFAULT 'probing',
  proxy_node_id TEXT,
  source        TEXT NOT NULL DEFAULT 'oauth',
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  UNIQUE (tid, oid)
);
CREATE INDEX idx_accounts_status ON accounts (status);

-- 账号 Token。access/refresh 均以 AES-256-GCM 加密存储，各自独立 nonce。
CREATE TABLE account_tokens (
  account_id        TEXT PRIMARY KEY REFERENCES accounts (id) ON DELETE CASCADE,
  access_token_enc  BLOB,
  access_nonce      BLOB,
  refresh_token_enc BLOB,
  refresh_nonce     BLOB,
  key_version       INTEGER NOT NULL,
  expires_at        INTEGER,
  rotated_at        INTEGER
);

-- 账号健康度。调度器据此做冷却与择优，M3 会继续扩展。
CREATE TABLE account_health (
  account_id           TEXT PRIMARY KEY REFERENCES accounts (id) ON DELETE CASCADE,
  last_ok_at           INTEGER,
  last_error_at        INTEGER,
  last_error_type      TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  cooldown_until       INTEGER,
  updated_at           INTEGER NOT NULL
);

-- PKCE 授权会话。code_verifier 属于凭据，同样加密存储。
-- consumed_at 保证授权码只能被消费一次。
CREATE TABLE oauth_sessions (
  state               TEXT PRIMARY KEY,
  code_verifier_enc   BLOB NOT NULL,
  code_verifier_nonce BLOB NOT NULL,
  key_version         INTEGER NOT NULL,
  redirect_uri        TEXT NOT NULL,
  scopes              TEXT NOT NULL,
  created_at          INTEGER NOT NULL,
  expires_at          INTEGER NOT NULL,
  consumed_at         INTEGER
);
CREATE INDEX idx_oauth_sessions_expires_at ON oauth_sessions (expires_at);
`;

export const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: 'core_settings_apikeys_admin_audit', sql: M001_CORE },
  { version: 2, name: 'accounts_tokens_health_oauth_sessions', sql: M002_ACCOUNTS },
];

export const LATEST_SCHEMA_VERSION: number = MIGRATIONS.reduce(
  (max, migration) => Math.max(max, migration.version),
  0,
);
