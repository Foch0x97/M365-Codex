import {
  MESSAGE_TYPE,
  RECORD_SEPARATOR,
  type ImageInputDescriptor,
  type InvocationInput,
  type ProtocolCodec,
  type RawMessage,
  type UpstreamEvent,
} from './protocol.js';

/**
 * Sydney JSON 协议 v1 编解码。
 *
 * 帧分隔与 SignalR 消息类型是既定规范，可靠。**消息内部字段的语义已在
 * 2026-07-27 用真实 M365 Copilot 账号（真实 WebSocket 握手 + 真实 access token）
 * 跑通校准**，结论如下（详见 `docs/里程碑进度.md` M0 一节）：
 *
 * 1. **请求侧**：`arguments[0]` 是单数 `message` 对象（`{author,inputMethod,text,
 *    messageType}`），不是旧版建模的 `messages` 数组；`participant.id`（账号 oid）、
 *    `conversationId`（续接时才带，首轮不传）、`requestId`、`isStartOfSession`、
 *    `source` 都是 `arguments[0]` 的顶层兄弟字段。这一版本把旧的 `messages: []`
 *    直接改成 `message: {}`，因为旧形态在真实上游前从未跑通过（一律
 *    `InvalidRequest`），保留一个「永远错」的兼容分支没有意义，直接替换更干净。
 * 2. **响应侧**：业务负载在 `type:2` 帧的 `item` 字段里，不是旧版建模的
 *    `arguments[0]`；`item.messages[]` 同时包含回显的用户消息与 bot
 *    消息，`item.result.value`（`Success`/`InvalidRequest`/`ForbiddenRequest`/
 *    `InternalError`/`Throttled`…）是错误通道，`item.result.errorCode`
 *    （如 `InvalidCopilotLicense`）是更细的错误分类；`item.conversationId`
 *    是本轮的会话标识；`type:3` completion 帧只有 `{type:3,invocationId}`，
 *    不带 payload。
 * 3. **`spokenText` 不是推理摘要**：实测同一条 bot 消息里 `spokenText` 与 `text`
 *    内容完全一致，只是语音合成友好版本（例如去掉部分标点/格式），旧实现把它
 *    映射成 `reasoning_delta` 是猜错了——继续这样做会把最终答案的内容重复一份
 *    伪装成"思考过程"发给客户端。现予以移除；真正的推理/思维链字段本轮未能
 *    验证（测试账号的 Copilot 许可证/配额问题导致没能拿到一次成功生成，见下）。
 * 4. **测试账号本身未能验证到成功生成**：请求被完整接受、正常解析、正常计费
 *    （`throttling.metering` 正常返回配额），但最终结果稳定停在
 *    `ForbiddenRequest`/`InvalidCopilotLicense`（`conversationId` 用默认值/省略
 *    走的分支）或 `InternalError`（`conversationId` 显式传空字符串 `''` 走的
 *    分支，绕过了前一个检查但止步于此）。这是账号自身的许可证/配额问题（此前
 *    已观察到这个账号的登录也会被安全策略拦截，是同一类账号侧限制），不是
 *    请求格式问题——两条路径的响应都是结构完整的业务对象而不是
 *    `InvalidRequest`，证明协议格式已被上游正确解析。因此这里
 *    按"首轮不传 conversationId，续接时才带"这个更自然、更可能是官方预期的
 *    形态实现（即前一条分支），而不是照抄"传空字符串"这个疑似意外生效的绕过
 *    写法。工具调用、图片输入、真实的推理字段仍待一个有完整许可证的账号验证。
 */

interface SydneyToolCall {
  callId?: string;
  id?: string;
  name?: string;
  /** 已完整的参数（JSON 字符串或对象） */
  arguments?: string | Record<string, unknown>;
  /** 参数增量（流式） */
  argumentsDelta?: string;
  /** 阶段：begin / delta / end */
  phase?: 'begin' | 'delta' | 'end';
}

/** 请求侧的单条消息（真实字段：单数对象，不是数组）。 */
interface SydneyOutboundMessage {
  author: string;
  inputMethod: string;
  text: string;
  messageType: string;
  [key: string]: unknown;
}

