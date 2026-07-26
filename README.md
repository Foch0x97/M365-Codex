# M365-Codex

> 用「自定义 `base_url` + `sk-` 密钥」登录 Codex，把 Microsoft 365 Copilot 当作上游，获得接近官方 OpenAI 账号登录的本地编码体验。

[![CI](https://github.com/Foch0x97/M365-Codex/actions/workflows/ci.yml/badge.svg)](https://github.com/Foch0x97/M365-Codex/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**当前版本：`v0.4.0`（开发中，尚未发布可用版本）**

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
- 多 API Key 管理（有效期、限额、可撤销）、自定义公开地址、管理界面。

### 不能做什么（依赖 OpenAI 后端，本项目不会伪装实现）

Codex Cloud 云端任务、云端代码审查与云端 GitHub 集成、OpenAI 托管内置工具（`web_search` / `file_search` / `code_interpreter` / `computer_use` / `image_generation`）、ChatGPT 工作区 RBAC 与企业保留策略、依赖 OpenAI 的插件与 MCP、Embeddings / Realtime / Batch / Fine-tuning、官方用量计费面板。

此外，本项目**无法保证**你请求的 `model` 会被上游真实使用——上游实际使用哪个模型由 Microsoft 决定，本项目只做记录与如实上报。

### 取决于上游探测结果的能力

图片理解、PDF/Office 附件、长上下文上限、严格结构化 JSON、并行工具调用、思考等级是否真正分级、精确 token 用量、引用来源、取消及时性——这些能力是否可用取决于 M0 阶段对真实上游的探测结果，达不到门槛的不会默认启用。

---

## 快速开始

> 前置条件：一个可用的 Microsoft 365 Copilot 账号（授权步骤在管理界面完成，M2 里程碑提供）。

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

镜像发布在 GHCR：

```bash
docker pull ghcr.io/foch0x97/m365-codex:0.2.0
```

标签规则：`main` 与 `sha-<短哈希>` 跟随主分支；`0.2.0` / `0.2` 由版本 tag 产生；
`latest` **只在正式 Release 时移动**。支持 `linux/amd64` 与 `linux/arm64`。

```bash
docker compose -f docker/docker-compose.yml up -d
```

验证：

```bash
curl http://127.0.0.1:8080/healthz
```

`/readyz` 会额外校验主密钥可用、数据库迁移到位、数据目录可写，任一不通过返回 503。

### 3. 本地开发运行

```bash
npm ci
npm run build
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
| `EXTERNAL_ACCOUNTS_FILE` | 否 | 外部账号文件路径，见下节 |

**严禁**通过环境变量注入任何 Microsoft Token 或 OAuth 凭据。服务启动时会检测常见的注入变量名并拒绝启动；这些凭据只能经 PKCE 授权流程获取，并以 AES-256-GCM 加密入库。

---

## 添加 Microsoft 账号

### 方式一：管理界面授权（推荐）

1. 调用 `POST /admin/oauth/authorize-url` 拿到授权链接
2. 在浏览器打开，选择有 Copilot 权限的账号登录
3. 登录后会跳到 Microsoft 的 `nativeclient` 提示页，复制地址栏完整 URL
4. 把它提交给 `POST /admin/oauth/callback`

因为回调落在 Microsoft 自己的页面上，**本服务不需要公网可达**，也不用暴露回调端点。授权会话 10 分钟过期，授权码只能用一次，可以同时为多个账号并行授权。

### 方式二：从 M365 Native 授权助手导入

如果你已经在用本地的 M365 Native PKCE 授权助手，它写出的 `accounts.json` 可以直接导入：

```bash
curl -X POST http://127.0.0.1:8080/admin/accounts/import \
  -H "Authorization: Bearer <管理会话令牌>" \
  -H "Content-Type: application/json" \
  -d '{"file": "/mnt/m365-native/accounts.json"}'
```

导入按 `tid + oid` 去重，**只读源文件、绝不写回**，单条损坏不影响其余账号。

### 方式三：跟随外部容器实时同步 Token

若你在 Docker 中跑着持续刷新 Token 的 M365 Native 容器，把它的 `accounts.json` **只读**挂载进本容器：

```yaml
volumes:
  - /path/to/m365-native/accounts.json:/mnt/m365-native/accounts.json:ro
environment:
  EXTERNAL_ACCOUNTS_FILE: /mnt/m365-native/accounts.json
  EXTERNAL_ACCOUNTS_SYNC_INTERVAL_MS: "60000"
```

服务会按文件修改时间变化周期性同步账号池，账号过期不再中断使用。同步状态可通过 `GET /admin/accounts-sync/status` 查询，也可以用 `POST /admin/accounts-sync/run` 手动触发。

### 账号状态

每个账号处于以下状态之一：`probing`（待探测）、`online`、`busy`、`cooldown`（限流冷却）、`reauth_required`（刷新凭据失效，需重新授权）、`disabled`（人工停用）、`unsupported`（上游能力不满足）、`error`。

刷新凭据失效时账号会自动转入 `reauth_required` 并停止重试；人工停用的账号不会因一次重新授权被悄悄启用。

三种方式的完整说明见 [docs/对接M365-Native授权助手.md](docs/对接M365-Native授权助手.md)。

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

## 项目进度

按里程碑 M0–M9 推进，每个里程碑先写测试/契约，通过 DoD 后才进入下一步。各版本的具体内容见 [CHANGELOG.md](CHANGELOG.md)。

| 里程碑 | 内容 | 状态 |
|---|---|---|
| M0 | 上游能力探针（需真实账号，人工执行） | 未开始 |
| M1 | 工程骨架与安全底座 | ✅ 已完成 |
| M2 | OAuth（PKCE）与账号健康 | ✅ 已完成 |
| M3 | Sydney 适配器与账号池调度 | ✅ 已完成（框架，待 M0 校准协议） |
| M4 | Responses 非流式 + 流式 | ✅ 已完成 |
| M5 | 工具调用与完整代理循环 | 未开始 |
| M6 | 文件/图片/Office-PDF + Chat Completions | 未开始 |
| M7 | 幂等/恢复/清理 + 管理 WebUI | 未开始 |
| M8 | 迁移/备份/可观测 + Codex 实机验收 | 未开始 |
| M9 | 交付与发布（多架构镜像、安全门禁） | 未开始 |

---

## 技术栈

TypeScript + Node.js ≥22 + Fastify；SQLite（WAL，使用 Node 内置 `node:sqlite`，无原生编译依赖）；Zod 校验；Pino 日志；AES-256-GCM 加密；Vitest 测试；管理 WebUI 用 React + Vite（M7）。单进程单容器，端口 `8080`，数据目录 `/data`。

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
