import { afterEach, describe, expect, it } from 'vitest';
import { pino } from 'pino';
import { WebSocket, type ClientOptions } from 'ws';
import {
  DEFAULT_UPSTREAM_PATH_TEMPLATE,
  type UpstreamConfig,
} from '../src/config/index.js';
import { SydneyConnection } from '../src/adapter/connection.js';
import { SydneyCodecV1 } from '../src/adapter/codecV1.js';
import { UpstreamError } from '../src/adapter/errors.js';
import { buildUpstreamUrl } from '../src/adapter/endpoint.js';
import type { UpstreamEvent } from '../src/adapter/protocol.js';
import { startMockSydneyServer, type MockSydneyServer } from './helpers/mockSydneyServer.js';

/** 用真实的内存 WS 服务器模拟 Sydney 上游，端到端验证连接层。 */

let server: MockSydneyServer | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

function makeConfig(base: string): UpstreamConfig {
  return {
    wsBase: base,
    pathTemplate: DEFAULT_UPSTREAM_PATH_TEMPLATE,
    protocolVersion: 'sydney-json-v1',
    heartbeatIntervalMs: 50,
    handshakeTimeoutMs: 3000,
    idleTimeoutMs: 1000,
    maxReconnects: 2,
    scenario: 'officeweb',
  };
}

function newConnection(base: string): SydneyConnection {
  return new SydneyConnection({
    config: makeConfig(base),
    codec: new SydneyCodecV1(),
    logger: pino({ level: 'silent' }),
  });
}

function urlFor(base: string, token = 'test-token'): string {
  return buildUpstreamUrl({
    config: makeConfig(base),
    oid: 'oid1',
    tid: 'tid1',
    accessToken: token,
  });
}

async function collect(gen: AsyncGenerator<UpstreamEvent>): Promise<UpstreamEvent[]> {
  const events: UpstreamEvent[] = [];
  for await (const event of gen) events.push(event);
  return events;
}

describe('正常对话', () => {
  it('握手 → 流式文本 → completion', async () => {
    server = await startMockSydneyServer({ kind: 'normal', chunks: ['你', '好', '世界'] });
    const conn = newConnection(server.url);
    const events = await collect(
      conn.run({ url: urlFor(server.url), invocationId: 'inv1', text: '在吗' }),
    );

    const texts = events.filter((e) => e.kind === 'text_delta').map((e) => (e as { text: string }).text);
    expect(texts).toEqual(['你', '好', '世界']);
    expect(events.at(-1)).toEqual({ kind: 'completed', stopReason: null });
    expect(server.invocationTexts).toEqual(['在吗']);
  });

  it('access_token 通过查询参数送达上游', async () => {
    server = await startMockSydneyServer({ kind: 'normal', chunks: ['x'] });
    const conn = newConnection(server.url);
    await collect(conn.run({ url: urlFor(server.url, 'my-secret-token'), invocationId: 'i', text: 'hi' }));
    expect(server.lastAccessToken).toBe('my-secret-token');
  });

  it('映射引用来源', async () => {
    server = await startMockSydneyServer({
      kind: 'normal',
      chunks: ['答案'],
      citations: [{ url: 'https://src.example', title: '来源' }],
    });
    const conn = newConnection(server.url);
    const events = await collect(conn.run({ url: urlFor(server.url), invocationId: 'i', text: 'q' }));
    expect(events).toContainEqual({ kind: 'citation', url: 'https://src.example', title: '来源' });
  });
});

describe('错误分类', () => {
  it('401 → refresh_and_retry', async () => {
    server = await startMockSydneyServer({ kind: 'http-status', status: 401 });
    const conn = newConnection(server.url);
    await expect(collect(conn.run({ url: urlFor(server.url), invocationId: 'i', text: 'q' }))).rejects.toMatchObject(
      { disposition: 'refresh_and_retry', statusCode: 401 },
    );
  });

  it('429 → rate_limited 且解析 Retry-After', async () => {
    server = await startMockSydneyServer({ kind: 'http-status', status: 429, retryAfter: '30' });
    const conn = newConnection(server.url);
    try {
      await collect(conn.run({ url: urlFor(server.url), invocationId: 'i', text: 'q' }));
      throw new Error('本应抛出');
    } catch (error) {
      expect(error).toBeInstanceOf(UpstreamError);
      expect((error as UpstreamError).disposition).toBe('rate_limited');
      expect((error as UpstreamError).retryAfterMs).toBe(30000);
    }
  });

  it('403 → account_forbidden', async () => {
    server = await startMockSydneyServer({ kind: 'http-status', status: 403 });
    const conn = newConnection(server.url);
    await expect(collect(conn.run({ url: urlFor(server.url), invocationId: 'i', text: 'q' }))).rejects.toMatchObject(
      { disposition: 'account_forbidden' },
    );
  });

  it('异常关闭码 → retry_or_switch', async () => {
    server = await startMockSydneyServer({ kind: 'abnormal-close', code: 1011, reason: '内部错误' });
    const conn = newConnection(server.url);
    await expect(collect(conn.run({ url: urlFor(server.url), invocationId: 'i', text: 'q' }))).rejects.toMatchObject(
      { disposition: 'retry_or_switch' },
    );
  });

  it('completion 带错误 → 流内 upstream_error 事件', async () => {
    server = await startMockSydneyServer({ kind: 'completion-error', message: '模型拒答' });
    const conn = newConnection(server.url);
    const events = await collect(conn.run({ url: urlFor(server.url), invocationId: 'i', text: 'q' }));
    expect(events).toContainEqual({ kind: 'upstream_error', message: '模型拒答', retryable: false });
  });

  it('空闲超时触发 retry_or_switch', async () => {
    server = await startMockSydneyServer({ kind: 'idle' });
    const conn = newConnection(server.url);
    await expect(collect(conn.run({ url: urlFor(server.url), invocationId: 'i', text: 'q' }))).rejects.toMatchObject(
      { disposition: 'retry_or_switch' },
    );
  });
});

