# M365-Codex M0 上游能力探针

用真实 Microsoft 365 Copilot 账号跑一遍固定用例，产出一份**脱敏能力报告**，
据此校准 `apps/server/src/adapter/codecV1.ts` 里的建模字段与 `TOOLS_MODE`、
`UPSTREAM_IMAGE_INPUT` 等配置项。对应实施计划 §3 与里程碑 M0（硬门槛）。

## ⚠️ 风险提示（务必先读）

M365-Codex 依赖的上游是**未公开、逆向得到**的 Sydney/BizChat WebSocket 协议，且需要
使用你自己的 Microsoft 账号令牌。这种用法**很可能违反 Microsoft 服务条款**，可能触发
账号风控、能力变更甚至封禁；上游协议随时可能变化导致探测失败。本工具与其报告**不构成
任何官方兼容承诺**，仅供本人学习与自用评估。请只对你本人有权使用的账号与数据操作，
并自行评估组织策略、法律与账号风险。

因此：

- CLI 必须显式加 `--i-understand-the-risk` 才会真正发起对上游的请求；不加只能列出账号。
- 默认**串行**执行、用例之间插入 `--delay-ms`（默认 1000ms）间隔，不并发轰炸账号。
- 不会主动构造 401/403/429（例如故意用坏 Token）去触发错误分类——那样做本身就有
  触发风控的风险；错误分类用例采用被动观察（见下文「用例说明」#24/#25）。
- 任何一项用例失败都不会中断整轮探测，只记录该项的错误分类，继续跑下一项。

## 前置条件

1. 账号只能通过网关自己的 PKCE 授权流程添加（这是有意的安全约束），所以先确保
   `apps/server` 的数据库里已经有至少一个 `online` 状态的账号（正常使用网关添加账号即可）。
2. 探针复用 `apps/server` 的适配器代码，**从已构建的 `apps/server/dist` 里直接 import**，
   不新写一套 WebSocket 客户端，也不修改 `apps/server/**`。因此运行前必须先构建服务端：

   ```bash
   # 在仓库根目录
   npm run build:server
   ```

   如果只改了探针自身代码而没改 `apps/server`，不需要重新构建。但如果 `apps/server/dist`
   是很久以前构建的、后续 `apps/server/src` 有过更新，探针会用**过时的 dist**——这是
   「不改服务端、直接引用 dist」这个方案本身的取舍，务必在跑探针前确认 dist 是最新的。

3. 安装探针自己的依赖（独立子包，不进根 workspace）：

   ```bash
   cd probe
   npm install
   ```

## 完整命令行用法

```bash
# 1. 列出数据库里可选的账号（不会发起任何真实上游请求，不需要 --i-understand-the-risk）
M365_CODEX_MASTER_KEY=<与网关一致的主密钥> \
  npx tsx src/index.ts --db ../data/m365-codex.sqlite --list

# 2. 跑指定账号的全部 29 项
M365_CODEX_MASTER_KEY=<与网关一致的主密钥> \
  npx tsx src/index.ts \
    --db ../data/m365-codex.sqlite \
    --account <account-id> \
    --i-understand-the-risk \
    --refresh-first \
    --repeat 20 \
    --delay-ms 1000

# 3. 跑数据库里的全部账号（用于 §3.1 第 26 项「账号/租户能力差异」的横向对比）
M365_CODEX_MASTER_KEY=<与网关一致的主密钥> \
  npx tsx src/index.ts --db ../data/m365-codex.sqlite --all --i-understand-the-risk
```

