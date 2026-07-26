# M365-Codex 管理 WebUI

`@m365-codex/web` —— M365-Codex 的管理后台前端。React + Vite + TypeScript，手写 CSS（不引 UI 框架、不引图标包、不引 CDN 资源）。

这是独立子包，**不在**仓库根 npm workspace 里，有自己的 `package.json` 与 `package-lock.json`；
生产构建产物挂载在服务端的 `/ui/` 路径下（`/admin/*` 留给 JSON 管理 API，两者不共用前缀）。

## 开发

```bash
cd apps/web
npm install
npm run dev
```

默认会把 `/admin`、`/v1` 请求代理到 `http://127.0.0.1:8080`（服务端默认端口），
可用 `VITE_API_TARGET` 环境变量覆盖，例如：

```bash
VITE_API_TARGET=http://192.168.0.5:8080 npm run dev
```

### 不依赖服务端独立开发（Mock 模式）

服务端的 M7 接口（概览、代理池、设置等）实现之前，可以整站切到内存模拟数据：

```bash
VITE_USE_MOCK=1 npm run dev
```

模拟数据定义在 `src/api/mock.ts`，域名统一用 `*.example.invalid`，不含任何真实凭据。
`VITE_USE_MOCK` 也可以写进 `.env.local`（参考 `.env.example`）。

真实模式与 Mock 模式共用同一个 `AdminApi` 接口（`src/api/adminApi.ts`），
页面代码只从 `src/api/index.ts` 导入 `api`，不关心当前跑的是哪一个实现。

## 构建

```bash
npm run build
```

产物输出到 `apps/web/dist`，`base` 固定为 `/ui/`（由服务端接静态托管，本仓库其余部分不需要改）。

## 测试

```bash
npm test          # 一次性运行
npm run test:watch
```

用 vitest + @testing-library/react，覆盖这几条关键路径：

- 登录守卫：未登录访问任何受保护页面都会被重定向回登录页（`src/test/loginGuard.test.tsx`）。
- API Key 明文一次性展示：创建后弹窗展示明文，勾选「我已保存」前无法关闭，关闭后明文不再残留在 DOM 里、列表只显示掩码（`src/test/apiKeyReveal.test.tsx`）。
- 统一错误体展示：`ErrorBanner` 把 `type`/`message`/`param`/`request_id` 都友好地渲染出来（`src/test/errorBanner.test.tsx`）。
- 代理地址掩码：代理池列表不会把完整地址（含用户名密码）泄露到 DOM 里（`src/test/proxyMask.test.tsx`）。

不追求全覆盖，只保证这几条红线不被破坏。

## 目录结构

```text
src/
  api/          与服务端的接口层：types.ts（契约类型）、adminApi.ts（接口定义）、
                client.ts（真实实现）、mock.ts（模拟实现）、http.ts（fetch 封装）
  auth/         登录会话：AuthContext（令牌只放内存 + sessionStorage）、RequireAuth（路由守卫）
  components/   通用组件：Layout、StatusBadge、ErrorBanner、CopyButton、RevealApiKeyModal 等
  hooks/        useAsync：统一 loading / error / data 三态
  pages/        每个导航项一个页面
  styles/       手写 CSS + CSS 变量，theme.css 管深浅色，global.css 管布局与组件样式
  util/format.ts 时间戳/字节数/百分比等展示格式化
```

## 安全要点（照 AGENTS.md 的红线执行）

- 会话令牌只放 React state（内存）与 `sessionStorage`，绝不写 `localStorage`，也绝不出现在任何
  `console.*` 调用里；收到 401 会自动清空会话并跳回登录页。
- API Key 明文只在创建那一刻显示一次，关闭确认弹窗后组件状态里也不再持有它；列表接口本来就只返回掩码。
- 代理池地址在 UI 侧同样按掩码形态展示，不在 DOM 里拼出完整的用户名密码。
- 所有真实凭据、邮箱、域名在代码/测试夹具里一律使用 `*.example.invalid` 之类的占位值。

## 已知的服务端对齐风险

WebUI 完全按 `docs/管理端API契约.md` 写（`src/api/client.ts`），但那份契约文档定稿时，
M1–M2 的账号/OAuth 接口其实已经实现过一版，两边字段有几处对不上。前端已经按**契约文档**实现，
下面这几处如果服务端保留的是旧实现，需要二选一对齐：

1. **账号状态变更**：契约写的是 `PATCH /admin/accounts/:id`（body `{status}`）；
   现有 `apps/server/src/routes/accounts.ts` 实现的是 `PATCH /admin/accounts/:id/status`。
2. **OAuth 回调入参**：契约写的是 `{redirect_url}` 或 `{code, state}`；
   现有实现读的是 `{callback}`。前端目前发送 `{redirect_url: callbackUrl}`。
3. **账号视图里的 `proxy_id`**：`src/api/types.ts` 的 `AccountView` 加了这个字段（代理池是
   M7 才新增的能力，M1–M2 的 `AccountView` 里没有），以及 `POST /admin/accounts/:id/proxy`
   绑定接口——这两个都还没有服务端实现可以对照，是前端按契约文档 §2.4 推测的形状。
4. **`/admin/settings` 各分组的具体字段名**：契约文档只给了分组名
   （`network`/`scheduler`/`logging`/`oauth`/`tools`/`files`），没有列出每个分组下具体有哪些字段。
   `src/api/types.ts` 里的 `NetworkSettings`/`SchedulerSettings`/... 是前端根据实施计划 §10/§12
   和 `.env.example` 里的配置项推测出来的字段名，服务端实现时字段名很可能需要调整，
   前端这边对齐起来只是改 `types.ts` + `SettingsGroupPage` 用到的 `SettingFieldMeta[]`，改动量不大。
5. **请求/工具调用列表的可空字段**：契约文档没有逐字段标注是否可为 `null`，
   `src/api/types.ts` 里的 `null` 标注（例如 `account_id`、`api_key_id`）是前端按业务含义推测的，
   服务端返回形状如果不同，以服务端为准即可，字段名本身不会变。

两边对齐后可以把这一段删掉。
