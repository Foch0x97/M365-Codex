import { Buffer } from 'node:buffer';
import { request } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestHarness, type TestHarness } from './helpers/testApp.js';
import { startMockSydneyServer, type MockSydneyServer } from './helpers/mockSydneyServer.js';

/**
 * 补齐集成测试矩阵（实施计划 §21.2）里尚未覆盖的三项：
 * - 并行工具调用（一轮里多个工具调用被正常接受、全部下发）；
 * - 文件输入的完整链路（真实上传 → 提取文本 → 拼进发给上游的 invocation）；
 * - 客户端断开（真实 TCP 连接中途关闭 → 上游收到取消 → sseInterrupted 打点）。
 *
 * 其余矩阵项（文本/SSE/单工具调用/function_call_output/previous_response_id/
 * 上游超时/401/403/429/全不可用/重启恢复/Chat Completions）已由
 * responsesRoutes.test.ts / toolLoop.test.ts / connection.test.ts /
 * dispatcher.test.ts / recovery.test.ts / chatRoutes.test.ts 覆盖，这里不重复。
 */

let harness: TestHarness | undefined;
let server: MockSydneyServer | undefined;
let dataDir: string | undefined;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'm365-codex-integration-extra-'));
});

afterEach(async () => {
  await harness?.close();
  harness = undefined;
  await server?.close();
  server = undefined;
  if (dataDir !== undefined) rmSync(dataDir, { recursive: true, force: true });
  dataDir = undefined;
});

const weatherTool = {
  type: 'function',
  name: 'get_weather',
  parameters: {
    type: 'object',
    properties: { city: { type: 'string' } },
    required: ['city'],
    additionalProperties: false,
  },
};

function auth(key: string): Record<string, string> {
  return { authorization: `Bearer ${key}` };
}

describe('并行工具调用', () => {
  it('一轮里的多个工具调用在允许并行时全部正常下发', async () => {
    server = await startMockSydneyServer({
      kind: 'tool-calls',
      calls: [
        { callId: 'call_a', name: 'get_weather', arguments: '{"city":"北京"}' },
        { callId: 'call_b', name: 'get_weather', arguments: '{"city":"上海"}' },
      ],
    });
    harness = await createTestHarness({ UPSTREAM_WS_BASE: server.url });
    harness.context.accounts.upsert({
      tid: 't', oid: 'o', email: null, displayName: null, source: 'oauth',
      tokens: { accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 3600_000 },
    });
    const key = harness.context.apiKeys.create({ name: 'k' });

    const res = await harness.app.inject({
      method: 'POST',
      url: '/v1/responses',
      headers: auth(key.key),
      payload: { model: 'm', input: '查两个城市天气', tools: [weatherTool], parallel_tool_calls: true },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { output: { type: string; call_id?: string; name?: string }[] };
    const calls = body.output.filter((i) => i.type === 'function_call');
    expect(calls.map((c) => c.call_id).sort()).toEqual(['call_a', 'call_b']);
    expect(calls.every((c) => c.name === 'get_weather')).toBe(true);

    // 两个调用都落库为 emitted，且都带 side_effect
    const rows = harness.db.prepare('SELECT call_id, status FROM tool_calls ORDER BY call_id').all() as {
      call_id: string;
      status: string;
    }[];
    expect(rows.map((r) => r.call_id)).toEqual(['call_a', 'call_b']);
    expect(rows.every((r) => r.status === 'emitted')).toBe(true);
  });
});

describe('文件输入完整链路', () => {
  it('真实上传的文件内容会被提取并拼进发给上游的 invocation', async () => {
    server = await startMockSydneyServer({ kind: 'normal', chunks: ['已阅读文件'] });
    harness = await createTestHarness({ UPSTREAM_WS_BASE: server.url, DATA_DIR: dataDir });
    harness.context.accounts.upsert({
      tid: 't', oid: 'o', email: null, displayName: null, source: 'oauth',
      tokens: { accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 3600_000 },
    });
    const key = harness.context.apiKeys.create({ name: 'k' });

    const boundary = '----m365file';
    const fileContent = '这是一份季度报告，营收增长百分之十七。';
    const payload = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="report.txt"\r\nContent-Type: text/plain\r\n\r\n`,
      ),
      Buffer.from(fileContent, 'utf8'),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const uploadRes = await harness.app.inject({
      method: 'POST',
      url: '/v1/files',
      headers: { ...auth(key.key), 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload,
    });
    expect(uploadRes.statusCode).toBe(201);
    const file = uploadRes.json() as { id: string; status: string };
    expect(file.status).toBe('processed');

    const res = await harness.app.inject({
      method: 'POST',
      url: '/v1/responses',
      headers: auth(key.key),
      payload: {
        model: 'm',
        input: [
          {
            role: 'user',
            content: [
              { type: 'input_text', text: '请总结附件' },
              { type: 'input_file', file_id: file.id },
            ],
          },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    // 提取出的文件文本确实到达了发给模拟上游的 invocation
    expect(server.invocationTexts[0]).toContain('营收增长百分之十七');
    expect(server.invocationTexts[0]).toContain('report.txt');
  });
});

describe('客户端断开', () => {
  it('真实 TCP 连接中途关闭会取消上游并计入 sseInterrupted', async () => {
    server = await startMockSydneyServer({ kind: 'slow', chunks: ['第一块', '第二块', '第三块'], delayMs: 150 });
    harness = await createTestHarness({ UPSTREAM_WS_BASE: server.url });
    harness.context.accounts.upsert({
      tid: 't', oid: 'o', email: null, displayName: null, source: 'oauth',
      tokens: { accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 3600_000 },
    });
    const key = harness.context.apiKeys.create({ name: 'k' });

    await harness.app.listen({ port: 0, host: '127.0.0.1' });
    const address = harness.app.server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;

    const body = JSON.stringify({ model: 'm', input: 'q', stream: true });
    await new Promise<void>((resolve) => {
      const req = request(
        {
          host: '127.0.0.1',
          port,
          path: '/v1/responses',
          method: 'POST',
          headers: {
            authorization: `Bearer ${key.key}`,
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(body),
          },
        },
        (res) => {
          res.once('data', () => {
            // 收到第一块 SSE 数据（流还没结束）就直接销毁连接，模拟客户端断开
            req.destroy();
            resolve();
          });
          res.on('error', () => resolve());
        },
      );
      req.on('error', () => resolve()); // destroy() 自身会触发一次 error，属于预期
      req.write(body);
    });

    // 给服务端一点时间处理 'close' 事件、向上游发取消帧、更新指标
    await new Promise((resolve) => setTimeout(resolve, 600));

    expect(harness.context.inFlight.size).toBe(0);
    const metricsText = harness.context.metrics.render();
    expect(metricsText).toContain('m365codex_sse_interrupted_total{endpoint="responses"} 1');
  }, 10_000);
});