### 参数说明

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `--db <路径>` | `./data/m365-codex.sqlite` | 网关的 SQLite 数据库文件路径 |
| `--account <id>` | 无 | 只跑指定账号；不传且不加 `--all` 时列出可选账号 |
| `--all` | 关闭 | 跑数据库里的全部账号 |
| `--list` | 关闭 | 显式只列出账号，不探测 |
| `--refresh-first` | 关闭 | 探测前先强制刷新一次 Token（顺带验证 §3.1 第 22/23 项） |
| `--repeat <N>` | `20` | 统计类用例（工具调用四项门槛）的采样次数 |
| `--delay-ms <ms>` | `1000` | 用例之间、统计采样试次之间的间隔 |
| `--invocation-timeout-ms <ms>` | `60000` | 单次 invocation 的整体超时 |
| `--i-understand-the-risk` | 关闭 | 必须显式加上才会真正发起上游请求 |

环境变量：

- `M365_CODEX_MASTER_KEY`（必需）：与网关一致的主加密密钥，用于解密数据库里的 Token。
- `MASTER_KEY_VERSION`（可选，默认 `1`）：与网关一致的密钥版本号。
- `UPSTREAM_WS_BASE` / `UPSTREAM_PATH_TEMPLATE` / `UPSTREAM_PROTOCOL_VERSION` /
  `UPSTREAM_HEARTBEAT_INTERVAL_MS` / `UPSTREAM_HANDSHAKE_TIMEOUT_MS` /
  `UPSTREAM_IDLE_TIMEOUT_MS`（可选）：与网关同名同义，默认值与网关一致；把探针指向
  模拟上游或未来漂移后的真实端点时用得上。
- `PROBE_OUT_DIR`（可选）：报告输出目录，默认 `probe/out/`。

## 报告产出

`probe/out/probe-<ISO 时间戳>.md`（人读）+ `probe/out/probe-<同一时间戳>.json`（机器读）：

- 29 项能力的状态表（`native` / `adaptable` / `partial` / `unsupported` / `unstable` / `unknown`）。
- §3.5 通过标准逐条判定 + 总体结论（「可进入完整开发」/「需缩小首发范围」）。
- 若工具调用只能靠提示词模拟，附四项统计指标（工具名识别率、首次参数通过率、两次修复后
  通过率、未声明工具调用次数、正文重复输出次数）的实测值与门槛对比，样本量不足 20 时
  会提示置信度较低。
- 校准建议：观察到的真实帧字段与 `codecV1.ts` 建模字段的差异清单、建议的 `TOOLS_MODE`
  取值、`UPSTREAM_IMAGE_INPUT` 是否可以打开、观察到的限流阈值与 Retry-After 行为。
- 若用 `--all` 跑了多个账号，报告末尾会有「账号 / 租户能力差异」的横向对比表。

`probe/out/` 与 `probe/samples/` 已在根 `.gitignore` 里，产出物不会被提交。

## 29 项用例怎么探测（对应 §3.1）

探针工作在**适配器层**：直接对着 Sydney WebSocket 跑，不经过完整的 Responses 网关，
每个用例独立开一次或几次 WebSocket 连接（`src/rawSession.ts`），互不共享可变状态，
一项失败不影响其他项。

