import { HttpsProxyAgent } from 'https-proxy-agent';
import type { Logger } from 'pino';
import { WebSocket, type ClientOptions } from 'ws';
import type { UpstreamConfig } from '../config/index.js';
import { AsyncQueue } from './asyncQueue.js';
import { redactWsUrl } from './endpoint.js';
import { classifyCloseCode, classifyHttpStatus, UpstreamError } from './errors.js';
import {
  FrameReassembler,
  MESSAGE_TYPE,
  type ProtocolCodec,
  type ToolDeclaration,
  type ToolResultInput,
  type UpstreamEvent,
} from './protocol.js';

/**
 * 单次上游对话连接。
 *
 * 一个 SydneyConnection 实例 = 一次 WebSocket 连接上的一次 invocation。
 * 负责：握手、心跳、空闲超时、帧重组、把原始消息映射为归一化事件、取消。
 *
 * 断线重连与切账号不在这里——它们意味着「用本地已累积的上下文重建对话」，
 * 由调度器编排（见 scheduler）。本层只忠实反映一次连接的生命周期，
 * 出错时抛出**已分类**的 UpstreamError。
 */

export interface ConnectionDeps {
  config: UpstreamConfig;
  codec: ProtocolCodec;
  logger: Logger;
  /** 出口代理 URL（HTTPS_PROXY / HTTP_PROXY），用于把上游流量绑定到指定出口 */
  proxyUrl?: string | null;
  /** 注入 WebSocket 实现，测试用；默认使用 ws 库 */
  wsFactory?: (url: string, options: ClientOptions) => WebSocket;
}

export interface RunInput {
  url: string;
  invocationId: string;
  text: string;
  conversationRef?: string | undefined;
  passthrough?: Record<string, unknown> | undefined;
  tools?: readonly ToolDeclaration[] | undefined;
  toolResults?: readonly ToolResultInput[] | undefined;
  /** 外部取消信号：中止后连接会向上游发取消帧并关闭 */
  signal?: AbortSignal | undefined;
}

export class SydneyConnection {
  readonly #deps: ConnectionDeps;
  #ws: WebSocket | null = null;
  #heartbeat: NodeJS.Timeout | null = null;
  #idleTimer: NodeJS.Timeout | null = null;
  #closed = false;

  constructor(deps: ConnectionDeps) {
    this.#deps = deps;
  }

