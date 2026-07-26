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

const M005_FILES_UPLOADS = `
-- 文件元数据（对应实施计划 §11、§M6）。磁盘上只按 file-id 建目录存内容，
-- 文件名（filename）只入库、绝不直接拼进磁盘路径。
-- status：processed（已按能力提取或明确判定不可提取）/ error（提取失败）。
-- extracted_text 为空且 status=processed 时，表示"已识别但明确不做提取"
-- （如未识别的二进制、图片），extraction_note 说明原因，不是出错。
CREATE TABLE files (
  id               TEXT PRIMARY KEY,
  api_key_id       TEXT NOT NULL REFERENCES api_keys (id) ON DELETE CASCADE,
  filename         TEXT NOT NULL,
  purpose          TEXT NOT NULL,
  mime_type        TEXT NOT NULL,
  kind             TEXT NOT NULL,
  bytes            INTEGER NOT NULL,
  sha256           TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'processed',
  extracted_text   TEXT,
  extraction_note  TEXT,
  created_at       INTEGER NOT NULL,
  expires_at       INTEGER,
  deleted_at       INTEGER
);
CREATE INDEX idx_files_api_key ON files (api_key_id);
CREATE INDEX idx_files_expires_at ON files (expires_at);

-- 分片上传（Uploads API）。状态流转：pending -> completed / cancelled / expired。
-- 完成后 file_id 指向拼装出的 files 行；取消或过期时清理磁盘上已收到的分片。
CREATE TABLE uploads (
  id          TEXT PRIMARY KEY,
  api_key_id  TEXT NOT NULL REFERENCES api_keys (id) ON DELETE CASCADE,
  filename    TEXT NOT NULL,
  purpose     TEXT NOT NULL,
  mime_type   TEXT NOT NULL,
  bytes       INTEGER NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending',
  file_id     TEXT REFERENCES files (id),
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);
CREATE INDEX idx_uploads_api_key ON uploads (api_key_id);
CREATE INDEX idx_uploads_status_expires ON uploads (status, expires_at);

-- 分片：每个 part 落一份独立磁盘文件（<DATA_DIR>/files/uploads/<upload-id>/<part-id>），
-- complete 时按 part_ids 给定的顺序拼接。part_number 只用于同一 upload 内去重与追踪。
CREATE TABLE upload_parts (
  id           TEXT PRIMARY KEY,
  upload_id    TEXT NOT NULL REFERENCES uploads (id) ON DELETE CASCADE,
  part_number  INTEGER NOT NULL,
  bytes        INTEGER NOT NULL,
  created_at   INTEGER NOT NULL,
  UNIQUE (upload_id, part_number)
);
`;

const M006_IDEMPOTENCY = `
-- 请求幂等（对应实施计划 §18）。
-- 主键是 (key, api_key_id, endpoint) 三元组：幂等键的作用域限定在单个 API Key
-- 与单个端点内，不同 Key 用同一个字符串互不干扰。
-- request_fingerprint 存请求体的稳定哈希：同一把键配不同请求体属于客户端用错键，
-- 必须报错，而不是把两个不同请求当成同一个。
CREATE TABLE idempotency_keys (
  key                 TEXT NOT NULL,
  api_key_id          TEXT NOT NULL REFERENCES api_keys (id) ON DELETE CASCADE,
  endpoint            TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,
  state               TEXT NOT NULL DEFAULT 'in_progress',
  response_id         TEXT,
  status_code         INTEGER,
  body                TEXT,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  PRIMARY KEY (key, api_key_id, endpoint)
);
CREATE INDEX idx_idempotency_created_at ON idempotency_keys (created_at);
`;

const M007_PROXY_NODES = `
-- 出口代理池（对应实施计划 §13.1、§M7）。
-- url 含账号密码，属于凭据，与 Token 同规格 AES-256-GCM 加密存储；
-- 列表接口只返回打码后的 url_masked（见 repo/proxyNodes.ts），明文永不出网关。
CREATE TABLE proxy_nodes (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  url_enc        BLOB NOT NULL,
  url_nonce      BLOB NOT NULL,
  key_version    INTEGER NOT NULL,
  protocol       TEXT NOT NULL,
  weight         INTEGER NOT NULL DEFAULT 1,
  priority       INTEGER NOT NULL DEFAULT 0,
  enabled        INTEGER NOT NULL DEFAULT 1,
  status         TEXT NOT NULL DEFAULT 'unknown',
  latency_ms     INTEGER,
  last_check_at  INTEGER,
  failure_count  INTEGER NOT NULL DEFAULT 0,
  cooldown_until INTEGER,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
CREATE INDEX idx_proxy_nodes_enabled ON proxy_nodes (enabled);
`;

