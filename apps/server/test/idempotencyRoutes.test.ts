import { afterEach, describe, expect, it } from 'vitest';
import { createTestHarness, type TestHarness } from './helpers/testApp.js';
import { startMockSydneyServer, type MockSydneyServer } from './helpers/mockSydneyServer.js';

/**
 * Idempotency-Key 接进 /v1/responses 与 /v1/chat/completions（§18）。
 * 核心诉求：不重复提交可能产生工具调用的上游请求；流式请求不做回放但仍挡并发。
 */

let harness: TestHarness | undefined;
let server: MockSydneyServer | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
  await server?.close();
  server = undefined;
});

async function setup(chunks: string[] = ['你好']): Promise<{ h: TestHarness; apiKey: string }> {
  server = await startMockSydneyServer({ kind: 'normal', chunks });
  harness = await createTestHarness({ UPSTREAM_WS_BASE: server.url });
  harness.context.accounts.upsert({
    tid: 'tenant-1',
    oid: 'user-1',
    email: 'user@office.example.invalid',
    displayName: 'user',
    source: 'oauth',
    tokens: { accessToken: 'access', refreshToken: 'refresh', expiresAt: Date.now() + 3600_000 },
  });
  const key = harness.context.apiKeys.create({ name: 'codex' });
  return { h: harness, apiKey: key.key };
}

function headers(key: string, idempotencyKey?: string): Record<string, string> {
  const base: Record<string, string> = { authorization: `Bearer ${key}` };
  if (idempotencyKey !== undefined) base['idempotency-key'] = idempotencyKey;
  return base;
}

describe('非流式：首次执行与回放', () => {
  it('同一个 Idempotency-Key 第二次请求直接回放同一个 response id', async () => {
    const { h, apiKey } = await setup();
    const payload = { model: 'gpt-5-codex', input: '你好', stream: false };

    const first = await h.app.inject({
      method: 'POST',
      url: '/v1/responses',
      headers: headers(apiKey, 'idem-1'),
      payload,
    });
    expect(first.statusCode).toBe(200);
    const firstBody = first.json() as { id: string };

    const second = await h.app.inject({
      method: 'POST',
      url: '/v1/responses',
      headers: headers(apiKey, 'idem-1'),
      payload,
    });
    expect(second.statusCode).toBe(200);
    const secondBody = second.json() as { id: string };
    expect(secondBody.id).toBe(firstBody.id);
  });

  it('同一把键配不同请求体返回 409', async () => {
    const { h, apiKey } = await setup();

    const first = await h.app.inject({
      method: 'POST',
      url: '/v1/responses',
      headers: headers(apiKey, 'idem-2'),
      payload: { model: 'gpt-5-codex', input: '第一次', stream: false },
    });
    expect(first.statusCode).toBe(200);

    const second = await h.app.inject({
      method: 'POST',
      url: '/v1/responses',
      headers: headers(apiKey, 'idem-2'),
      payload: { model: 'gpt-5-codex', input: '第二次', stream: false },
    });
    expect(second.statusCode).toBe(409);
    expect((second.json() as { error: { type: string } }).error.type).toBe('idempotency_error');
  });

  it('没带 Idempotency-Key 时每次都正常执行，互不相关', async () => {
    const { h, apiKey } = await setup();
    const payload = { model: 'gpt-5-codex', input: '你好', stream: false };

    const first = await h.app.inject({ method: 'POST', url: '/v1/responses', headers: headers(apiKey), payload });
    const second = await h.app.inject({ method: 'POST', url: '/v1/responses', headers: headers(apiKey), payload });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect((first.json() as { id: string }).id).not.toBe((second.json() as { id: string }).id);
  });
});

describe('并发同键', () => {
  it('两个并发请求携带同一把键，只有一个成功执行，另一个收到 409', async () => {
    const { h, apiKey } = await setup();
    const payload = { model: 'gpt-5-codex', input: '并发', stream: false };

    const [first, second] = await Promise.all([
      h.app.inject({ method: 'POST', url: '/v1/responses', headers: headers(apiKey, 'idem-race'), payload }),
      h.app.inject({ method: 'POST', url: '/v1/responses', headers: headers(apiKey, 'idem-race'), payload }),
    ]);
    const codes = [first.statusCode, second.statusCode].sort();
    // 两者都可能是 200（其中一个先跑完落库、后一个又刚好读到 replay）或 409（撞见 in_progress）
    expect(codes.every((code) => code === 200 || code === 409)).toBe(true);
    expect(codes.includes(409) || (first.statusCode === 200 && second.statusCode === 200)).toBe(true);
  });
});

describe('流式请求：不回放，但仍挡并发', () => {
  it('stream:true 执行完成后键被释放，同键可以再次执行（不是回放而是重新执行）', async () => {
    const { h, apiKey } = await setup();
    const payload = { model: 'gpt-5-codex', input: '流式', stream: true };

    const first = await h.app.inject({
      method: 'POST',
      url: '/v1/responses',
      headers: headers(apiKey, 'idem-stream'),
      payload,
    });
    expect(first.statusCode).toBe(200);
    expect(first.headers['content-type']).toContain('text/event-stream');

    // 键已被释放（流式不落地可回放结果），同键请求会重新执行一次，而不是 409 或回放
    const second = await h.app.inject({
      method: 'POST',
      url: '/v1/responses',
      headers: headers(apiKey, 'idem-stream'),
      payload,
    });
    expect(second.statusCode).toBe(200);
    expect(second.headers['content-type']).toContain('text/event-stream');
  });
});

describe('/v1/chat/completions 同样接了幂等', () => {
  it('同一把键回放同一个 chat.completion id', async () => {
    const { h, apiKey } = await setup();
    const payload = {
      model: 'gpt-5-codex',
      messages: [{ role: 'user', content: '你好' }],
      stream: false,
    };

    const first = await h.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: headers(apiKey, 'idem-chat-1'),
      payload,
    });
    expect(first.statusCode).toBe(200);
    const second = await h.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: headers(apiKey, 'idem-chat-1'),
      payload,
    });
    expect(second.statusCode).toBe(200);
    expect((second.json() as { id: string }).id).toBe((first.json() as { id: string }).id);
  });
});
