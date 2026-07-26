# 对接 M365 Native 授权助手

本项目可以直接复用你已有的「M365 Native 本地 PKCE 授权助手」。三种用法，按需选择。

---

## 背景：两者的关系

M365 Native 助手做的事：跑一个本地网页，引导你在浏览器完成 Microsoft PKCE 授权，
把换到的 Token 写进 `accounts.json`。

M365-Codex 需要的东西：一批带有效 Token 的 Microsoft 账号。

两者的账号身份口径一致（都以 `tid` + `oid` 唯一标识账号），Token 结构也一致，
所以可以直接对接，不需要改造任何一方。

```
                    ┌─ 方式一：M365-Codex 自己发起授权（无需助手）
你的 Microsoft 账号 ─┼─ 方式二：助手写出 accounts.json → 手动导入一次
                    └─ 方式三：助手容器持续刷新 accounts.json → 自动周期同步
```

---

## 方式一：由 M365-Codex 直接发起授权

M365-Codex 内置了完整的 PKCE 流程，交互形态和助手完全一样，不需要额外跑助手。

**1. 生成授权链接**

```bash
curl -X POST http://127.0.0.1:8080/admin/oauth/authorize-url \
  -H "Authorization: Bearer <管理会话令牌>"
```

响应：

```json
{
  "authorize_url": "https://login.microsoftonline.com/common/oauth2/v2.0/authorize?...",
  "state": "3AeaOKjGyT0KV9pKBIkC9q7emv9EioTN",
  "expires_at": 1785061728176
}
```

**2. 在浏览器打开 `authorize_url`**，选择有 Copilot 权限的账号登录。

**3. 登录后会跳到 Microsoft 的 `nativeclient` 提示页**（页面本身是个警告页，属正常现象），
复制地址栏的完整 URL。

**4. 把它提交回来**

```bash
curl -X POST http://127.0.0.1:8080/admin/oauth/callback \
  -H "Authorization: Bearer <管理会话令牌>" \
  -H "Content-Type: application/json" \
  -d '{"callback": "https://login.microsoftonline.com/common/oauth2/nativeclient?code=...&state=..."}'
```

因为回调落在 Microsoft 自己的页面上，**M365-Codex 不需要公网可达**，也不用暴露回调端点。

### 注意事项

- 授权会话 **10 分钟过期**，超时需要重新生成链接。
- 授权码**只能用一次**，重复提交会被拒绝（并发提交也只有一次能成功）。
- 可以**同时开多个授权会话**为不同账号授权，互不干扰——每个会话有独立的
  `code_verifier` 和 `state`。
- 授权链接带 `prompt=select_account`，所以连续授权多个账号时不会被浏览器的既有会话粘住。

---

## 方式二：一次性导入助手的 accounts.json

如果你已经用助手授权好了一批账号，直接导入即可：

```bash
curl -X POST http://127.0.0.1:8080/admin/accounts/import \
  -H "Authorization: Bearer <管理会话令牌>" \
  -H "Content-Type: application/json" \
  -d '{"file": "/mnt/m365-native/accounts.json"}'
```

响应示例：

```json
{
  "total": 11,
  "created": 11,
  "updated": 0,
  "skipped": [],
  "source_updated_at": "2026-07-25T08:00:00Z"
}
```

### 导入行为

| 行为 | 说明 |
|---|---|
| 去重 | 按 `tid` + `oid`，重复账号走更新而非新增 |
| 源文件 | **只读**，绝不写回、绝不修改（测试断言源文件逐字节不变） |
| 身份补齐 | `tid`/`oid` 缺失时，从 `accessToken` / `idToken` 的声明中解析 |
| 容错 | 单条账号损坏只跳过该条，不影响其余账号 |
| 过期条目 | 默认**不跳过**——它们可能还带着有效的 `refresh_token` |
| BOM | 容忍 UTF-8 BOM（Windows 上的工具常会写入） |
| 隐私 | 返回值与日志中只有计数与脱敏邮箱（`fo***@example.com`），不含任何 Token |

导入后账号状态为 `probing`，Token 以 AES-256-GCM 加密入库。

