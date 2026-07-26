# M365-Codex 实施执行计划（Claude Code 执行版）

> **用途**：把本文件放到仓库根目录，作为编码 agent（Claude Code / Codex）的实施说明，可兼作 `AGENTS.md` / `CLAUDE.md`。**逐里程碑执行，每步过完 DoD（Definition of Done）再进入下一步。** 本文件是权威执行口径；更详尽的背景见 `docs/plan.md`（v1.1 完整计划）。

---

## 0. 背景与硬约束（务必先读）

- **项目**：`M365-Codex`，仓库 `Foch0x97/M365-Codex`，Public，MIT，个人**非官方**项目，首发 `v1.0.0`。
- **一句话目标**：让用户用「自定义 `base_url` + `sk-` 密钥」登录 Codex，获得**接近官方 OpenAI 账号/API 登录 Codex 的本地编码体验**，省去官方账号与绑卡。
- **上游真相（决定架构）**：Microsoft 365 Copilot 没有面向第三方模型代理的官方 HTTP 补全接口；可编程上游是**逆向得到的 Sydney / BizChat WebSocket**，形如 `wss://substrate.office.com/m365chat/SecuredChathub/{oid}@{tid}?...&access_token=...`，Access Token 的 audience 为 `https://substrate.office.com/sydney`。
  - **推论**：`Copilot 适配器`是一个**有状态的 WebSocket 会话桥接器**，不是 HTTP 请求封装。「上游会话」「会话恢复」「断开取消」对应 WS 上的一次 conversation。
  - **上游端点会漂移**（已出现 `substrate.svc.cloud.microsoft/m365Copilot/Chathub` 变体）→ **上游 URL / 路径 / scope / CLIENT_ID 一律走配置，禁止硬编码进业务逻辑**；协议适配层独立版本化。
  - **合规风险**：逆向访问很可能违反 Microsoft 服务条款（明确禁止逆向工程/抓取/规避技术限制），可被随时中止。**README 必须写明合规与账号风险声明。**

---

## 1. 编码 agent 必须遵守的护栏（Guardrails）

1. **绝不**把真实 Token、邮箱、账号文件、PAT、Cookie、真实对话写入仓库、镜像、测试夹具或日志。仓库里只提交 `.env.example`。
2. Token 用 **AES-256-GCM** 加密入库；主密钥来自环境变量 `M365_CODEX_MASTER_KEY`（解码后 32 字节），**无默认值**，无效则不进入 ready。每个敏感字段独立随机 nonce，存密钥版本以支持轮换。
3. 对外 **API Key 用 `sk-` 前缀**（`sk-` + ≥48 位 CSPRNG Base62）；库里只存哈希（SHA-256 + 每 Key 盐）+ 前缀掩码。支持 `Authorization: Bearer sk-…` 与 `X-API-Key: sk-…`。
4. **不造模型别名**（不建 `m365-copilot*` 之类）。`model` 与 `reasoning.effort` **原样透传、只记录、不改写、不枚举取值**（effort 合法值随模型而定，如 `none/minimal/low/medium/high/xhigh/max`）。
5. Codex `wire_api` **只用 `"responses"`**（`"chat"` 已于 2026-02 移除）。`/v1/chat/completions` 保留给其他兼容客户端，不供 Codex 自身。
6. 每个里程碑**先写测试 / OpenAPI 契约，再实现**。对可能产生副作用的工具阶段**禁止自动跨账号重放**；已完成的 tool call 不因 SSE 重连再次执行。
7. **不实现做不到的功能**（见 §7），且**影响语义又无法实现的参数必须返回清晰错误，不得静默伪装生效**。
8. 容器**非 root** 运行，SIGTERM 优雅退出，提供 Healthcheck；不含开发依赖、账号文件、`.env`、任何 Token。

---

## 2. 技术栈与仓库结构

**栈**：TypeScript + Node.js(≥22) + Fastify；WebUI React + Vite；校验 Zod + JSON Schema；HTTP Undici；上游 WebSocket 用 `ws`；SQLite(WAL)；日志 Pino；加密 AES-256-GCM；测试 Vitest + Fastify Inject + Playwright；OpenAPI 3.1。端口 `8080`，数据目录 `/data`，单进程单容器。

