import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { WebSocketServer, type WebSocket } from 'ws';
import { MESSAGE_TYPE, RECORD_SEPARATOR } from '../../src/adapter/protocol.js';

/**
 * 模拟 Sydney / BizChat WebSocket 上游（对应实施计划 §8 的「模拟 Sydney WS 上游」）。
 *
 * 说话方式与真实上游一致：SignalR JSON 帧 + 0x1e 分隔、握手 ack、流式回若干帧、
 * completion 收尾。可通过 behavior 注入各种异常，用于测试连接层与调度器的处置。
 *
 * 绝不涉及真实网络或真实凭据。
 */

export type MockBehavior =
  | { kind: 'normal'; chunks: string[]; citations?: { url: string; title: string }[] }
  /** WS 升级阶段直接返回指定 HTTP 状态（401/403/429…） */
  | { kind: 'http-status'; status: number; retryAfter?: string }
  /** 握手后异常关闭 */
  | { kind: 'abnormal-close'; code: number; reason?: string }
  /** 在流中回一个可重试的 Throttled 错误 */
  | { kind: 'throttle' }
  /** 握手后什么都不发，触发空闲超时 */
  | { kind: 'idle' }
  /** completion 里带错误 */
  | { kind: 'completion-error'; message: string };

export interface MockSydneyServer {
  url: string;
  /** 收到的 access_token 查询参数（脱敏测试用） */
  lastAccessToken: string | null;
  /** 收到的 invocation 文本，按到达顺序 */
  invocationTexts: string[];
  /** 建立过的连接数 */
  connectionCount: number;
  /** 收到的 ping 数 */
  pingCount: number;
  setBehavior: (behavior: MockBehavior) => void;
  close: () => Promise<void>;
}

function frame(payload: unknown): string {
  return JSON.stringify(payload) + RECORD_SEPARATOR;
}

export async function startMockSydneyServer(initial: MockBehavior): Promise<MockSydneyServer> {
  let behavior = initial;
  const state = {
    lastAccessToken: null as string | null,
    invocationTexts: [] as string[],
    connectionCount: 0,
    pingCount: 0,
  };

  const httpServer: Server = createServer((_req, res) => {
    res.writeHead(426);
    res.end('Upgrade Required');
  });

  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    state.lastAccessToken = url.searchParams.get('access_token');

    // http-status 行为：在升级阶段拒绝并返回指定状态码
    if (behavior.kind === 'http-status') {
      const extra = behavior.retryAfter !== undefined ? `Retry-After: ${behavior.retryAfter}\r\n` : '';
      socket.write(
        `HTTP/1.1 ${behavior.status} Rejected\r\nConnection: close\r\n${extra}Content-Length: 0\r\n\r\n`,
      );
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });

  wss.on('connection', (ws: WebSocket) => {
    state.connectionCount += 1;
    let handshakeDone = false;

    ws.on('message', (data: Buffer) => {
      const raw = data.toString('utf8');
      for (const part of raw.split(RECORD_SEPARATOR).filter((frag) => frag.length > 0)) {
        let msg: { type?: number; target?: string; invocationId?: string; arguments?: unknown[] };
        try {
          msg = JSON.parse(part);
        } catch {
          continue;
        }

        // 握手帧：{"protocol":"json","version":1}
        if (!handshakeDone && 'protocol' in msg) {
          handshakeDone = true;
          ws.send(frame({})); // ack
          return;
        }

        if (msg.type === MESSAGE_TYPE.PING) {
          state.pingCount += 1;
          continue;
        }

        if (msg.type === MESSAGE_TYPE.STREAM_INVOCATION || msg.type === MESSAGE_TYPE.INVOCATION) {
          const arg = (msg.arguments?.[0] ?? {}) as { messages?: { text?: string; author?: string }[] };
          const userMsg = arg.messages?.find((m) => m.author === 'user');
          state.invocationTexts.push(userMsg?.text ?? '');
          void runBehavior(ws, msg.invocationId ?? 'inv');
        }
      }
    });
  });

  async function runBehavior(ws: WebSocket, invocationId: string): Promise<void> {
    switch (behavior.kind) {
      case 'normal': {
        for (const chunk of behavior.chunks) {
          const message: Record<string, unknown> = {
            author: 'bot',
            text: chunk,
            messageType: 'Chat',
          };
          if (behavior.citations !== undefined) {
            message.sourceAttributions = behavior.citations.map((c) => ({
              seeMoreUrl: c.url,
              providerDisplayName: c.title,
            }));
          }
          ws.send(
            frame({ type: MESSAGE_TYPE.STREAM_ITEM, invocationId, arguments: [{ messages: [message] }] }),
          );
        }
        ws.send(frame({ type: MESSAGE_TYPE.COMPLETION, invocationId }));
        break;
      }
      case 'throttle': {
        ws.send(
          frame({
            type: MESSAGE_TYPE.STREAM_ITEM,
            invocationId,
            arguments: [{ result: { value: 'Throttled', message: '触发限流' } }],
          }),
        );
        ws.send(frame({ type: MESSAGE_TYPE.COMPLETION, invocationId }));
        break;
      }
      case 'completion-error': {
        ws.send(frame({ type: MESSAGE_TYPE.COMPLETION, invocationId, error: behavior.message }));
        break;
      }
      case 'abnormal-close': {
        ws.close(behavior.code, behavior.reason ?? '');
        break;
      }
      case 'idle': {
        // 故意什么都不发
        break;
      }
      default:
        break;
    }
  }

  httpServer.listen(0, '127.0.0.1');
  await once(httpServer, 'listening');
  const address = httpServer.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;

  return {
    url: `ws://127.0.0.1:${port}`,
    get lastAccessToken() {
      return state.lastAccessToken;
    },
    get invocationTexts() {
      return state.invocationTexts;
    },
    get connectionCount() {
      return state.connectionCount;
    },
    get pingCount() {
      return state.pingCount;
    },
    setBehavior(next: MockBehavior) {
      behavior = next;
    },
    close: async () => {
      wss.close();
      httpServer.close();
      await once(httpServer, 'close').catch(() => undefined);
    },
  };
}