| # | 能力 | 探测方式 |
| --- | --- | --- |
| 1 | WebSocket 握手与鉴权 | 建连 + 握手 + 发一段固定短文本，看是否能收到任意响应帧 |
| 2 | 普通文本对话 | 发固定短文本，检查是否收到非空文本回复 |
| 3 | 流式文本响应 | 统计一轮里 `text_delta` 事件数量：≥2 视为真流式，1 个视为一次性吐出 |
| 4 | 图片理解 | 探针自己生成一张 4x4 纯色 PNG（不用用户文件），走 `passthrough.images` 约定发送，问回复是否提到正确颜色 |
| 5 | 文本附件 | 对比「内联提取文本到正文」（M6 现有做法）与「探针自定义 attachments 字段」两种方式的效果 |
| 6 | PDF 与 Office 附件 | 同上，用一段固定的「模拟 PDF 提取文本」做摘要请求 |
| 7 | 连续会话 | 第一轮设定一个标记词，第二轮带着识别出的 conversationRef 续接，检查回复是否还记得标记词 |
| 8 | 上游会话恢复 | 同上，但两轮之间显式等待（默认 2× `--delay-ms`）并用全新 WebSocket 连接续接 |
| 9 | 长上下文承载能力 | 发送约 2 万字符的固定长文本，看是否正常接受并回复 |
| 10 | Instructions 注入方式 | 对比 `passthrough.instructions` 字段与文本前缀两种注入方式，用回复长度做启发式判断 |
| 11 | 结构化 JSON 输出 | 约束提示词要求输出固定形状的 JSON，尝试直接解析/剥离多余文字后解析 |
| 12 | 工具定义理解 | 同时打开「原生 `tools` 字段」与「提示词约束」两条通道，看命中哪一条 |
| 13 | 单次工具调用 | 按 `--repeat` 反复采样，每次试次内最多两次参数修复，统计 §3.5 的四项指标 |
| 14 | 多轮工具调用 | 同一 conversationRef 内连续两轮都需要触发工具调用 |
| 15 | 并行工具调用 | 提示词要求一次性调用两个工具，统计一轮里出现的工具调用数量 |
| 16 | 工具结果回传后继续生成 | 构造 `ToolResultInput` 回传，检查是否有延续性文本回复且不重复触发同一调用 |
| 17 | 请求取消 | 收到首个分片后立即 `AbortController.abort()` 并发送 stop 帧，检查是否及时停止 |
| 18 | Token 使用量 | 递归扫描原始帧，查找键名匹配 `token`/`usage` 的字段 |
| 19 | 引用与来源信息 | 问一个可能需要联网信息的问题，检查是否出现 `sourceAttributions`／`citation` 事件 |
| 20 | 模型名称选择 | 带 `passthrough.model` 发请求，看是否被拒绝 |
| 21 | 上游返回的实际模型信息 | 让模型自报模型名，同时扫描原始帧里是否有 `model` 字段 |
| 22 | Access Token 刷新 | 调用 `TokenManager.refresh()`，比较刷新前后过期时间是否延后 |
| 23 | Refresh Token 轮换 | 比较刷新前后 `refresh_token` 是否变化（只比较是否相同，不记录明文） |
| 24 | 错误分类 | 被动观察：发一次正常请求，如实记录命中的分类；完整错误矩阵靠全轮自然出现的各类错误汇总 |
| 25 | Retry-After 与限流行为 | 被动观察：不主动构造 429，若自然遇到则记录解析出的冷却毫秒数 |
| 26 | 账号/租户能力差异 | 单账号本身不产出新请求，只记录指纹；`--all` 时报告末尾横向对比 |
| 27 | 会话与账号绑定关系 | 用一个凭空捏造、从未由上游签发的 conversationRef 续接，检查是否意外读到其他会话内容 |
| 28 | Token 刷新后会话续接 | 建立会话 → 强制刷新 Token → 用新 Token 续接同一 conversationRef |
| 29 | 客户端断开后能否取消 | 收到首个分片后**不发送**任何 stop 帧、直接断开连接，观察客户端侧是否干净收尾 |

## 脱敏层拦了什么（`src/evidence.ts`）

报告只能经这一层输出，硬性规则：

- 禁止出现的键名（`access_token`／`refresh_token`／`id_token`／`code`／`code_verifier`／
  `cookie`／`authorization`／`password`／`client_secret`／`master_key` 等，大小写不敏感）
  命中即整体替换为 `<redacted:forbidden-key>`，不管值是字符串还是嵌套对象。
- 其余所有字符串值默认替换为 `<string:长度>`（保留字段名与类型），只有调用方明确传入的
  「我们自己发出去的固定测试文本」字面量才原样保留。
- 兜底启发式：即使键名不敏感，JWT 形态（`eyJ...\....\....`）、URL 里的 `access_token=`
  查询参数、`Bearer ...` 认证头，一律判定为「疑似密钥」并脱敏。