  /**
   * 连接并跑完一次 invocation，按到达顺序 yield 归一化事件。
   * 正常结束于 completion；异常抛 UpstreamError。
   */
  async *run(input: RunInput): AsyncGenerator<UpstreamEvent> {
    const { config, codec, logger } = this.#deps;
    const queue = new AsyncQueue<UpstreamEvent>();
    const reassembler = new FrameReassembler();
    let handshakeAcked = false;

    // X-Scenario 是上游放行的硬条件：不带它一律 403（空响应体、无 WWW-Authenticate，
    // 看起来完全像「这个账号没权限」，实测排查时极具误导性）。取值必须精确匹配。
    const options: ClientOptions = {
      handshakeTimeout: config.handshakeTimeoutMs,
      headers: { 'X-Scenario': config.scenario },
    };
    if (this.#deps.proxyUrl != null && this.#deps.proxyUrl !== '') {
      options.agent = new HttpsProxyAgent(this.#deps.proxyUrl);
    }

    const ws = (this.#deps.wsFactory ?? defaultWsFactory)(input.url, options);
    this.#ws = ws;

    const resetIdle = (): void => {
      if (this.#idleTimer !== null) clearTimeout(this.#idleTimer);
      this.#idleTimer = setTimeout(() => {
        queue.fail(
          new UpstreamError('上游空闲超时，未在预期时间内收到帧', 'retry_or_switch', { statusCode: null }),
        );
        this.#teardown(1000);
      }, config.idleTimeoutMs);
      this.#idleTimer.unref?.();
    };

    // WS 握手阶段的 HTTP 错误（401/403/429）在这里才能拿到状态码
    ws.on('unexpected-response', (_req, res) => {
      queue.fail(classifyHttpStatus(readStatusCode(res), readRetryAfterHeader(res)));
      this.#teardown();
    });

    ws.on('open', () => {
      logger.debug({ url: redactWsUrl(input.url) }, '上游 WebSocket 已连接，发送握手');
      ws.send(codec.encodeHandshake());
      resetIdle();
    });

    ws.on('message', (data: Buffer | ArrayBuffer | Buffer[]) => {
      resetIdle();
      const text = bufferToString(data);
      // 握手 ack 之前，第一段文本用于确认握手成功并触发 invocation
      if (!handshakeAcked) {
        if (codec.isHandshakeAck(text)) {
          handshakeAcked = true;
          this.#startHeartbeat(ws, codec, config.heartbeatIntervalMs);
          ws.send(
            codec.encodeInvocation({
              invocationId: input.invocationId,
              text: input.text,
              conversationRef: input.conversationRef,
              passthrough: input.passthrough,
              tools: input.tools,
              toolResults: input.toolResults,
            }),
          );
          return;
        }
        // 首帧不是 ack：可能握手就把内容一起回来了，继续按普通消息处理
        handshakeAcked = true;
        this.#startHeartbeat(ws, codec, config.heartbeatIntervalMs);
      }

      for (const message of reassembler.push(text)) {
        if (message.type === MESSAGE_TYPE.PING) {
          // 回应心跳
          ws.send(codec.encodePing());
          continue;
        }
        for (const event of codec.mapMessageToEvents(message)) {
          queue.push(event);
        }
        if (codec.isCompletion(message)) {
          queue.end();
          this.#teardown(1000);
          return;
        }
      }
    });

    ws.on('close', (code: number, reasonBuf: Buffer) => {
      const reason = reasonBuf.toString('utf8');
      const classified = classifyCloseCode(code, reason);
      if (classified === null) {
        queue.end();
      } else {
        queue.fail(classified);
      }
      this.#teardown();
    });

    ws.on('error', (error: Error) => {
      // 'error' 常伴随 'close'/'unexpected-response'；若队列已结束则忽略
      queue.fail(
        new UpstreamError(`上游连接错误：${error.message}`, 'retry_or_switch', {
          statusCode: null,
          cause: error,
        }),
      );
      this.#teardown();
    });

    const onAbort = (): void => {
      logger.debug('收到取消信号，向上游发送取消帧');
      try {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(codec.encodeCancel(input.invocationId));
        }
      } catch {
        // 取消是尽力而为，发送失败也要继续关闭
      }
      queue.end();
      this.#teardown(1000);
    };
    if (input.signal !== undefined) {
      if (input.signal.aborted) {
        onAbort();
      } else {
        input.signal.addEventListener('abort', onAbort, { once: true });
      }
    }

    try {
      yield* queue;
    } finally {
      input.signal?.removeEventListener('abort', onAbort);
      this.#teardown();
    }
  }

  #startHeartbeat(ws: WebSocket, codec: ProtocolCodec, intervalMs: number): void {
    if (this.#heartbeat !== null) return;
    this.#heartbeat = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(codec.encodePing());
        } catch {
          // 发送失败会由 error/close 事件接管
        }
      }
    }, intervalMs);
    this.#heartbeat.unref?.();
  }

  #teardown(closeCode?: number): void {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#heartbeat !== null) {
      clearInterval(this.#heartbeat);
      this.#heartbeat = null;
    }
    if (this.#idleTimer !== null) {
      clearTimeout(this.#idleTimer);
      this.#idleTimer = null;
    }
    if (this.#ws !== null) {
      try {
        if (closeCode !== undefined) this.#ws.close(closeCode);
        else this.#ws.terminate();
      } catch {
        // 关闭异常忽略
      }
      this.#ws = null;
    }
  }
}

function defaultWsFactory(url: string, options: ClientOptions): WebSocket {
  return new WebSocket(url, options);
}

function bufferToString(data: Buffer | ArrayBuffer | Buffer[]): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  return data.toString('utf8');
}

/**
 * 从 ws 的 'unexpected-response' 回调里安全取出状态码与 Retry-After。
 * ws 对该回调参数的类型标注在不同版本间会退化成 any，这里按 unknown 处理，
 * 不让 any 泄漏进业务逻辑。
 */
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
