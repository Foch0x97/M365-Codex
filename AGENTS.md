# 给编码 agent 的说明

**权威执行口径在 [M365-Codex-实施执行计划.md](M365-Codex-实施执行计划.md)，动手前先完整读一遍，尤其是 §0 硬约束、§1 护栏、§7 功能范围。**

当前进度与下一步见 [docs/里程碑进度.md](docs/里程碑进度.md)。

## 不可逾越的红线

1. **绝不**把真实 Token、邮箱、账号文件、PAT、Cookie、真实对话写入仓库、镜像、测试夹具或日志。仓库里只提交 `.env.example`。
2. Token 必须 AES-256-GCM 加密入库，主密钥只来自 `M365_CODEX_MASTER_KEY`，**无默认值**。
3. 对外 API Key 用 `sk-` 前缀，库里只存哈希（SHA-256 + 每 Key 独立盐）与索引前缀。
4. **不造模型别名**。`model` 与 `reasoning.effort` 原样透传，只记录、不改写、不枚举取值。
5. Codex 只用 `wire_api = "responses"`；`/v1/chat/completions` 保留给其他兼容客户端，不供 Codex 自身。
6. 上游 URL / 路径 / scope / CLIENT_ID **一律走配置**，禁止硬编码进业务逻辑——上游端点会漂移。
7. **不实现做不到的功能**（§7）。影响语义又无法实现的参数必须返回清晰错误，不得静默伪装生效。
8. 容器非 root 运行，SIGTERM 优雅退出，提供 Healthcheck；镜像不含开发依赖、账号文件、`.env`、任何 Token。
9. 遇到 ⚠️ 标记的环节（M0 真实探针、M8 Codex 实机验收、M9 主机验收、任何 PAT/账号/密钥）**停下交回人工**。

## 工作方式

- 逐里程碑执行，**每步过完 DoD 再进入下一步**；每完成一个里程碑提交一次。
- 每个里程碑**先写测试 / OpenAPI 契约，再实现**。
- 集成测试用**模拟 Sydney WebSocket 上游**，不依赖真实 Token。
- 文档、提交信息、变更记录一律用中文。

## 提交前自检

```bash
npm run typecheck   # 类型检查（含测试文件）
npm run lint        # ESLint
npm test            # 单元与集成测试
npm audit --audit-level=high
```

四项全过，且确认改动中不含任何真实凭据，才可以提交。

## 代码约定

- TypeScript 严格模式，ESM，`import type` 区分类型导入。
- 注释写「为什么」，不写「这行在干什么」；用中文。
- 数据访问集中在 `apps/server/src/repo/`，`node:sqlite` 的行类型转换统一走 `asRow` / `asRows`。
- 抛业务错误用 `packages/shared` 的 `ApiError`，由全局错误处理器转成统一错误体。
- 新增数据表写新的迁移版本，**不修改已发布的迁移**。
