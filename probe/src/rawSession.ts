import { WebSocket } from 'ws';
import {
  FrameReassembler,
  MESSAGE_TYPE,
  type ProtocolCodec,
  type RawMessage,
  type ToolDeclaration,
  type ToolResultInput,
  type UpstreamEvent,
} from '../../apps/server/dist/adapter/protocol.js';
import { classifyCloseCode, classifyHttpStatus, UpstreamError } from '../../apps/server/dist/adapter/errors.js';
import type { InvocationOutcome } from './types.js';

/**
 * 探针自己的「原始会话」引擎。
 *
 * 复用 `apps/server/src/adapter` 的协议常量、编解码器与错误分类
 * （`FrameReassembler` / `MESSAGE_TYPE` / codec / `classifyHttpStatus` /
 * `classifyCloseCode`），但**不**复用 `SydneyConnection`：那一层的职责是把
 * 上游帧归一化成 `UpstreamEvent` 供业务层使用，会丢弃原始帧结构；而 M0
 * 探针的核心任务恰恰是把原始帧结构采集下来去校准 `codecV1.ts`（见
 * `report.ts` 的「协议差异清单」)，所以这里需要一份既拿归一化事件、
 * 又拿原始帧的连接循环。除了帧结构采集，其余生命周期语义（握手、心跳、
 * 空闲超时、取消）都与 `SydneyConnection` 一致。
 */

export interface RawSessionOptions {
  url: string;
  codec: ProtocolCodec;
  invocationId: string;
  text: string;
  conversationRef?: string | undefined;
  passthrough?: Record<string, unknown> | undefined;
  tools?: readonly ToolDeclaration[] | undefined;
  toolResults?: readonly ToolResultInput[] | undefined;
  handshakeTimeoutMs: number;
  /** 握手必须带的 X-Scenario 头；不带一律 403 */
  scenario: string;
  idleTimeoutMs: number;
  /** 整个 invocation 的硬超时（含握手），超过则判定失败并关闭连接 */
  totalTimeoutMs: number;
  signal?: AbortSignal | undefined;
  /** 每收到一个归一化事件就同步回调一次，供「取消」类用例在首个分片后触发取消 */
  onEvent?: ((event: UpstreamEvent, raw: RawMessage) => void) | undefined;
  /**
   * 取消时是否先发送 `encodeCancel` 停止帧（默认 true，对应 §3.1 第 17 项「发送 stop 帧」）。
   * 传 false 表示直接断开连接、不发任何取消帧（对应第 29 项「客户端断开后上游是否可取消」，
   * 模拟客户端异常掉线而不是主动优雅取消）。
   */
  sendCancelOnAbort?: boolean | undefined;
  /** 测试注入用；默认使用 `ws` 库连真实/模拟上游 */
  wsFactory?: ((url: string) => WebSocket) | undefined;
}

function readStatusCode(res: unknown): number {
  if (typeof res === 'object' && res !== null) {
    const status = (res as { statusCode?: unknown }).statusCode;
    if (typeof status === 'number') return status;
  }
  return 0;
}

function readRetryAfterHeader(res: unknown): string | null {
  if (typeof res !== 'object' || res === null) return null;
  const headers = (res as { headers?: unknown }).headers;
  if (typeof headers !== 'object' || headers === null) return null;
  const value = (headers as Record<string, unknown>)['retry-after'];
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return null;
}

function bufferToString(data: unknown): string {
  if (Array.isArray(data)) return Buffer.concat(data as Buffer[]).toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  return String(data);
}