```text
M365-Codex/
├─ apps/
│  ├─ server/
│  │  ├─ src/
│  │  │  ├─ gateway/        # 鉴权 / 限流 / 幂等
│  │  │  ├─ responses/      # Responses 状态机 + SSE
│  │  │  ├─ tools/          # 工具协议与代理循环
│  │  │  ├─ adapter/        # Sydney WebSocket 适配器（版本隔离）
│  │  │  ├─ scheduler/      # 账号池调度 / 冷却 / 粘性
│  │  │  ├─ oauth/          # PKCE / Token 维护
│  │  │  ├─ files/          # Files / Uploads / 提取
│  │  │  ├─ db/             # SQLite + 迁移
│  │  │  ├─ crypto/         # AES-256-GCM / 密钥版本
│  │  │  ├─ config/         # 配置校验(Zod)
│  │  │  └─ observability/  # 日志 / metrics
│  │  └─ test/              # Vitest + 模拟上游(含模拟 Sydney WS)
│  └─ web/                  # React + Vite 管理 UI
├─ packages/shared/         # 共享类型 / Zod schema / OpenAPI
├─ config/models.json       # 可更新模型目录
├─ probe/                   # M0 上游能力探针（本地）
├─ docker/                  # Dockerfile / compose
├─ .github/workflows/       # CI / 发布
├─ openapi/                 # OpenAPI 3.1 契约
├─ docs/plan.md             # v1.1 完整计划
├─ .env.example
├─ LICENSE                  # MIT
└─ README.md                # 含合规与风险声明
```

---

## 3. 环境变量（`.env.example` 内容）

| 变量 | 必填 | 说明 |
|---|---|---|
| `M365_CODEX_MASTER_KEY` | 是 | Base64，解码后 32 字节；无效则拒绝 ready |
| `M365_CODEX_ADMIN_PASSWORD` | 是 | 管理端登录密码 |
| `PORT` | 否 | 默认 `8080` |
| `DATA_DIR` | 否 | 默认 `/data` |
| `PUBLIC_API_BASE_URL` | 否 | 对外 API Base URL（UI / 配置生成用） |
| `PUBLIC_ADMIN_URL` | 否 | 管理界面公开地址 |
| `TRUST_PROXY` | 否 | 启用后才信任 `X-Forwarded-*` |
| `LOG_PRIVACY_MODE` | 否 | `strict`(默认)/`metadata`/`debug` |
| `UPSTREAM_WS_BASE` | 否 | 上游 WebSocket 基址（可覆盖，应对端点漂移） |
| `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY` | 否 | 出口代理默认值 |
| `MASTER_KEY_VERSION` | 否 | 主密钥版本号 |

> **禁止**通过环境变量注入任何 Microsoft Token / OAuth 凭据；这些只经 PKCE 流程获取并加密入库。

---

## 4. 对外接口契约（照此实现）

### 4.1 端点

```text
GET  /healthz            GET  /readyz            GET    /v1/models
POST /v1/responses       GET  /v1/responses/:id  DELETE /v1/responses/:id
POST /v1/responses/:id/cancel                    POST   /v1/chat/completions
POST /v1/files  GET /v1/files  GET /v1/files/:id  GET /v1/files/:id/content  DELETE /v1/files/:id
POST /v1/uploads  POST /v1/uploads/:id/parts  POST /v1/uploads/:id/complete  POST /v1/uploads/:id/cancel
```

### 4.2 Responses 请求字段（优先支持）

`model`、`input`、`instructions`、`stream`、`tools`、`tool_choice`、`parallel_tool_calls`、`previous_response_id`、`metadata`、`max_output_tokens`、`temperature`、`reasoning`(含 `reasoning.effort`，透传)；内容类型 `input_text`、`input_image`、`input_file`、`function_call_output`。每次请求记录：`requested_model`、`requested_reasoning_effort`、`upstream_model_parameter`、`reported_upstream_model`。

