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

const M003_RESPONSES = `
-- Responses 请求记录。
-- 每次请求都记录 requested_* 与 upstream/reported_* 四组模型信息（对应实施计划 §4.2）：
--   requested_model / requested_reasoning_effort：客户端请求的原值
--   upstream_model_parameter：实际透传给上游的值
--   reported_upstream_model：上游自报的模型（可能与请求不一致）
-- body 存完成后的 Response JSON，供 GET /v1/responses/:id 返回。
CREATE TABLE responses (
  id                         TEXT PRIMARY KEY,
  api_key_id                 TEXT REFERENCES api_keys (id),
  account_id                 TEXT REFERENCES accounts (id),
  status                     TEXT NOT NULL,
  requested_model            TEXT,
  requested_reasoning_effort TEXT,
  upstream_model_parameter   TEXT,
  reported_upstream_model    TEXT,
  previous_response_id       TEXT,
  idempotency_key            TEXT,
  body                       TEXT,
  error_message              TEXT,
  created_at                 INTEGER NOT NULL,
  updated_at                 INTEGER NOT NULL,
  UNIQUE (api_key_id, idempotency_key)
);
CREATE INDEX idx_responses_api_key ON responses (api_key_id);
CREATE INDEX idx_responses_status ON responses (status);

-- Response ↔ 账号 ↔ 上游会话的粘性绑定（对应实施计划 §5）。
-- previous_response_id 续接时据此复用同一账号与上游会话。
CREATE TABLE conversation_bindings (
  response_id               TEXT PRIMARY KEY REFERENCES responses (id) ON DELETE CASCADE,
  account_id                TEXT REFERENCES accounts (id),
  upstream_conversation_ref TEXT,
  created_at                INTEGER NOT NULL
);
`;

const M004_TOOL_CALLS = `
-- 工具调用记录（对应实施计划 §5、§M5）。
-- UNIQUE (response_id, call_id) + status 保证同一工具调用不因重连/重复提交而重复执行。
-- side_effect 标记该工具是否可能产生副作用；副作用阶段禁止自动跨账号重放。
CREATE TABLE tool_calls (
  id          TEXT PRIMARY KEY,
  response_id TEXT NOT NULL REFERENCES responses (id) ON DELETE CASCADE,
  call_id     TEXT NOT NULL,
  name        TEXT NOT NULL,
  arguments   TEXT,
  status      TEXT NOT NULL DEFAULT 'emitted',
  side_effect INTEGER NOT NULL DEFAULT 0,
  output      TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  UNIQUE (response_id, call_id)
);
CREATE INDEX idx_tool_calls_call_id ON tool_calls (call_id);

-- 代理循环的计数沿对话链累加（对应实施计划 §7.4 的「最大工具轮次 / 最大累计工具调用数」）。
-- 放在 response 行上是为了 O(1) 拿到上一轮的计数，不必回溯整条 previous_response_id 链。
ALTER TABLE responses ADD COLUMN tool_round INTEGER NOT NULL DEFAULT 0;
ALTER TABLE responses ADD COLUMN tool_calls_total INTEGER NOT NULL DEFAULT 0;
`;

export const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: 'core_settings_apikeys_admin_audit', sql: M001_CORE },
  { version: 2, name: 'accounts_tokens_health_oauth_sessions', sql: M002_ACCOUNTS },
  { version: 3, name: 'responses_conversation_bindings', sql: M003_RESPONSES },
  { version: 4, name: 'tool_calls', sql: M004_TOOL_CALLS },
];

export const LATEST_SCHEMA_VERSION: number = MIGRATIONS.reduce(
  (max, migration) => Math.max(max, migration.version),
  0,
);
