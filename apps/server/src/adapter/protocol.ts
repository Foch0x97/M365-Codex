/**
 * Sydney / BizChat 线协议编解码（版本隔离层）。
 *
 * 上游用的是 SignalR 风格的 JSON 协议：每条消息是一段 JSON，以记录分隔符
 * `0x1e`（RS）结尾。握手后客户端发起一次 invocation，服务端流式回若干帧，
 * 最后给出 completion。
 *
 * 帧分隔（0x1e）是 SignalR 既定规范，稳定可依赖。**消息内部的字段语义**已在
 * 2026-07-27 用真实账号跑通 M0 校准：请求侧是单数 `message` 对象（不是
 * `messages` 数组），响应侧的业务负载在 `item` 字段里（不是 `arguments[0]`）——
 * 详见 `codecV1.ts` 顶部注释与 `docs/里程碑进度.md` 的 M0 一节。这一步仍单独
 * 抽成 `mapMessageToEvents`，作为未来上游协议再次漂移时的替换接缝；整个 codec
 * 通过 `ProtocolCodec` 接口暴露，可按 `protocolVersion` 切换不同实现。
 */

/** 记录分隔符：SignalR JSON 协议每条消息以它结尾。 */
export const RECORD_SEPARATOR = '\x1e';

/** SignalR 消息类型。 */
export const MESSAGE_TYPE = {
  INVOCATION: 1,
  STREAM_ITEM: 2,
  COMPLETION: 3,
  STREAM_INVOCATION: 4,
  CANCEL_INVOCATION: 5,
  PING: 6,
  CLOSE: 7,
} as const;

/** 解析出的原始上游消息。字段是 SignalR 通用形态，内部语义留给映射层。 */
export interface RawMessage {
  type: number;
  target?: string;
  invocationId?: string;
  arguments?: unknown[];
  item?: unknown;
  result?: unknown;
  error?: string;
  [key: string]: unknown;
}

/** 归一化上游事件。M4 会把它映射到 Responses 的 SSE 事件。 */
export type UpstreamEvent =
  | { kind: 'text_delta'; text: string }
  | { kind: 'reasoning_delta'; text: string }
  | { kind: 'citation'; url: string; title: string | null }
  /** 工具调用开始：上游要求调用名为 name 的工具 */
  | { kind: 'tool_call_begin'; callId: string; name: string }
  /** 工具调用参数增量（JSON 字符串片段） */
  | { kind: 'tool_call_args_delta'; callId: string; delta: string }
  /** 工具调用结束：参数已完整 */
  | { kind: 'tool_call_end'; callId: string }
  | { kind: 'completed'; stopReason: string | null }
  | { kind: 'upstream_error'; message: string; retryable: boolean }
  | { kind: 'raw'; message: RawMessage };

/** 声明给上游的工具（函数）。name + JSON Schema 参数。 */
export interface ToolDeclaration {
  name: string;
  description?: string | undefined;
  parameters?: Record<string, unknown> | undefined;
}

/** 回传给上游的工具执行结果，用于续推理。 */
export interface ToolResultInput {
  callId: string;
  output: string;
}

/**
 * 图片输入的建模字段（M6，`UPSTREAM_IMAGE_INPUT=true` 时生效）。
 *
 * ⚠️ 仍待校准：M0 真实探测证实了文本 invocation 的字段形态（见 `codecV1.ts`），
 * 但受限于测试账号的 Copilot 许可证状态（实测走到 `InternalError`/
 * `InvalidCopilotLicense`，未能拿到一次成功生成），没能进一步验证图片输入的
 * 真实字段名与位置。这里继续沿用「通过 `InvocationInput.passthrough` 透传」的
 * 既有约定（`model`/`reasoning`/`temperature` 等已经在走这条通道）——因为
 * `scheduler/dispatcher.ts` 已冻结、不接受新增顶层字段，复用 passthrough 是
 * 当前唯一能不改调度层就把新字段送到线协议层的办法。等拿到一个有效许可证的
 * 账号能跑通真实图片输入后，再决定是保留这个约定还是替换成上游实际要求的形态。
 */
export interface ImageInputDescriptor {
  /** 图片 URL，或按 file-id 解析出的 data URL */
  url: string;
  detail?: string | null;
}

export interface InvocationInput {
  invocationId: string;
  /** 用户本轮输入的纯文本（M3 只支持文本；图片/文件是 M6） */
  text: string;
  /** 上游会话标识；续接同一会话时带上 */
  conversationRef?: string | undefined;
  /**
   * 账号的对象 ID（`participant.id`）。M0 实测确认真实上游的每条 invocation
   * 都带这个字段（回显消息的 `from.id` 与之一致）；调用方（调度器）本来就持有
   * oid 用于构造连接 URL，这里顺路透传给编解码层，不需要新开一条获取渠道。
   */
  participantId?: string | undefined;
  /** 透传的 model / reasoning.effort 等，原样带给上游，不改写 */
  passthrough?: Record<string, unknown>;
  /** 本轮可用的工具声明（M5） */
  tools?: readonly ToolDeclaration[] | undefined;
  /** 工具执行结果回传（M5，续接时带上） */
  toolResults?: readonly ToolResultInput[] | undefined;
}

/** 协议编解码接口。按 protocolVersion 选具体实现，便于 M0 后替换。 */
export interface ProtocolCodec {
  readonly version: string;
  /** 握手帧（含结尾 RS） */
  encodeHandshake(): string;
  /** 判断一段文本是否为握手响应（服务端 ack 通常是空对象 `{}`） */
  isHandshakeAck(raw: string): boolean;
  /** 发起对话的 invocation 帧（含结尾 RS） */
  encodeInvocation(input: InvocationInput): string;
  /** 心跳帧（含结尾 RS） */
  encodePing(): string;
  /** 取消 invocation 帧（含结尾 RS） */
  encodeCancel(invocationId: string): string;
  /** 把一条原始消息映射为若干归一化事件 */
  mapMessageToEvents(message: RawMessage): UpstreamEvent[];
  /** 该消息是否代表本轮 completion（流结束） */
  isCompletion(message: RawMessage): boolean;
}

/**
 * 把粘包/半包的字节流按 RS 切成完整帧。
 * 返回完整帧数组与残留的未完成片段（下次拼接用）。
 */
export function splitFrames(buffer: string): { frames: string[]; rest: string } {
  const parts = buffer.split(RECORD_SEPARATOR);
  const rest = parts.pop() ?? '';
  const frames = parts.filter((frame) => frame.length > 0);
  return { frames, rest };
}

/** 解析单帧 JSON 为原始消息；非法 JSON 返回 null（由调用方决定如何处理）。 */
export function parseFrame(frame: string): RawMessage | null {
  try {
    const parsed: unknown = JSON.parse(frame);
    if (typeof parsed === 'object' && parsed !== null) {
      return parsed as RawMessage;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * 帧重组器：喂入任意分片的字符串，吐出完整消息。
 * WebSocket 的一帧不一定对应协议的一条消息，可能粘包或拆包。
 */
export class FrameReassembler {
  #buffer = '';

  push(chunk: string): RawMessage[] {
    this.#buffer += chunk;
    const { frames, rest } = splitFrames(this.#buffer);
    this.#buffer = rest;
    const messages: RawMessage[] = [];
    for (const frame of frames) {
      const message = parseFrame(frame);
      if (message !== null) messages.push(message);
    }
    return messages;
  }
}