### 4.3 SSE 事件（至少实现，均带 `response_id`/`item_id`/`output_index`/`content_index`/单调 `sequence_number`）

```text
response.created  response.queued  response.in_progress
response.output_item.added  response.content_part.added
response.output_text.delta  response.output_text.done
response.function_call_arguments.delta  response.function_call_arguments.done
response.reasoning_summary_text.delta  response.reasoning_summary_text.done
response.refusal.delta  response.refusal.done
response.output_text.annotation.added   # 映射 Copilot citation
response.content_part.done  response.output_item.done
response.completed  response.incomplete  response.failed  error
```

### 4.4 统一错误体

```json
{ "error": { "type": "account_pool_exhausted", "code": "503",
  "message": "No healthy Microsoft account available", "param": null, "request_id": "req_..." } }
```

### 4.5 生成给用户的 Codex `config.toml`

```toml
model = "gpt-5-codex"            # Codex 端选择，容器不改写
model_reasoning_effort = "high"  # Codex 端选择；取值随模型而定
model_provider = "m365-codex"

[model_providers.m365-codex]
name = "M365-Codex (Responses compatible)"
base_url = "https://codex.example.com/v1"
env_key = "M365_CODEX_API_KEY"
wire_api = "responses"           # 仅 responses
```

---

## 5. 数据库（关键表 DDL，其余表同原则）

```sql
CREATE TABLE accounts (
  id TEXT PRIMARY KEY, tid TEXT NOT NULL, oid TEXT NOT NULL,
  email TEXT, display_name TEXT, status TEXT NOT NULL DEFAULT 'probing',
  proxy_node_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  UNIQUE (tid, oid));

CREATE TABLE account_tokens (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id),
  access_token_enc BLOB, access_nonce BLOB,
  refresh_token_enc BLOB, refresh_nonce BLOB,
  key_version INTEGER NOT NULL, expires_at INTEGER, rotated_at INTEGER);

CREATE TABLE api_keys (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, prefix TEXT NOT NULL, hash TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1, revoked_at INTEGER, starts_at INTEGER, expires_at INTEGER,
  rpm_limit INTEGER, daily_limit INTEGER, max_concurrency INTEGER,
  allowed_endpoints TEXT, allowed_models TEXT,
  created_at INTEGER NOT NULL, last_used_at INTEGER, last_used_ip TEXT);

CREATE TABLE responses (
  id TEXT PRIMARY KEY, api_key_id TEXT REFERENCES api_keys(id),
  account_id TEXT REFERENCES accounts(id), requested_model TEXT, status TEXT NOT NULL,
  previous_response_id TEXT, idempotency_key TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  UNIQUE (api_key_id, idempotency_key));

CREATE TABLE conversation_bindings (
  response_id TEXT PRIMARY KEY REFERENCES responses(id),
  account_id TEXT REFERENCES accounts(id),
  upstream_conversation_ref TEXT, created_at INTEGER NOT NULL);

CREATE TABLE tool_calls (
  id TEXT PRIMARY KEY, response_id TEXT REFERENCES responses(id),
  call_id TEXT NOT NULL, name TEXT NOT NULL, arguments TEXT,
  status TEXT NOT NULL, side_effect INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
  UNIQUE (response_id, call_id));
```

其余表：`account_health`、`oauth_sessions`、`oauth_configs`、`response_items`、`files`、`uploads`、`proxy_nodes`、`cloudflare_nodes`、`request_logs`、`audit_logs`、`settings`、`capability_results`、`schema_migrations`。敏感字段加密、外键齐全、时间戳统一毫秒 epoch。

---

## 6. 里程碑执行清单（M0–M9）

> 每个里程碑：**建什么 → 怎么验（DoD）**。未过 DoD 不进入下一步。带 ⚠️ 的需要人工/真实账号，编码 agent 只搭框架。