/** 跑一次 invocation，收集原始帧与归一化事件，返回聚合结果（不抛异常，异常都归到 errorCategory）。 */
export async function runRawSession(options: RawSessionOptions): Promise<InvocationOutcome> {
  const startedAt = Date.now();
  const events: UpstreamEvent[] = [];
  const rawMessages: RawMessage[] = [];
  let conversationRef: string | null = options.conversationRef ?? null;

  return new Promise<InvocationOutcome>((resolve) => {
    let settled = false;
    let handshakeAcked = false;
    const reassembler = new FrameReassembler();
    // X-Scenario 是上游放行的硬条件，缺了它无论凭据多正确都是 403
    const ws = (options.wsFactory ??
      ((url: string): WebSocket =>
        new WebSocket(url, { headers: { 'X-Scenario': options.scenario } })))(options.url);

    let totalTimer: NodeJS.Timeout | null = null;
    let idleTimer: NodeJS.Timeout | null = null;

    const finish = (
      result: Omit<InvocationOutcome, 'events' | 'rawMessages' | 'durationMs' | 'conversationRef' | 'retryAfterMs'> & {
        retryAfterMs?: number | null;
      },
    ): void => {
      if (settled) return;
      settled = true;
      if (totalTimer !== null) clearTimeout(totalTimer);
      if (idleTimer !== null) clearTimeout(idleTimer);
      try {
        ws.close();
      } catch {
        // 关闭异常忽略，反正马上会 terminate
      }
      try {
        ws.terminate();
      } catch {
        // ignore
      }
      resolve({
        ...result,
        retryAfterMs: result.retryAfterMs ?? null,
        events,
        rawMessages,
        durationMs: Date.now() - startedAt,
        conversationRef,
      });
    };

    const resetIdle = (): void => {
      if (idleTimer !== null) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        finish({
          closeCode: null,
          closeReason: null,
          errorCategory: 'retry_or_switch',
          errorMessage: '上游空闲超时，未在预期时间内收到帧',
        });
      }, options.idleTimeoutMs);
      idleTimer.unref?.();
    };

    totalTimer = setTimeout(() => {
      finish({
        closeCode: null,
        closeReason: null,
        errorCategory: 'timeout',
        errorMessage: `超过总超时 ${options.totalTimeoutMs}ms`,
      });
    }, options.totalTimeoutMs);
    totalTimer.unref?.();

    const onAbort = (): void => {
      const shouldSendCancel = options.sendCancelOnAbort ?? true;
      if (shouldSendCancel) {
        try {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(options.codec.encodeCancel(options.invocationId));
          }
        } catch {
          // 取消是尽力而为
        }
      }
      finish({
        closeCode: 1000,
        closeReason: shouldSendCancel ? 'client_cancelled' : 'client_disconnected',
        errorCategory: null,
        errorMessage: null,
      });
    };
    if (options.signal !== undefined) {
      if (options.signal.aborted) {
        // 已经取消：等 open 之后再处理，避免竞态
        ws.once('open', onAbort);
      } else {
        options.signal.addEventListener('abort', onAbort, { once: true });
      }
    }

    ws.on('unexpected-response', (_req: unknown, res: unknown) => {
      const upstreamError = classifyHttpStatus(readStatusCode(res), readRetryAfterHeader(res));
      finish({
        closeCode: null,
        closeReason: null,
        errorCategory: upstreamError.disposition,
        errorMessage: upstreamError.message,
        retryAfterMs: upstreamError.retryAfterMs,
      });
    });

    ws.on('open', () => {
      resetIdle();
      ws.send(options.codec.encodeHandshake());
    });

    ws.on('message', (data: unknown) => {
      resetIdle();
      const text = bufferToString(data);

      if (!handshakeAcked) {
        if (options.codec.isHandshakeAck(text)) {
          handshakeAcked = true;
          ws.send(
            options.codec.encodeInvocation({
              invocationId: options.invocationId,
              text: options.text,
              conversationRef: options.conversationRef,
              passthrough: options.passthrough,
              tools: options.tools,
              toolResults: options.toolResults,
            }),
          );
          return;
        }
        handshakeAcked = true;
        // 握手没有独立 ack，首帧当普通消息继续处理（不 return）
      }

      for (const message of reassembler.push(text)) {
        rawMessages.push(message);

        if (message.type === MESSAGE_TYPE.PING) {
          ws.send(options.codec.encodePing());
          continue;
        }

        const conv = extractConversationRef(message);
        if (conv !== null) conversationRef = conv;

        for (const event of options.codec.mapMessageToEvents(message)) {
          events.push(event);
          options.onEvent?.(event, message);
        }

        if (options.codec.isCompletion(message)) {
          finish({ closeCode: 1000, closeReason: null, errorCategory: null, errorMessage: null });
          return;
        }
      }
    });

    ws.on('close', (code: number, reasonBuf: Buffer) => {
      const reason = reasonBuf.toString('utf8');
      const classified = classifyCloseCode(code, reason);
      finish({
        closeCode: code,
        closeReason: reason === '' ? null : reason,
        errorCategory: classified === null ? null : classified.disposition,
        errorMessage: classified === null ? null : classified.message,
      });
    });

    ws.on('error', (error: Error) => {
      const upstreamError =
        error instanceof UpstreamError
          ? error
          : new UpstreamError(`上游连接错误：${error.message}`, 'retry_or_switch', { cause: error });
      finish({
        closeCode: null,
        closeReason: null,
        errorCategory: upstreamError.disposition,
        errorMessage: upstreamError.message,
      });
    });
  });
}

/**
 * 从原始消息里试探性地找出会话/对话标识。
 *
 * 真实字段名待 M0 校准，这里按常见命名启发式尝试几种候选键，
 * 找到第一个非空字符串就采用——找不到就是 `unknown`，如实反映在报告里。
 */
function extractConversationRef(message: RawMessage): string | null {
  const args = Array.isArray(message.arguments) ? message.arguments : [];
  const candidateKeys = ['conversationId', 'conversationRef', 'chatId', 'sessionId'];
  for (const arg of args) {
    if (typeof arg !== 'object' || arg === null) continue;
    const record = arg as Record<string, unknown>;
    for (const key of candidateKeys) {
      const value = record[key];
      if (typeof value === 'string' && value !== '') return value;
    }
  }
  for (const key of candidateKeys) {
    const value = (message as Record<string, unknown>)[key];
    if (typeof value === 'string' && value !== '') return value;
  }
  return null;
}