- 邮箱只保留掩码形态（`fo***@example.com`），租户/对象 ID 只保留前 8 位。
- 写盘前有最后一道防线（`assertReportClean`）：对渲染后的完整 Markdown/JSON 文本再扫一遍
  上述几种敏感形态，命中就直接抛异常、不落盘，而不是静默再脱敏一次。
- `test/evidence.test.ts` 覆盖：普通字符串脱敏、allowlist 放行、禁止键名、JWT 启发式、
  URL 查询参数、数组截断、嵌套对象、`maskId`/`maskEmail`/`redactWsUrl`、以及
  `assertReportClean` 对各类泄露形态与「掩码邮箱不能被误判为泄露」的双向覆盖。

## 自测（只打模拟上游）

```bash
cd probe
npm run typecheck
npm test
```

`test/` 下的用例只连 `apps/server/test/helpers/mockSydneyServer.ts` 起的模拟 Sydney
WebSocket 上游，绝不连真实 Microsoft，也不含任何真实凭据、真实邮箱、真实域名。覆盖：

- `evidence.test.ts`：脱敏层的全部规则（见上）。
- `rawSession.test.ts`：连接引擎对正常对话、引用、401/429（含 Retry-After 解析）、
  异常关闭码、限流、空闲超时、主动取消、工具调用的处理。
- `toolCall.test.ts`：工具调用检测（原生/提示词双通道）、参数修复、未声明工具、并行调用。
- `cases.test.ts`：抽样几个代表性用例端到端跑一遍模拟上游，并验证
  `runCaseSafely` 确实能接住内部异常、`ALL_CASES` 恰好是 29 项且序号不重复。
- `verdict.test.ts`：§3.5 判定逻辑（核心九条、统计门槛达标/不达标、样本量提示）。
- `report.test.ts`：Markdown/JSON 渲染、多账号对比表、写盘前的脱敏检查会真的拦截泄露内容。

## 跑完之后怎么用报告校准项目

1. 打开 `probe-<时间戳>.md`，先看**总体结论**：「可进入完整开发」还是「需缩小首发范围」；
   后者要看「建议缩小的范围」列表，决定首发要不要临时关闭某些能力（如图片输入、工具调用）。
2. 看「校准建议」里「观察到但未在 codecV1.ts 建模的字段」——这些是真实上游帧里出现、
   但 `apps/server/src/adapter/codecV1.ts` 目前没读的字段，去 `mapMessageToEvents` 里
   补上对应的映射逻辑。「建模了但从未观察到」的字段则要复核是不是当初建模猜错了。
3. 把「建议 `TOOLS_MODE` 取值」同步到部署配置的 `TOOLS_MODE` 环境变量
   （`native`/`prompt`/`auto`，见 `apps/server/src/config/index.ts`）。
4. 把「`UPSTREAM_IMAGE_INPUT`」的建议同步到同名环境变量；只有报告里明确观察到图片
   输入生效时才打开，默认继续保持 `false`。
5. 「观察到的 Retry-After」用于校准调度器的默认冷却时长（`scheduler/dispatcher.ts`
   与 `accountPool.ts` 目前的冷却策略是否要调整）。
6. 若工具调用只能靠提示词模拟且四项门槛未达标，首发版本按 §3.5 的要求缩小工具调用的
   默认可用范围（不默认启用、在兼容矩阵里如实标注 `unstable`），不得伪装为已支持。
7. 如果用 `--all` 跑了多个账号，看报告末尾「账号 / 租户能力差异」表，确认结论是否
   在不同租户/账号类型（个人 vs 企业 Copilot 授权）之间稳定，不稳定的项在兼容矩阵里
   标注为因账号而异。

## 硬性约束提醒（不要在改动探针时违反）

- 不修改 `apps/server/**`、`apps/web/**`、`Dockerfile`、`.github/**`、根 `package.json`。
- 自动化测试只打模拟上游，绝不连真实 Microsoft；测试里不得出现任何真实凭据/邮箱/域名。
- Token 只在内存里用于构造 WebSocket URL，绝不写进任何文件、日志、报告。
