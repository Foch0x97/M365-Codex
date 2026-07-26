import {
  MESSAGE_TYPE,
  RECORD_SEPARATOR,
  type InvocationInput,
  type ProtocolCodec,
  type RawMessage,
  type UpstreamEvent,
} from './protocol.js';

/**
 * Sydney JSON 协议 v1 编解码。
 *
 * 帧分隔与 SignalR 消息类型是既定规范，可靠；消息内部字段的语义
 * （`arguments[0].messages[].text` 等）是基于已知的 Bing/BizChat 逆向形态建模，
 * **待 M0 探针用真实上游校准**。到时只需在此文件调整 `mapMessageToEvents`
 * 与 `encodeInvocation`，或新增 codecV2 并在 `selectCodec` 里按版本切换，
 * 上层连接、心跳、调度逻辑都不受影响。
 */

interface SydneyArgument {
  messages?: SydneyMessage[];
  requestId?: string;
  result?: { value?: string; message?: string };
  [key: string]: unknown;
}

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

interface SydneyMessage {
  text?: string;
  author?: string;
  messageType?: string;
  contentOrigin?: string;
  /** 思考/推理摘要，若上游提供 */
  spokenText?: string;
  adaptiveCards?: unknown[];
  sourceAttributions?: { seeMoreUrl?: string; providerDisplayName?: string }[];
  /** 工具调用（M5，建模字段，待 M0 校准真实形态） */
  toolCalls?: SydneyToolCall[];
  [key: string]: unknown;
}

function frame(payload: unknown): string {
  return JSON.stringify(payload) + RECORD_SEPARATOR;
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
    const argument: SydneyArgument = {
      requestId: input.invocationId,
      messages: [{ author: 'user', text: input.text, messageType: 'Chat' }],
      ...(input.conversationRef === undefined ? {} : { conversationId: input.conversationRef }),
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

    // completion：可能带错误
    if (message.type === MESSAGE_TYPE.COMPLETION) {
      if (typeof message.error === 'string' && message.error !== '') {
        return [{ kind: 'upstream_error', message: message.error, retryable: false }];
      }
      return [{ kind: 'completed', stopReason: null }];
    }

    // stream item / invocation：从 arguments 里取增量
    const events: UpstreamEvent[] = [];
    const args = Array.isArray(message.arguments) ? (message.arguments as SydneyArgument[]) : [];
    for (const arg of args) {
      const sydneyMessages = Array.isArray(arg?.messages) ? arg.messages : [];
      for (const msg of sydneyMessages) {
        if (msg.author === 'user') continue; // 回显的用户消息跳过

        if (typeof msg.spokenText === 'string' && msg.spokenText !== '') {
          events.push({ kind: 'reasoning_delta', text: msg.spokenText });
        }
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

      // 部分上游把致命错误放在 arg.result 里
      const result = arg?.result;
      if (
        result !== undefined &&
        typeof result.value === 'string' &&
        result.value !== '' &&
        result.value !== 'Success'
      ) {
        events.push({
          kind: 'upstream_error',
          message: result.message ?? result.value,
          // Throttled / 服务侧临时错误可重试
          retryable: result.value === 'Throttled' || result.value === 'InternalServerError',
        });
      }
    }
    return events;
  }
}

/**
 * 把上游工具调用消息映射为归一化事件。
 * 支持两种上游形态：一次性给出完整参数，或分 begin/delta/end 流式。
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

/** 按协议版本选择 codec。M0 校准出真实协议后在此追加新版本。 */
export function selectCodec(version: string): ProtocolCodec {
  switch (version) {
    case 'sydney-json-v1':
      return new SydneyCodecV1();
    default:
      // 未知版本回退到 v1，并在连接层记录告警
      return new SydneyCodecV1();
  }
}