### ⚠️ M0 · 上游能力探针（硬门槛）
- 建：`probe/`，能建立一次 Sydney WebSocket 会话，跑 §3.1 的能力用例，输出**脱敏**能力报告 + 协议样本 + 首发兼容矩阵草案。
- DoD：文本稳定成功；流式可解析；Token 可刷新；会话可恢复或本地重建；图片可用；工具调用可转有效 JSON；结果回传后可续推理；401/403/429/故障可分类；至少跑通单工具代理循环。报告零敏感数据。
- **人工**：需真实 M365 Copilot 账号实跑；agent 只能把探针框架和报告模板写好。若工具只能提示词模拟，须达：工具名识别≥99%、首次参数≥95%、两次修复后≥99%、不调未声明工具、不重复输出工具 JSON。

### M1 · 工程骨架与安全底座
- 建：单仓库脚手架；`config`(Zod)、`db`(SQLite+迁移)、`crypto`(AES-256-GCM)、`observability`(Pino, strict 日志)；管理员登录 + 多 API Key(`sk-`)。
- DoD：无主密钥拒绝启动；`/readyz` 校验主密钥+迁移；API Key 哈希存储、仅创建时显示一次；`/healthz` 存活。单测覆盖 crypto/apikey/config。

### M2 · OAuth 与账号健康
- 建：独立 PKCE 授权流程（独立会话、10 分钟过期、单次消费、state 严格匹配）；Token 刷新+轮换（同账号单刷新任务、原子替换）；账号状态机（`probing/online/busy/cooldown/reauth_required/disabled/unsupported/error`）。
- DoD：并发授权互不干扰；`invalid_grant`→`reauth_required`；Token 不入日志。集成测试覆盖授权码单次消费与刷新。

### M3 · Sydney 适配器 + 调度
- 建：把 M0 探针整理为正式 `adapter/`（WebSocket、心跳、重连、取消；上游 URL 走配置、版本隔离）；`scheduler/`（带权最少连接、冷却、Response↔账号↔上游会话粘性、出口代理绑定）。
- DoD：粘性稳定；401 刷新一次、403 不无限切换、429 读 Retry-After 冷却、5xx/WS 断开有限重试可切换；切账号用本地内容重建上下文；所有账号不可用返回 `503 account_pool_exhausted`。

### M4 · Responses 非流式 + 流式
- 建：`responses/` 状态机；`POST /v1/responses`（非流式 + SSE）、`GET/DELETE/:id/cancel`；`/v1/models`。
- DoD：SSE 事件齐全、序号单调、完成顺序正确；客户端断开触发上游取消；`response_id` 全程稳定。OpenAPI 契约测试通过。

### M5 · 工具调用与完整代理循环
- 建：严格工具协议 + JSON Schema 校验 + 最多两次参数修复 + `function_call_output` 恢复（匹配未完成 `call_id`）。
- DoD：§1.6 全满足；重连/重复提交幂等；副作用阶段不自动跨账号重放；达提示词模拟门槛（若适用）。端到端：模型调用工具→执行→回传→续推理→完成。

### M6 · 文件/图片/Office-PDF + Chat Completions
- 建：`files/`（Files、Uploads、图片输入、PDF/Office 文本提取，扩展名+MIME+魔数校验，大小限制，归属 API Key）；`/v1/chat/completions`（复用 Responses 内核）。
- DoD：文件归属与限额生效；未识别二进制不猜测；Chat Completions 不建第二套推理逻辑。

### M7 · 幂等/恢复/清理 + WebUI + 网络设置
- 建：`Idempotency-Key`、重启恢复、定时清理；原创管理 WebUI（§14 页面全覆盖）；OAuth/调度/日志/公网地址设置；出口代理池；一键生成 `config.toml`。
- DoD：重启后 `queued` 恢复、`in_progress`→`incomplete`；已发工具调用可查询、不自动重复副作用；WebUI 可加账号/建 Key/看状态。

### ⚠️ M8 · 迁移/备份/可观测 + 测试 + Codex 验收
- 建：旧账号一次性迁移（按 `tid+oid` 去重、不改原文件、不输出 Token）；备份/恢复/Metrics/诊断包；完整自动化测试（模拟 Sydney WS 上游）。
- DoD：集成测试全绿；**Codex 实机验收**（人工）稳定通过端到端代理循环、限流切换、Token 刷新、重启保留、多 Key 限额。

