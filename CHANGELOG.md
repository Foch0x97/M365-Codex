# 更新记录

本文件记录本项目所有值得注意的变更。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

版本策略：`0.x` 为开发期版本，每完成一个里程碑发一个次版本号；全部里程碑通过 DoD 且完成 Codex 实机验收后，发布首个正式版 `v1.0.0`。

---

## [未发布]

### 计划中

- M5：工具调用与完整代理循环

---

## [0.4.1] - 2026-07-26

### 修复

- **发布镜像改推 Docker Hub**：此前 `release.yml` 推到 GHCR（私有），而仓库配置的是
  Docker Hub 凭据（`DOCKERHUB_USERNAME` / `DOCKERHUB_TOKEN` / `DOCKERHUB_REPOSITORY`），
  导致 Docker Hub 上一直没有镜像。现在用这些凭据推到
  `<DOCKERHUB_USERNAME>/<DOCKERHUB_REPOSITORY>`，多架构（amd64/arm64），
  标签规则不变（main/sha- 跟随主分支，版本号来自 tag，latest 仅正式 Release）。

### 移除

- **账号只保留 PKCE 授权一种添加方式**。删除「从 accounts.json 导入」与「外部文件实时
  同步」两种方式及其接口（`/admin/accounts/import`、`/admin/accounts-sync/*`）、配置
  （`EXTERNAL_ACCOUNTS_FILE`、`EXTERNAL_ACCOUNTS_SYNC_INTERVAL_MS`）与相关文档。
  账号统一经本网关自己的 PKCE 流程添加，授权后用保存的 `refresh_token` 独立续期。

---

## [0.4.0] - 2026-07-26

里程碑 **M4 · Responses 非流式 + 流式（SSE）** 完成。这是 Codex 真正连上来的一层。

> M4 仅文本；工具调用代理循环在 M5，图片/文件在 M6。请求里出现这些内容时
> 返回清晰的 `unsupported_feature` 错误，不静默伪装生效。

### 新增

- **对外 `/v1` 接口**：`GET /v1/models`、`POST /v1/responses`（非流式 + SSE 流式）、
  `GET /v1/responses/:id`、`DELETE /v1/responses/:id`、`POST /v1/responses/:id/cancel`。
  全部走 API Key 鉴权。
- **Responses 状态机**：把上游归一化事件流翻译成 OpenAI Responses 的 SSE 事件，
  保证每个事件带**单调递增的 sequence_number**、事件顺序正确
  （item added → content part added → deltas → part done → item done → completed）、
  reasoning 摘要项在 message 项之前、`response_id` 全程稳定。
- **SSE 事件词汇表**（§4.3）：created / in_progress / output_item.added|done /
  content_part.added|done / output_text.delta|done / output_text.annotation.added /
  reasoning_summary_text.delta|done / completed / incomplete / failed / error。
  Copilot 引用映射为 `output_text.annotation.added`（url_citation）。
- **请求字段**（§4.2）：model、input（字符串或消息数组）、instructions、stream、
  tools（记录，执行留 M5）、previous_response_id、metadata、max_output_tokens、
  temperature、reasoning（含 effort，**原样透传不改写**）。每次请求记录
  requested_model / requested_reasoning_effort / upstream_model_parameter。
- **粘性续接**：`previous_response_id` 经 conversation_bindings 复用上一轮的账号与
  上游会话引用。
- **取消**：客户端断开自动向上游发取消帧；`POST /:id/cancel` 与 `DELETE /:id`
  可中止另一路进行中的请求（进程内 InFlight 登记表）。
- **模型目录**：`config/models.json` 可更新，`/v1/models` 据此展示；
  model 值原样透传，不造别名、不参与路由决策。可用 `MODELS_FILE` 覆盖。
- **数据表**：`responses`（含四组模型信息与完成后的 Response JSON）、
  `conversation_bindings`。
- **错误语义**：账号池耗尽 503、图片/文件输入与工具输出 422 unsupported_feature、
  上游失败 502；非流式返回对应 HTTP 状态，流式在事件流内以 response.failed 表达。
- **OpenAPI 3.1 契约**：`openapi/openapi.json` 描述全部 `/v1` 端点与 Response/错误体 schema。

### 测试

新增 63 个用例（累计 332 个，26 个文件）：

- 状态机：sequence_number 单调、事件顺序、reasoning 先于 message、引用映射、
  失败/取消收尾、快照深拷贝