const M008_RESPONSES_DROP_IDEMPOTENCY_UNIQUE = `
-- 放宽 responses 表的唯一约束（对应实施计划 §18 幂等改造）。
-- M003 建表时把 UNIQUE (api_key_id, idempotency_key) 直接放在 responses 表上，
-- 当时是"完整语义在 M7"之前的占位约束；现在完整的幂等保证已经收敛到独立的
-- idempotency_keys 表（begin/complete/release，作用域含 endpoint；流式请求
-- 执行完会 release 这把键，允许同键之后重新执行）。这条表级约束反而会跟
-- "同键释放后重新执行"冲突——第二次 INSERT 一个新的 response 行时撞见旧约束报错。
-- 因此这里重建表去掉该约束：idempotency_key 列继续保留供审计/回溯，
-- 不再承担唯一性职责；SQLite 不支持 DROP CONSTRAINT，只能整表重建。
--
-- 陷阱：SQLite 的 DROP TABLE 内部等价于逐行 DELETE 再移除表定义，PRAGMA
-- foreign_keys=ON 时会对每一行触发外键的 ON DELETE 动作——也就是说 DROP TABLE
-- responses 会把 tool_calls、conversation_bindings 里引用这些行的记录级联删空！
-- 因此先把这两张表的数据原样快照出来，重建完 responses 后再插回去。
CREATE TABLE _tool_calls_backup_v8 AS SELECT * FROM tool_calls;
CREATE TABLE _conversation_bindings_backup_v8 AS SELECT * FROM conversation_bindings;

CREATE TABLE responses_v8 (
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
  tool_round                 INTEGER NOT NULL DEFAULT 0,
  tool_calls_total           INTEGER NOT NULL DEFAULT 0,
  created_at                 INTEGER NOT NULL,
  updated_at                 INTEGER NOT NULL
);
INSERT INTO responses_v8 (
  id, api_key_id, account_id, status, requested_model, requested_reasoning_effort,
  upstream_model_parameter, reported_upstream_model, previous_response_id, idempotency_key,
  body, error_message, tool_round, tool_calls_total, created_at, updated_at
)
SELECT
  id, api_key_id, account_id, status, requested_model, requested_reasoning_effort,
  upstream_model_parameter, reported_upstream_model, previous_response_id, idempotency_key,
  body, error_message, tool_round, tool_calls_total, created_at, updated_at
FROM responses;
DROP TABLE responses;
ALTER TABLE responses_v8 RENAME TO responses;
CREATE INDEX idx_responses_api_key ON responses (api_key_id);
CREATE INDEX idx_responses_status ON responses (status);
CREATE INDEX idx_responses_idempotency_lookup ON responses (api_key_id, idempotency_key);

-- responses 已经用新表恢复出来，把级联清空的子表数据插回去
DELETE FROM tool_calls;
INSERT INTO tool_calls SELECT * FROM _tool_calls_backup_v8;
DELETE FROM conversation_bindings;
INSERT INTO conversation_bindings SELECT * FROM _conversation_bindings_backup_v8;

DROP TABLE _tool_calls_backup_v8;
DROP TABLE _conversation_bindings_backup_v8;
`;

const M009_API_KEYS_EXTRA_FIELDS = `
-- API Key 补齐计划 §10.1 列出、此前一直没做的四项（对应本次改动）：
-- 备注（note，纯展示用）、累计请求次数（request_count，管理界面用量展示）、
-- 按 Key 收紧的工具调用次数上限（max_tool_calls）与单文件/单个上传分片大小
-- 上限（max_file_bytes）。后两者都是"只能更严、不能突破全局天花板"的语义
-- （与既有 rpm_limit/daily_limit/max_concurrency 一致），生效逻辑分别接进
-- responses/service.ts 的工具轮次计数与 files/service.ts 的大小校验，
-- 取 min(Key 自身设置, 全局配置)。
--
-- request_count 的更新时机和 last_used_at 一起做（repo/apiKeys.ts 的
-- touch()），不在鉴权热路径上单独多一次写。
ALTER TABLE api_keys ADD COLUMN note TEXT;
ALTER TABLE api_keys ADD COLUMN request_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE api_keys ADD COLUMN max_tool_calls INTEGER;
ALTER TABLE api_keys ADD COLUMN max_file_bytes INTEGER;
`;

export const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: 'core_settings_apikeys_admin_audit', sql: M001_CORE },
  { version: 2, name: 'accounts_tokens_health_oauth_sessions', sql: M002_ACCOUNTS },
  { version: 3, name: 'responses_conversation_bindings', sql: M003_RESPONSES },
  { version: 4, name: 'tool_calls', sql: M004_TOOL_CALLS },
  { version: 5, name: 'files_uploads', sql: M005_FILES_UPLOADS },
  { version: 6, name: 'idempotency_keys', sql: M006_IDEMPOTENCY },
  { version: 7, name: 'proxy_nodes', sql: M007_PROXY_NODES },
  { version: 8, name: 'responses_drop_idempotency_unique', sql: M008_RESPONSES_DROP_IDEMPOTENCY_UNIQUE },
  { version: 9, name: 'api_keys_note_usage_tool_file_limits', sql: M009_API_KEYS_EXTRA_FIELDS },
];

export const LATEST_SCHEMA_VERSION: number = MIGRATIONS.reduce(
  (max, migration) => Math.max(max, migration.version),
  0,
);