/** 发给上游的 invocation 参数（`arguments[0]`）。 */
interface SydneyInvocationArgument {
  source?: string;
  isStartOfSession?: boolean;
  message?: SydneyOutboundMessage;
  participant?: { id: string };
  conversationId?: string;
  requestId?: string;
  /** 工具声明/结果、图片：真实放置位置未经账号许可证限制验证，沿用兄弟字段的约定 */
  images?: ImageInputDescriptor[];
  [key: string]: unknown;
}

/** 响应侧 `item.messages[]` 里的一条消息（用户回显或 bot 回复）。 */
interface SydneyResponseMessage {
  text?: string;
  author?: string;
  messageType?: string;
  contentOrigin?: string;
  /** 语音合成友好版本，内容与 text 一致，不是推理摘要（见文件头注释第 3 条） */
  spokenText?: string;
  /** 观察到的失败标记；权威错误信息在 item.result 里，这里不单独据此判定 */
  turnState?: string;
  adaptiveCards?: unknown[];
  sourceAttributions?: { seeMoreUrl?: string; providerDisplayName?: string }[];
  /** 工具调用（M5，真实形态未经验证，沿用既有建模） */
  toolCalls?: SydneyToolCall[];
  [key: string]: unknown;
}

/** 响应侧的错误/结果通道。 */
interface SydneyResultBlock {
  value?: string;
  message?: string;
  errorCode?: string;
  serviceVersion?: string;
}

/** 响应侧 `type:2` 帧的 `item` 字段（真实位置，不是 `arguments[0]`）。 */
interface SydneyResponseItem {
  messages?: SydneyResponseMessage[];
  conversationId?: string;
  requestId?: string;
  result?: SydneyResultBlock;
  [key: string]: unknown;
}

