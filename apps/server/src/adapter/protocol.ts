/**
 * Sydney / BizChat 线协议编解码（版本隔离层）。
 *
 * 上游用的是 SignalR 风格的 JSON 协议：每条消息是一段 JSON，以记录分隔符
 * `0x1e`（RS）结尾。握手后客户端发起一次 invocation，服务端流式回若干帧，
 * 最后给出 completion。
 *
 * ⚠️ 重要：帧分隔（0x1e）是 SignalR 既定规范，稳定可依赖；但**消息内部的字段
 * 语义**（哪个字段装增量文本、引用、思考摘要）依赖 M0 探针对真实上游的实测。
 * 因此本模块把「解析出的原始消息 → 归一化事件」这一步单独抽成
 * `mapMessageToEvents`，作为 M0 之后替换的接缝。整个 codec 通过
 * `ProtocolCodec` 接口暴露，可按 `protocolVersion` 切换不同实现。
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
  | { kind: 'completed'; stopReason: string | null }
  | { kind: 'upstream_error'; message: string; retryable: boolean }
  | { kind: 'raw'; message: RawMessage };

export interface InvocationInput {
  invocationId: string;
  /** 用户本轮输入的纯文本（M3 只支持文本；图片/文件是 M6） */
  text: string;
  /** 上游会话标识；续接同一会话时带上 */
  conversationRef?: string | undefined;
  /** 透传的 model / reasoning.effort 等，原样带给上游，不改写 */
  passthrough?: Record<string, unknown>;
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