### M9 · 交付与发布
- 建：`docker/` 多架构（amd64/arm64）；`.github/workflows/` CI（tsc/eslint/test/契约/构建/健康/凭据扫描/漏洞扫描）+ 发布（main→`main`&`sha-`；tag→版本；Release→`latest`）；安全（SHA 固定、最小权限、CodeQL、SBOM、签名、分支保护）。
- DoD：CI 全绿且安全门禁通过；多架构镜像可运行；`latest` 仅正式 Release 触发；⚠️`192.168.0.5` 主机最终验收（人工）。

---

## 7. 功能范围（避免 agent 试图实现做不到的）

**能做**（本地执行或走 Responses）：自定义 Base URL + `sk-` 登录 Codex；文本/代码生成、SSE、多轮上下文、模型/思考等级透传、完整工具代理循环；本机文件、apply_patch、CMD/PowerShell/Shell、Git、跑测试、**命令行本地代码审查**、本地/自建 MCP、只调本地工具的插件、AGENTS.md；多 API Key、自定义公开地址。

**取决于 M0 探测**（可能 partial/unstable，不达门槛不默认启用）：图片理解、PDF/Office 附件、长上下文上限、严格结构化 JSON、并行工具调用、思考等级是否真分级、精确 token 用量、引用来源、取消及时性。

**不能做**（依赖 OpenAI 后端，禁止伪装实现）：Codex Cloud/云端任务、云端代码审查/云端 GitHub 集成、OpenAI 托管内置工具（`web_search`/`file_search`/`code_interpreter`/`computer_use`/`image_generation`）、ChatGPT 工作区 RBAC/企业保留、依赖 OpenAI 的插件/MCP、Embeddings/Realtime/Batch/Fine-tuning、官方用量计费面板、保证 `requested_model` 被上游真实使用。

---

## 8. 测试与验收门禁

- 单测：PKCE、OAuth 单次消费、AES-256-GCM、Token 轮换、API Key 有效期/撤销、账号评分、Responses 转换、Tool Schema、SSE 顺序与序号、幂等键、日志脱敏、文件路径/MIME。
- 集成：用**模拟 Sydney WS 上游**覆盖文本/SSE/图片/文件/单/多/并行工具/`function_call_output`/`previous_response_id`/断开/超时/401/403/429/全不可用/重启恢复/Chat Completions。**不依赖真实 Token。**
- 发布门禁：高危漏洞、凭据扫描失败、契约测试失败、代理循环验收失败 → 阻止 `latest`。

---

## 9. 启动指令（Claude Code 从这里开始）

1. 确认/初始化仓库（若远端非空，先与用户确认清空策略——**清空远端是人工/用户操作，agent 不擅自删远端**）。
2. **执行 M1**：搭骨架、安全底座、管理员登录 + 多 API Key，跑通 `/healthz`、`/readyz`，补齐单测，提交。
3. 依次推进 M2 → M9，**每个里程碑先测/契约、再实现、过 DoD 再继续**，每完成一个里程碑提交一次。
4. 遇到 ⚠️（M0 真实探针、M8 Codex 实机验收、M9 主机验收、任何 PAT/账号/密钥）**停下交回人工**，不自行处理凭据。

### 给 Claude Code 的一句话起步 prompt

> 阅读本仓库根目录的 `M365-Codex-实施执行计划.md`。严格遵守其中 §1 护栏，从 §9 第 2 步（里程碑 M1）开始实现：搭建 TypeScript+Fastify+SQLite 骨架、配置/迁移/AES-256-GCM 加密/Pino strict 日志、管理员登录与多 `sk-` API Key，跑通 `/healthz` 与 `/readyz` 并补齐单元测试，然后停下等我确认再进入 M2。全程不得把任何真实 Token/PAT/账号写入仓库，只维护 `.env.example`。