function frame(payload: unknown): string {
  return JSON.stringify(payload) + RECORD_SEPARATOR;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export class SydneyCodecV1 implements ProtocolCodec {
  readonly version = 'sydney-json-v1';

  encodeHandshake(): string {
    return frame({ protocol: 'json', version: 1 });
  }

  isHandshakeAck(raw: string): boolean {
    const trimmed = raw.replaceAll(RECORD_SEPARATOR, '').trim();
    if (trimmed === '' || trimmed === '{}') return true;
    try {
      const parsed = JSON.parse(trimmed) as { error?: unknown; type?: unknown };
      // 握手 ack 是空对象或不含 error 的对象；带 error 说明握手失败
      return parsed.error === undefined && parsed.type === undefined;
    } catch {
      return false;
    }
  }

  encodeInvocation(input: InvocationInput): string {
    const argument: SydneyInvocationArgument = {
      // 与握手的 X-Scenario 头同源；M0 实测确认这个值下请求能被完整解析。
      source: 'officeweb',
      requestId: input.invocationId,
      // 首轮（没有 conversationRef）不传 conversationId，让上游分配新会话；
      // 续接时带上一轮拿到的会话标识。
      isStartOfSession: input.conversationRef === undefined,
      message: {
        author: 'user',
        inputMethod: 'Keyboard',
        text: input.text,
        messageType: 'Chat',
      },
      ...(input.conversationRef === undefined ? {} : { conversationId: input.conversationRef }),
      ...(input.participantId === undefined ? {} : { participant: { id: input.participantId } }),
      ...(input.tools === undefined || input.tools.length === 0 ? {} : { tools: input.tools }),
      ...(input.toolResults === undefined || input.toolResults.length === 0
        ? {}
        : { toolResults: input.toolResults }),
      ...(input.passthrough ?? {}),
    };
    return frame({
      type: MESSAGE_TYPE.STREAM_INVOCATION,
      invocationId: input.invocationId,
      target: 'chat',
      arguments: [argument],
    });
  }

  encodePing(): string {
    return frame({ type: MESSAGE_TYPE.PING });
  }

  encodeCancel(invocationId: string): string {
    return frame({ type: MESSAGE_TYPE.CANCEL_INVOCATION, invocationId });
  }

  isCompletion(message: RawMessage): boolean {
    return message.type === MESSAGE_TYPE.COMPLETION;
  }

  mapMessageToEvents(message: RawMessage): UpstreamEvent[] {
    // 心跳与关闭帧不产生业务事件
    if (message.type === MESSAGE_TYPE.PING || message.type === MESSAGE_TYPE.CLOSE) {
      return [];
    }

    // completion：真实上游的 completion 帧只有 {type:3,invocationId}，不带
    // payload（错误已经在前面的 STREAM_ITEM 帧里通过 item.result 发出）；
    // 这里保留 error 字段的兼容判断，以防某些异常路径确实把错误放在这一帧上。
    if (message.type === MESSAGE_TYPE.COMPLETION) {
      if (typeof message.error === 'string' && message.error !== '') {
        return [{ kind: 'upstream_error', message: message.error, retryable: false }];
      }
      return [{ kind: 'completed', stopReason: null }];
    }

    // stream item：业务负载在 item 里（M0 实测确认，不是 arguments[0]）
    const item = isRecord(message.item) ? (message.item as SydneyResponseItem) : undefined;
    if (item === undefined) return [];

    // 错误通道优先判定：result.value 非 'Success' 时，messages 里那条 bot
    // 消息本身就是这条错误的说明文案（例如 InvalidCopilotLicense/InternalError
    // 场景下 bot 会回一句道歉语），不能把它当成真实回答的正文下发。
    const result = item.result;
    if (
      result !== undefined &&
      typeof result.value === 'string' &&
      result.value !== '' &&
      result.value !== 'Success'
    ) {
      return [
        {
          kind: 'upstream_error',
          message: result.message ?? result.errorCode ?? result.value,
          // Throttled / 服务侧临时错误可重试
          retryable: result.value === 'Throttled' || result.value === 'InternalServerError',
        },
      ];
    }

    const events: UpstreamEvent[] = [];
    const sydneyMessages = Array.isArray(item.messages) ? item.messages : [];
    for (const msg of sydneyMessages) {
      if (msg.author === 'user') continue; // 回显的用户消息跳过

      if (typeof msg.text === 'string' && msg.text !== '') {
        events.push({ kind: 'text_delta', text: msg.text });
      }
      for (const attribution of msg.sourceAttributions ?? []) {
        if (typeof attribution.seeMoreUrl === 'string') {
          events.push({
            kind: 'citation',
            url: attribution.seeMoreUrl,
            title: attribution.providerDisplayName ?? null,
          });
        }
      }
      for (const call of msg.toolCalls ?? []) {
        events.push(...mapToolCall(call));
      }
    }
    return events;
  }
}

/**
 * 把上游工具调用消息映射为归一化事件。
 * 支持两种上游形态：一次性给出完整参数，或分 begin/delta/end 流式。
 *
 * ⚠️ 待校准：本轮账号的许可证/配额限制导致没能触发一次真实的工具调用，
 * 这里沿用此前基于通用 SignalR 逆向经验的建模，字段名与分段方式未经真实验证。
 */
function mapToolCall(call: SydneyToolCall): UpstreamEvent[] {
  const callId = call.callId ?? call.id;
  if (callId === undefined || callId === '') return [];

  // 流式：按 phase 分发
  if (call.phase === 'begin') {
    return [{ kind: 'tool_call_begin', callId, name: call.name ?? '' }];
  }
  if (call.phase === 'delta') {
    return call.argumentsDelta === undefined
      ? []
      : [{ kind: 'tool_call_args_delta', callId, delta: call.argumentsDelta }];
  }
  if (call.phase === 'end') {
    return [{ kind: 'tool_call_end', callId }];
  }

  // 一次性完整形态：拆成 begin + 一段 args_delta + end
  const argsString =
    typeof call.arguments === 'string'
      ? call.arguments
      : call.arguments === undefined
        ? '{}'
        : JSON.stringify(call.arguments);
  return [
    { kind: 'tool_call_begin', callId, name: call.name ?? '' },
    { kind: 'tool_call_args_delta', callId, delta: argsString },
    { kind: 'tool_call_end', callId },
  ];
}

/** 按协议版本选择 codec。上游协议再次漂移时在此追加新版本。 */
export function selectCodec(version: string): ProtocolCodec {
  switch (version) {
    case 'sydney-json-v1':
      return new SydneyCodecV1();
    default:
      // 未知版本回退到 v1，并在连接层记录告警
      return new SydneyCodecV1();
  }
}