- 请求校验与输入提取：字符串/数组 input、图片/文件/工具输出的清晰报错、透传组装
- 全链路（路由→服务→状态机→调度器→真实连接→模拟 Sydney 上游）：非流式返回完整
  Response、SSE 流式解析、model/effort 透传落库、账号池耗尽 503、图片 422、
  previous_response_id 粘性、GET/cancel/delete、API Key 归属隔离、上游失败 502
- 模型目录加载与回退
- **OpenAPI 契约测试**：用 ajv 按 openapi.json 的 schema 校验真实响应
  （ModelList、Response、ErrorBody、SSE completed 事件里的 response）

---

## [0.3.0] - 2026-07-26

里程碑 **M3 · Sydney 适配器 + 账号池调度** 完成（框架 + 模拟上游验证）。

> ⚠️ 真实协议细节依赖 M0 探针实测。本版本按已知的 Sydney/BizChat 协议形态建模，
> 用模拟 WS 上游测试；协议层已做版本隔离，M0 校准后只需替换 codec，
> 连接、心跳、调度逻辑不受影响。

### 新增

- **协议层（版本隔离）**：SignalR 风格 JSON 帧 + `0x1e` 记录分隔符的编解码。
  帧分隔是既定规范；消息内部字段语义抽成 `mapMessageToEvents` 作为 M0 后的替换接缝。
  codec 通过 `ProtocolCodec` 接口暴露，按 `UPSTREAM_PROTOCOL_VERSION` 选择实现。
- **帧重组器**：处理 WebSocket 粘包/半包，跨分片重组完整消息，跳过非法帧。
- **连接层**：单次对话连接的完整生命周期——握手、心跳、空闲超时、取消
  （`AbortSignal` → 向上游发取消帧）、把原始消息映射为归一化事件。
  WS 握手阶段的 HTTP 错误（401/403/429）能拿到状态码并分类。
- **上游端点构造**：`{oid}`/`{tid}` 模板填充 + `access_token` 查询参数；
  基址、路径全部走配置以应对端点漂移；日志一律经 `redactWsUrl` 脱敏 access_token。
- **错误分类**：401→刷新重试、403→账号禁用、429→读 Retry-After 冷却、
  5xx/WS 异常→有限重试可切换、其他 4xx→致命。集中在一处，避免策略散落。
- **账号池**：带权最少连接选择（连接数→连续失败数→更新时间），冷却期跳过，
  排除集，请求↔账号粘性，内存并发计数。
- **调度器**：失败切换状态机——401 刷新一次并在同账号重试；403/429 冷却并切换
  （不无限切换）；5xx/断开有限重试可切换；致命错误直接失败；
  所有账号不可用返回 `503 account_pool_exhausted`。
  「切账号用本地内容重建上下文」：仅在尚未向下游吐出内容时切换/重试，
  已有内容流出后中途失败如实抛出（干净的断点续传与工具幂等属于 M4/M5）。
- **配置**：新增 `UPSTREAM_PATH_TEMPLATE`、`UPSTREAM_PROTOCOL_VERSION`、
  心跳/握手/空闲超时与最大重连次数，全部可配置。
- **出口代理绑定**：上游 WebSocket 支持通过 `HTTPS_PROXY`/`HTTP_PROXY` 绑定出口。

### 测试

新增 73 个用例（累计 279 个，21 个文件），含用**真实内存 WS 服务器模拟的 Sydney 上游**：

- 协议：切帧、帧重组（粘包/半包/非法帧）、codec 编解码与事件映射
- 端点：模板填充、URL 编码、端点漂移、access_token 脱敏
- 错误分类：401/403/429/5xx/4xx、Retry-After（秒数与 HTTP 日期）、WS 关闭码
- 连接（对模拟上游）：握手→流式→completion、access_token 送达、引用映射、
  各类 HTTP 错误分类、异常关闭、completion 错误、空闲超时、心跳、取消
- 账号池：可用性过滤、冷却跳过、带权最少连接、排除、粘性
- 调度器失败切换：401 刷新重试、429/403 冷却切换、5xx 有限重试、致命不重试、
  已吐内容后不重复切换、粘性复用、账号池耗尽 503

---

## [0.2.0] - 2026-07-26

里程碑 **M2 · OAuth 与账号健康** 完成，并集成了本地 M365 Native 授权助手。

### 新增

