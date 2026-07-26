# M365-Codex

> 用「自定义 `base_url` + `sk-` 密钥」登录 Codex，把 Microsoft 365 Copilot 当作上游，获得接近官方 OpenAI 账号登录的本地编码体验。

[![CI](https://github.com/Foch0x97/M365-Codex/actions/workflows/ci.yml/badge.svg)](https://github.com/Foch0x97/M365-Codex/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**当前版本：`v0.5.0`（开发中，尚未发布可用版本）**

---

## ⚠️ 合规与风险声明（使用前必读）

- 本项目是**个人非官方项目**，与 Microsoft、OpenAI 均无任何关联，也未获得任何一方授权或背书。
- 本项目访问 Microsoft 365 Copilot 的方式基于**逆向得到的 Sydney / BizChat WebSocket 协议**。Microsoft 没有面向第三方模型代理提供官方 HTTP 补全接口。
- 这种访问方式**很可能违反 Microsoft 服务条款**（其条款明确禁止逆向工程、抓取、以及规避技术限制）。使用本项目可能导致：
  - Microsoft 账号被限制、暂停或封禁；
  - 所在租户被管理员或 Microsoft 侧介入处理；
  - 上游协议随时变更或被切断，功能**可能在任何时刻失效**。
- **上游端点会漂移**（已观察到 `substrate.office.com` 与 `substrate.svc.cloud.microsoft` 两种形态），因此本项目把上游地址、路径、scope 全部做成配置项。
- 使用者需自行承担全部风险与后果。**请勿用于生产环境、商业用途，或任何你不愿意失去的账号。**
- 若你需要稳定、受支持、合规的服务，请使用 OpenAI 官方账号或 Microsoft 官方提供的 API。

作者不对因使用本项目造成的任何账号损失、数据损失或其他后果负责。

---

## 这个项目是什么

Codex 支持通过 `config.toml` 指定自定义的模型提供方（`base_url` + API Key）。M365-Codex 就是这样一个**本地网关**：

```
Codex CLI ──HTTP(Responses 协议)──> M365-Codex ──WebSocket(Sydney)──> Microsoft 365 Copilot
              sk- 密钥                  本地容器                        你自己的 M365 账号
```

它对外暴露与 OpenAI Responses API 兼容的接口，对内维护 Microsoft 账号池、OAuth Token、以及有状态的上游 WebSocket 会话。

### 能做什么

- 用自定义 Base URL + `sk-` 密钥登录 Codex，省去官方账号与绑卡；
- 文本与代码生成、SSE 流式输出、多轮上下文；
- `model` 与 `reasoning.effort` **原样透传**（本项目不新造模型别名，也不改写取值）；
- 完整的工具调用代理循环：模型请求调用工具 → 本机执行 → 结果回传 → 继续推理；
- Codex 的本机能力照常可用：读写文件、`apply_patch`、执行命令、Git、跑测试、命令行本地代码审查、本地/自建 MCP、`AGENTS.md`；
- 文件上传与文本提取：纯文本/代码/JSON/CSV/日志、PDF、Office（docx/xlsx/pptx），供 `input_file` 引用；`/v1/files`、`/v1/uploads` 分片上传；
- `/v1/chat/completions` 兼容入口（复用 Responses 内核，供其他 OpenAI 兼容客户端使用，非 Codex 自身）；
- 多 API Key 管理（有效期、限额、可撤销）、自定义公开地址、管理界面。

### 不能做什么（依赖 OpenAI 后端，本项目不会伪装实现）

Codex Cloud 云端任务、云端代码审查与云端 GitHub 集成、OpenAI 托管内置工具（`web_search` / `file_search` / `code_interpreter` / `computer_use` / `image_generation`）、ChatGPT 工作区 RBAC 与企业保留策略、依赖 OpenAI 的插件与 MCP、Embeddings / Realtime / Batch / Fine-tuning、官方用量计费面板。

此外，本项目**无法保证**你请求的 `model` 会被上游真实使用——上游实际使用哪个模型由 Microsoft 决定，本项目只做记录与如实上报。

### 取决于上游探测结果的能力

图片理解、PDF/Office 附件、长上下文上限、严格结构化 JSON、并行工具调用、思考等级是否真正分级、精确 token 用量、引用来源、取消及时性——这些能力是否可用取决于对真实上游的探测结果，达不到门槛的不会默认启用。

---

## 快速开始

> 前置条件：一个可用的 Microsoft 365 Copilot 账号（授权步骤在管理界面完成）。

### 1. 准备环境变量

```bash
cp .env.example .env
```

生成主密钥（Base64，解码后 32 字节）：

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

把结果填入 `.env` 的 `M365_CODEX_MASTER_KEY`，并设置 `M365_CODEX_ADMIN_PASSWORD`（至少 12 位）。

**没有有效主密钥，服务会直接拒绝启动**——这是刻意设计，避免 Token 以明文入库。

### 2. 用 Docker 运行

镜像发布在 **Docker Hub**：[`foch0x97/m365-codex`](https://hub.docker.com/r/foch0x97/m365-codex)，
多架构（`linux/amd64` + `linux/arm64`）。

```bash
docker pull foch0x97/m365-codex:latest
```

标签规则：`latest` 跟随最新正式 Release；`0.5.0` / `0.5` 由版本 tag 产生；
`main` 与 `sha-<短哈希>` 跟随主分支最新提交。

```bash
docker compose -f docker/docker-compose.yml up -d
```

验证：

```bash
curl http://127.0.0.1:8080/healthz
```

`/readyz` 会额外校验主密钥可用、数据库迁移到位、数据目录可写，任一不通过返回 503。

### 3. 进管理界面

浏览器打开 **`http://<你的地址>:8080/ui/`**（访问 `/` 会自动跳转过去），
用 `M365_CODEX_ADMIN_PASSWORD` 登录。

三类路径互不重叠，便于放在反向代理后分别控制：

| 路径 | 用途 | 鉴权 |
|---|---|---|
| `/ui/` | 管理界面页面 | 页面内登录（管理密码 → 会话令牌） |
| `/admin/*` | 管理 JSON 接口 | 管理会话令牌 |
| `/v1/*` | 对 Codex 等客户端暴露的兼容接口 | `sk-` API Key |

账号授权、创建 API Key、生成 Codex 配置、查看请求与账号状态、代理池、备份恢复
都在管理界面里完成。详细步骤见[部署与验收指南](docs/部署与验收.md)。

### 4. 本地开发运行

```bash
npm ci
npm ci --prefix apps/web   # 管理界面不在根 workspace 里，单独装
npm run build              # 同时构建服务端与管理界面
npm run dev
```

### 4. 配置 Codex

在管理界面一键生成，或手写 `~/.codex/config.toml`：

```toml
model = "gpt-5-codex"            # 由 Codex 端选择，容器不改写
model_reasoning_effort = "high"  # 取值随模型而定，原样透传
model_provider = "m365-codex"

[model_providers.m365-codex]
name = "M365-Codex (Responses compatible)"
base_url = "https://codex.example.com/v1"
env_key = "M365_CODEX_API_KEY"
wire_api = "responses"           # 只支持 responses，chat 已于 2026-02 移除
```

然后把管理界面创建的 `sk-` 密钥设置到环境变量 `M365_CODEX_API_KEY`。

---

## 配置项

完整列表见 [.env.example](.env.example)。要点：

| 变量 | 必填 | 说明 |
|---|---|---|
| `M365_CODEX_MASTER_KEY` | 是 | Base64，解码后 32 字节；无效则拒绝进入 ready |
| `M365_CODEX_ADMIN_PASSWORD` | 是 | 管理端登录密码，至少 12 位 |
| `PORT` | 否 | 默认 `8080` |
| `DATA_DIR` | 否 | 默认 `/data` |
| `PUBLIC_API_BASE_URL` | 否 | 对外 API Base URL，用于生成 Codex 配置 |
| `TRUST_PROXY` | 否 | 启用后才信任 `X-Forwarded-*` |
| `LOG_PRIVACY_MODE` | 否 | `strict`（默认）/ `metadata` / `debug` |
| `UPSTREAM_WS_BASE` | 否 | 上游 WebSocket 基址，用于应对端点漂移 |
| `OAUTH_*` | 否 | OAuth 客户端 ID、端点与 scope，留空使用内置默认值 |
| `UPSTREAM_*` | 否 | 上游路径模板、协议版本、心跳/超时/重连 |
| `TOOLS_*` | 否 | 工具调用方式（`native`/`prompt`/`auto`）与代理循环上限：每轮调用数、轮次、累计调用数、结果大小、参数修复次数 |
| `FILES_*` | 否 | 单文件/单请求大小上限、单 Key 累计存储上限、文件保留期、未完成 Upload 存活时间 |
| `UPSTREAM_IMAGE_INPUT` | 否 | 上游是否真支持图片输入，默认 `false`（`input_image` 返回明确错误，不假装支持） |
| `CONTEXT_MAX_CHARS` | 否 | 重建的对话上下文超过多少字符就从最旧历史开始截断，默认给一个宽松值 |
| `RATE_LIMIT_GLOBAL_*` | 否 | API Key 级限额（RPM/日配额/最大并发）的全局天花板；单个 Key 只能比这更严 |
| `CLEANUP_*` | 否 | 定时清理的运行间隔与 Response/审计日志/幂等记录的保留期 |
| `PROXY_CHECK_TIMEOUT_MS` | 否 | 出口代理健康检查超时，默认 `5000` |
| `METRICS_ENABLED` | 否 | 是否开启 `GET /metrics`，默认 `true` |
| `METRICS_REQUIRE_AUTH` | 否 | `/metrics` 是否要求管理会话鉴权，默认 `true`（会暴露账号数量与错误分布，不建议无鉴权公开） |
| `BACKUP_RETENTION_COUNT` | 否 | 备份包保留份数，超过后定时清理删最旧的，默认 `7` |

**严禁**通过环境变量注入任何 Microsoft Token 或 OAuth 凭据。服务启动时会检测常见的注入变量名并拒绝启动；这些凭据只能经 PKCE 授权流程获取，并以 AES-256-GCM 加密入库。

---

## 添加 Microsoft 账号

只有一种方式：本网关自己的 **PKCE 授权流程**。

1. 调用 `POST /admin/oauth/authorize-url` 拿到授权链接
2. 在浏览器打开，选择有 Copilot 权限的账号登录
3. 登录后会跳到 Microsoft 的 `nativeclient` 提示页，复制地址栏完整 URL
4. 把它提交给 `POST /admin/oauth/callback`

因为回调落在 Microsoft 自己的页面上，**本服务不需要公网可达**，也不用暴露回调端点。授权会话 10 分钟过期，授权码只能用一次，可以同时为多个账号并行授权。授权后本服务用自己保存的 `refresh_token` 独立续期。

### 账号状态

每个账号处于以下状态之一：`probing`（待探测）、`online`、`busy`、`cooldown`（限流冷却）、`reauth_required`（刷新凭据失效，需重新授权）、`disabled`（人工停用）、`unsupported`（上游能力不满足）、`error`。

刷新凭据失效时账号会自动转入 `reauth_required` 并停止重试；人工停用的账号不会因一次重新授权被悄悄启用。

---

## 可观测性与备份恢复

### `GET /metrics`

Prometheus 文本格式，覆盖请求量与耗时（按端点/状态）、上游调用与错误分类、SSE 中断次数、
工具调用数与轮次、工具参数校验结果（pass/rejected）、Token 刷新结果、账号状态迁移、
限额拒绝次数，以及抓取时现填的即时值（各状态账号数、当前在途请求数、数据库与文件占用）。

- `METRICS_ENABLED`（默认 `true`）：关闭后端点直接 404，如同不存在；
- `METRICS_REQUIRE_AUTH`（默认 `true`）：指标会暴露账号数量与错误分布，默认要求管理会话
  （`Authorization: Bearer <管理令牌>`）；仅在抓取器与本服务处于同一可信内网时才建议关闭。

**隐私红线**：指标里绝不出现邮箱、提示词、输出正文、Token、文件名；标签值统一走字符白名单
清洗，超长或形似 Token/API Key 的值会被替换或截断。

### 备份与恢复

- `POST /admin/backup`：生成备份包（数据库用 `VACUUM INTO` 出一份一致性快照 + 已上传文件），
  落到 `<DATA_DIR>/backups/`，返回 `{id, bytes, created_at}`。
- `GET /admin/backup`：列出已生成的备份包；`GET /admin/backup/:id/download`：下载。
- `POST /admin/restore`：multipart 上传备份包，校验格式版本、数据库结构版本、主密钥版本
  一致后写入数据目录——**校验通过只代表已落盘，必须重启服务后才会生效**（正在运行的进程
  仍持有旧数据库的连接），响应里会明确说明这一点，不会假装恢复已经生效。
- **主密钥不进备份包**：库里的 Token 仍是密文，换机器恢复时必须提供同一个
  `M365_CODEX_MASTER_KEY` 才能解密；备份包里只记录密钥版本号用于校验。
- 备份包按 `BACKUP_RETENTION_COUNT`（默认 7）份定时清理，超出的自动删除最旧的。
- `GET /admin/diagnostics`：脱敏诊断包——版本、数据库结构版本、账号状态分布、就绪检查、
  维护任务执行情况、脱敏配置摘要、错误分类计数，供报障时一次性交出。

---

## 安全设计

- **Token 加密存储**：AES-256-GCM，每个敏感字段独立随机 nonce，记录密钥版本以支持轮换；主密钥仅来自环境变量，无默认值。密文以账号 ID 作 AAD 绑定，搬到别的账号行上解不开。
- **PKCE 只用 S256**：不提供 plain 降级；`code_verifier` 同样加密入库；授权码通过原子 UPDATE 保证只消费一次，并发重放会被拒绝。
- **Token 刷新单飞**：同账号并发刷新共享同一个任务，避免互相覆盖 `refresh_token` 把账号刷坏；写回是事务化原子替换。
- **API Key 不落明文**：`sk-` + 52 位 CSPRNG Base62；库中只存 `SHA-256(每 Key 独立盐 ‖ Key)` 与用于索引的前缀；明文只在创建时返回一次。
- **恒定时间校验**：API Key 与管理密码比较全部使用 `timingSafeEqual`，避免时序侧信道。
- **日志脱敏**：`strict` 模式不记录请求体与提示词，IP 只保留网段（IPv4 `/24`、IPv6 `/48`）；`authorization`、`access_token`、`password` 等字段在任何模式下都被替换为 `[已脱敏]`。
- **登录节流**：管理端登录失败按 IP 计数，15 分钟内失败 8 次后临时拒绝。
- **容器加固**：非 root 运行、只读根文件系统、`no-new-privileges`、Healthcheck、SIGTERM 优雅退出；镜像不含开发依赖、账号文件、`.env` 或任何 Token。
- **仓库纪律**：只提交 `.env.example`；CI 中有凭据扫描，检测到疑似 `.env`、账号文件、硬编码 `sk-` 或 JWT 直接失败。

---

## 技术栈

TypeScript + Node.js ≥22 + Fastify；SQLite（WAL，使用 Node 内置 `node:sqlite`，无原生编译依赖）；Zod 校验；Pino 日志；AES-256-GCM 加密；Vitest 测试。单进程单容器，端口 `8080`，数据目录 `/data`。

## 开发命令

```bash
npm ci             # 安装依赖
npm run build      # 构建
npm run typecheck  # 类型检查（含测试文件）
npm run lint       # ESLint
npm test           # 单元与集成测试
npm run dev        # 开发模式（热重载）
```

## 贡献与许可

本项目以 [MIT 许可证](LICENSE) 发布。第三方依赖声明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

提交 PR 前请确保 `npm run typecheck`、`npm run lint`、`npm test` 全部通过，且**不包含任何真实凭据**。