---

## 方式三：跟随助手容器实时同步

如果你在 Docker 里跑着持续刷新 Token 的 M365 Native 容器，让 M365-Codex 跟着它走，
账号过期就不会中断使用。

### 挂载配置

```yaml
services:
  m365-codex:
    image: ghcr.io/foch0x97/m365-codex:latest
    volumes:
      # 只读挂载，M365-Codex 永远不会写这个文件
      - /path/to/m365-native/accounts.json:/mnt/m365-native/accounts.json:ro
      - m365-codex-data:/data
    environment:
      EXTERNAL_ACCOUNTS_FILE: /mnt/m365-native/accounts.json
      EXTERNAL_ACCOUNTS_SYNC_INTERVAL_MS: "60000"   # 最小 5000；填 0 表示只在启动时同步一次
```

### 同步行为

- 启动时立即同步一次，之后按间隔轮询。
- 按文件 **mtime** 判断是否变化，没变就不做任何写库操作。
- 同步失败（文件不可读、JSON 损坏）**只记日志，不抛异常**——外部文件出问题不会拖垮服务，
  已入库的账号也不受影响。
- 导入来源标记为 `sync:m365-native`，可在账号列表里区分于人工授权的 `oauth`。

### 查询与手动触发

```bash
# 查看同步状态
curl http://127.0.0.1:8080/admin/accounts-sync/status \
  -H "Authorization: Bearer <管理会话令牌>"

# 忽略 mtime 强制立即同步一次
curl -X POST http://127.0.0.1:8080/admin/accounts-sync/run \
  -H "Authorization: Bearer <管理会话令牌>"
```

状态响应示例：

```json
{
  "enabled": true,
  "file": "/mnt/m365-native/accounts.json",
  "interval_ms": 60000,
  "state": {
    "last_run_at": 1785061128176,
    "last_success_at": 1785061128176,
    "last_error": null,
    "last_summary": { "total": 11, "created": 0, "updated": 11, "skipped": 0 },
    "file_mtime_ms": 1785061127882
  }
}
```

---

## 支持的账号文件格式

即助手 `upsert_account()` 写出的结构：

```json
{
  "source": "pkce-browser-gateway-local",
  "clientId": "...",
  "redirectUri": "https://login.microsoftonline.com/common/oauth2/nativeclient",
  "updatedAt": "2026-07-25T08:00:00Z",
  "accounts": [
    {
      "id": "…", "email": "…", "displayName": "…", "status": "online",
      "accessToken": "…", "refreshToken": "…", "idToken": "…",
      "expiresAt": "2026-07-25T09:00:00Z", "updatedAt": "2026-07-25T08:00:00Z",
      "tid": "…", "oid": "…", "aud": "https://substrate.office.com/sydney"
    }
  ]
}
```

实际只有 `accessToken` 是必需的；`tid`/`oid` 缺失会从 Token 声明里补齐，
其余字段缺失不影响导入。

---

## Token 刷新由谁负责

导入之后，**M365-Codex 会用自己保存的 `refresh_token` 独立刷新 Token**，
不依赖助手继续运行：

- Token 剩余寿命少于 5 分钟时自动提前刷新；
- 同一账号的并发刷新会合并成一个任务，避免互相覆盖 `refresh_token`；
- 刷新凭据失效（`invalid_grant`）时账号转入 `reauth_required` 并停止重试，
  需要重新走一次授权。

所以方式三的实时同步是**冗余保障**而非必需——即使助手容器停了，
只要 `refresh_token` 还有效，M365-Codex 自己就能续期。

---

## 安全边界

- 账号文件**只读**，本项目在任何路径下都不会写回它。
- Token 落库前一律 AES-256-GCM 加密，密文以账号 ID 作 AAD 绑定，
  搬到别的账号行上解不开。
- 所有管理接口的响应、审计日志、运行日志中都不会出现 Token 明文。
- **不要**把 `accounts.json` 放进本仓库或镜像里——`.gitignore` 与 `.dockerignore`
  都已拦截，CI 也有凭据扫描。