- **PKCE 授权流程**：S256 挑战（不提供 plain 降级）；每次授权生成独立的
  `code_verifier` / `state` 会话，可为多个账号并行授权互不干扰；`code_verifier`
  同样以 AES-256-GCM 加密入库；会话 10 分钟过期；授权码通过带
  `consumed_at IS NULL` 条件的原子 UPDATE 保证只能消费一次，并发重放会被拒绝。
- **授权交互形态**：沿用 nativeclient 回调页——服务生成授权链接，用户在浏览器登录后
  把回调地址粘回管理界面。因此本服务**不需要公网可达**，也无需暴露回调端点。
- **Token 刷新与轮换**：按账号单飞（同账号并发刷新共享同一个任务，避免互相覆盖
  `refresh_token` 把账号刷坏）；写回是事务化原子替换；上游不下发新
  `refresh_token` 时保留原值；Token 剩余寿命少于 5 分钟时主动提前刷新。
- **账号状态机**：`probing` / `online` / `busy` / `cooldown` / `reauth_required` /
  `disabled` / `unsupported` / `error`，迁移规则收敛在一处，非法迁移抛错而非静默写入；
  人工停用的账号不会因一次重新授权被悄悄启用。`invalid_grant` 与 `interaction_required`
  一律转入 `reauth_required` 并停止自动重试。
- **账号池数据表**：`accounts`（按 `tid + oid` 唯一）、`account_tokens`（access 与
  refresh 各自独立 nonce，密文以账号 ID 作 AAD 绑定，搬到别的账号行上解不开）、
  `account_health`、`oauth_sessions`。
- **集成 M365 Native 授权助手**：新增账号导入器，可读取该助手写出的
  `accounts.json`——只读源文件、按 `tid + oid` 去重、单条损坏不影响其余账号、
  返回值与日志中只有计数与脱敏邮箱。
- **外部账号文件同步**：配置 `EXTERNAL_ACCOUNTS_FILE` 后，服务会按 mtime 变化周期性
  同步该文件中的 Token。配合在 Docker 中持续刷新 Token 的 M365 Native 容器，
  账号过期不再中断测试。同步失败只记日志，不拖垮服务。
- **管理接口**：`/admin/oauth/authorize-url`、`/admin/oauth/callback`、
  `/admin/accounts`（列表/详情/状态迁移/手动刷新/删除）、`/admin/accounts/import`、
  `/admin/accounts-sync/status`、`/admin/accounts-sync/run`。所有响应均不含 Token。
- **OAuth 参数全部可配置**：`OAUTH_CLIENT_ID`、`OAUTH_REDIRECT_URI`、
  `OAUTH_AUTHORIZE_URL`、`OAUTH_TOKEN_URL`、`OAUTH_SCOPES`。上游端点会漂移，
  这些一律不硬编码进业务逻辑。HTTP 出口支持 `HTTPS_PROXY` / `HTTP_PROXY`。

### 修复

- **无请求体的 POST 端点返回 415**：不少 HTTP 客户端在 POST 时会自作主张带上
  `Content-Type`（PowerShell 的 `Invoke-RestMethod` 默认发
  `application/x-www-form-urlencoded`），Fastify 找不到对应解析器就直接拒绝。
  现在空请求体按「没有请求体」处理，非空才回 415 并使用统一错误体。
  该问题在单元测试中不会暴露（`inject` 不带这个头），是本地实跑冒烟发现的。
- **账号文件带 UTF-8 BOM 时解析失败**：Windows 上的工具常会写入 BOM，现已容忍。
- **`.gitignore` 的 `accounts/` 规则误伤源码目录**：Git 的目录规则不加前导 `/`
  会匹配任意层级，把 `apps/server/src/accounts/` 也忽略了。目录规则已锚定到仓库根。
- **`latest` 标签随版本 tag 自动移动**：`docker/metadata-action` 的默认
  `flavor: latest=auto` 覆盖了显式规则。已关闭，`latest` 只在正式 Release 时移动。

### 发布

- 新增 GHCR 多架构（amd64 / arm64）镜像发布工作流，Action 全部按 commit SHA 固定，
  带 provenance 与 SBOM。
- CI 中「无主密钥拒绝启动」的反向验证并入镜像任务，复用已构建的镜像，
  少一次构建、少一个网络失败面。

### 测试

新增 94 个用例（累计 206 个，17 个文件），全部使用模拟上游，不接触真实网络与真实凭据：

