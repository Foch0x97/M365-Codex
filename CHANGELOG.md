# 更新记录

本文件记录本项目所有值得注意的变更。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

版本策略：`0.x` 为开发期版本，每完成一个里程碑发一个次版本号；全部里程碑通过 DoD 且完成 Codex 实机验收后，发布首个正式版 `v1.0.0`。

---

## [未发布]

### 计划中

- M2：PKCE 授权流程、Token 刷新与轮换、账号状态机

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

[未发布]: https://github.com/Foch0x97/M365-Codex/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Foch0x97/M365-Codex/releases/tag/v0.1.0