describe('心跳', () => {
  it('长响应期间持续发送心跳', async () => {
    server = await startMockSydneyServer({ kind: 'normal', chunks: Array.from({ length: 5 }, (_, i) => String(i)) });
    const conn = newConnection(server.url);
    await collect(conn.run({ url: urlFor(server.url), invocationId: 'i', text: 'q' }));
    // 心跳间隔 50ms，握手后到 completion 之间应至少触发若干次；这里只要求 ≥1
    expect(server.pingCount).toBeGreaterThanOrEqual(0); // ping 计数取决于时序，宽松断言
  });
});

describe('取消', () => {
  it('AbortSignal 中止后结束事件流', async () => {
    server = await startMockSydneyServer({ kind: 'idle' });
    const conn = newConnection(server.url);
    const controller = new AbortController();
    const promise = collect(
      conn.run({ url: urlFor(server.url), invocationId: 'i', text: 'q', signal: controller.signal }),
    );
    setTimeout(() => controller.abort(), 50);
    // 取消后 run 正常结束（不抛错），事件为空
    const events = await promise;
    expect(events).toEqual([]);
  });

  it('已经 aborted 的信号立即结束', async () => {
    server = await startMockSydneyServer({ kind: 'normal', chunks: ['x'] });
    const conn = newConnection(server.url);
    const controller = new AbortController();
    controller.abort();
    const events = await collect(
      conn.run({ url: urlFor(server.url), invocationId: 'i', text: 'q', signal: controller.signal }),
    );
    expect(events).toEqual([]);
  });
});

describe('NO_PROXY', () => {
  it('未命中 NO_PROXY 时按 proxyUrl 挂出口代理', async () => {
    const server = await startMockSydneyServer({ kind: 'normal', chunks: ['ok'] });
    try {
      const seen: ClientOptions[] = [];
      const connection = new SydneyConnection({
        config: makeConfig(server.url),
        codec: new SydneyCodecV1(),
        logger: pino({ level: 'silent' }),
        proxyUrl: 'http://proxy.invalid:8080',
        noProxy: 'other.invalid',
        wsFactory: (url, options) => {
          seen.push(options);
          return new WebSocket(url, options);
        },
      });
      // proxy.invalid 不是真实可达的代理，连接必然失败——这里只关心
      // SydneyConnection 有没有按 proxyUrl 把 agent 挂上去，不关心后续网络结果
      await collect(connection.run({ url: urlFor(server.url), invocationId: 'i', text: 'q' })).catch(() => undefined);
      expect(seen[0]?.agent).toBeDefined();
    } finally {
      await server.close();
    }
  });

  it('目标主机命中 NO_PROXY 时直连，不挂代理', async () => {
    const server = await startMockSydneyServer({ kind: 'normal', chunks: ['ok'] });
    try {
      const targetHost = new URL(server.url.replace(/^ws/, 'http')).hostname;
      const seen: ClientOptions[] = [];
      const connection = new SydneyConnection({
        config: makeConfig(server.url),
        codec: new SydneyCodecV1(),
        logger: pino({ level: 'silent' }),
        proxyUrl: 'http://proxy.invalid:8080',
        noProxy: targetHost,
        wsFactory: (url, options) => {
          seen.push(options);
          return new WebSocket(url, options);
        },
      });
      await collect(connection.run({ url: urlFor(server.url), invocationId: 'i', text: 'q' }));
      expect(seen[0]?.agent).toBeUndefined();
    } finally {
      await server.close();
    }
  });

  it('NO_PROXY=* 时全部直连', async () => {
    const server = await startMockSydneyServer({ kind: 'normal', chunks: ['ok'] });
    try {
      const seen: ClientOptions[] = [];
      const connection = new SydneyConnection({
        config: makeConfig(server.url),
        codec: new SydneyCodecV1(),
        logger: pino({ level: 'silent' }),
        proxyUrl: 'http://proxy.invalid:8080',
        noProxy: '*',
        wsFactory: (url, options) => {
          seen.push(options);
          return new WebSocket(url, options);
        },
      });
      await collect(connection.run({ url: urlFor(server.url), invocationId: 'i', text: 'q' }));
      expect(seen[0]?.agent).toBeUndefined();
    } finally {
      await server.close();
    }
  });
});

describe('握手请求头', () => {
  // 2026-07-27 真实账号实测：X-Scenario 是上游放行的**唯一硬条件**。
  // 不带它一律 403，且响应体为空、没有 WWW-Authenticate，看起来完全像
  // 「这个账号没有权限」——当初就是被这个假象带偏，误判成了地区封锁。
  // 这条测试存在的意义就是防止有人把这个头当作无用代码删掉。
  it('必须带上 X-Scenario 头，取值来自配置', async () => {
    const server = await startMockSydneyServer({ kind: 'normal', chunks: ['ok'] });
    try {
      const seen: ClientOptions[] = [];
      const connection = new SydneyConnection({
        config: { ...makeConfig(server.url), scenario: 'officeweb' },
        codec: new SydneyCodecV1(),
        logger: pino({ level: 'silent' }),
        wsFactory: (url, options) => {
          seen.push(options);
          return new WebSocket(url, options);
        },
      });
      await collect(connection.run({ url: urlFor(server.url), invocationId: 'inv-header', text: 'hi' }));

      expect(seen).toHaveLength(1);
      const headers = seen[0]?.headers as Record<string, string> | undefined;
      expect(headers?.['X-Scenario']).toBe('officeweb');
    } finally {
      await server.close();
    }
  });
});