- PKCE 参数生成，含 RFC 7636 附录 B 标准测试向量校验
- 授权码单次消费、并发重放、state 不匹配、会话过期、多会话并行互不干扰
- 刷新单飞（8 个并发请求只打一次上游）、原子写回、`refresh_token` 轮换与保留
- `invalid_grant` 转 `reauth_required` 且不再重试；网络抖动不被误判为需要重新授权
- 日志纪律：刷新成功与失败的日志中均不出现任何 Token
- 账号状态机的合法与非法迁移、健康度累计与清零、密文的账号绑定
- 导入器：去重、身份补齐、损坏条目跳过、源文件逐字节不变、导入结果不含 Token
- 外部同步：mtime 未变化时跳过、文件损坏时保留已有账号、强制重新导入
- Content-Type 兜底：空请求体放行、非空且类型不支持时回 415

---

## [0.1.0] - 2026-07-26

里程碑 **M1 · 工程骨架与安全底座** 完成。

### 新增

- **工程骨架**：npm workspaces 单仓库（`apps/server` + `packages/shared`），TypeScript ES2023 + NodeNext，严格模式全开。
- **配置模块**：基于 Zod 的环境变量校验，错误一次性汇总输出且不回显敏感值；主密钥缺失或非 32 字节时拒绝启动；检测并拒绝通过环境变量注入 Microsoft Token 的常见变量名。
- **加密模块**：AES-256-GCM 字段级加密，每次加密使用独立随机 nonce，支持 AAD 绑定与密钥版本记录，为后续主密钥轮换预留通道。
- **API Key**：`sk-` + 52 位 CSPRNG Base62（拒绝采样保证均匀分布）；库中只存 `SHA-256(独立盐 ‖ Key)` 与索引前缀；恒定时间校验；明文仅在创建时返回一次。
- **数据库**：`node:sqlite`（WAL、外键约束、busy_timeout），事务化迁移框架，失败整体回滚；首版迁移建立 `settings`、`api_keys`、`admin_sessions`、`audit_logs`、`schema_migrations` 五张表。
- **日志**：Pino + 三档隐私模式（`strict` / `metadata` / `debug`）；凭据字段在任何模式下都替换为 `[已脱敏]`；`strict` 模式下 IP 收敛到网段并关闭逐请求访问日志。
- **健康检查**：`GET /healthz`（存活）与 `GET /readyz`（主密钥 AES 往返、迁移版本、数据目录可写三项检查，任一失败返回 503）。
- **管理端接口**：密码登录（scrypt 校验 + 按 IP 登录节流）、会话管理、API Key 的增删改查与撤销、审计日志查询。
- **统一错误体**：`{ error: { type, code, message, param, request_id } }`，请求 ID 同时写入 `x-request-id` 响应头。
- **容器化**：多阶段 Dockerfile（`node:24-alpine`），非 root 运行、tini 转发信号、Healthcheck、SIGTERM 优雅退出；compose 示例启用只读根文件系统与 `no-new-privileges`。
- **CI**：类型检查、ESLint、测试、依赖漏洞扫描（high 阻断）、凭据扫描、镜像构建与容器健康冒烟、以及「缺少主密钥必须拒绝启动」的反向验证；所有 GitHub Action 按 commit SHA 固定。
- **测试**：89 个用例覆盖配置校验、加密往返与篡改检测、API Key 生成校验、密码哈希、数据库迁移与回滚、日志脱敏、健康检查、管理端接口与网关鉴权。

### 与实施计划的差异说明

- 计划 §5 的 `api_keys` DDL 未包含 `salt` 列，但 §1.3 要求「每 Key 盐」。实现中补充了 `salt TEXT NOT NULL` 列。
- 计划 §5 列出的其余表（`accounts`、`account_tokens`、`responses` 等）留到各自里程碑的迁移中创建，避免提前产生无人使用的空表。
- SQLite 采用 Node 24 内置的 `node:sqlite` 而非 `better-sqlite3`，以避免原生模块编译，简化多架构镜像构建。

[未发布]: https://github.com/Foch0x97/M365-Codex/compare/v0.4.1...HEAD
[0.4.1]: https://github.com/Foch0x97/M365-Codex/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/Foch0x97/M365-Codex/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/Foch0x97/M365-Codex/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/Foch0x97/M365-Codex/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/Foch0x97/M365-Codex/releases/tag/v0.1.0
