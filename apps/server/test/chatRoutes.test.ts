import { afterEach, describe, expect, it } from 'vitest';
import { createTestHarness, type TestHarness } from './helpers/testApp.js';
import { startMockSydneyServer, type MockSydneyServer } from './helpers/mockSydneyServer.js';

/**
 * `/v1/chat/completions` 全链路集成测试（对应实施计划 §M6）。
 * 断言的重点是「复用 Responses 内核，不建第二套推理逻辑」：全链路走同一个
 * 模拟 Sydney 上游、同一套账号调度与工具循环，这里只验证协议转换是否正确。
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
    tid: 't1',
    oid: 'o1',
    email: 'user@office.example.invalid',
    displayName: 'user',
    source: 'oauth',
    tokens: { accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 3600_000 },
  });
  const key = harness.context.apiKeys.create({ name: 'k' });
  return { h: harness, apiKey: key.key };
}

function auth(key: string): Record<string, string> {
  return { authorization: `Bearer ${key}` };
}

describe('POST /v1/chat/completions 非流式', () => {
  it('返回 chat.completion，choices[0].message 含拼好的文本', async () => {
    const { h, apiKey } = await setup(['你好', '，世界']);
    const res = await h.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: auth(apiKey),
      payload: {
        model: 'gpt-5-codex',
        messages: [
          { role: 'system', content: '你是助手' },
          { role: 'user', content: '在吗' },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      object: string;
      model: string;
      choices: { index: number; message: { role: string; content: string }; finish_reason: string }[];
    };
    expect(body.object).toBe('chat.completion');
    expect(body.model).toBe('gpt-5-codex');
    expect(body.choices[0]?.message.role).toBe('assistant');
    expect(body.choices[0]?.message.content).toBe('你好，世界');
    expect(body.choices[0]?.finish_reason).toBe('stop');

    // messages 正确映射进 input：system 与 user 都进了上游收到的文本
    expect(server?.invocationTexts[0]).toContain('你是助手');
    expect(server?.invocationTexts[0]).toContain('在吗');
  });

  it('工具调用往返：先产出 tool_calls，再用 tool 消息回传结果续接', async () => {
    server = await startMockSydneyServer({
      kind: 'tool-call',
      callId: 'call_1',
      name: 'shell',
      arguments: '{"cmd":"npm test"}',
    });
    harness = await createTestHarness({ UPSTREAM_WS_BASE: server.url });
    harness.context.accounts.upsert({
      tid: 't1', oid: 'o1', email: 'user@office.example.invalid', displayName: 'u', source: 'oauth',
      tokens: { accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 3600_000 },
    });
    const key = harness.context.apiKeys.create({ name: 'k' });

    const shellTool = {
      type: 'function',
      function: {
        name: 'shell',
        description: '执行 shell 命令',
        parameters: { type: 'object', properties: { cmd: { type: 'string' } }, required: ['cmd'] },
      },
    };

    const first = await harness.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: auth(key.key),
      payload: { model: 'm', messages: [{ role: 'user', content: '运行测试' }], tools: [shellTool] },
    });
    expect(first.statusCode).toBe(200);
    const firstBody = first.json() as {
      choices: { message: { tool_calls?: { id: string; function: { name: string } }[] }; finish_reason: string }[];
    };
    expect(firstBody.choices[0]?.finish_reason).toBe('tool_calls');
    const call = firstBody.choices[0]?.message.tool_calls?.[0];
    expect(call?.function.name).toBe('shell');
    expect(call?.id).toBe('call_1');

    // 换成普通回答行为，模拟工具在本机执行完、把结果回传续接
    server.setBehavior({ kind: 'normal', chunks: ['好的'] });
    const second = await harness.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: auth(key.key),
      payload: {
        model: 'm',
        messages: [
          { role: 'user', content: '运行测试' },
          {
            role: 'assistant',
            content: null,
            tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'shell', arguments: '{"cmd":"npm test"}' } }],
          },
          { role: 'tool', tool_call_id: 'call_1', content: 'Exit code: 0' },
        ],
        tools: [shellTool],
      },
    });
    expect(second.statusCode).toBe(200);
    // 上游第二次收到的文本里应包含完整重建的历史：用户提问、工具调用、工具结果
    expect(server.invocationTexts[1]).toContain('运行测试');
    expect(server.invocationTexts[1]).toContain('shell');
    expect(server.invocationTexts[1]).toContain('Exit code: 0');
  });

  it('temperature / max_tokens / tools 原样透传，不新造模型别名', async () => {
    const { h, apiKey } = await setup(['ok']);
    const res = await h.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: auth(apiKey),
      payload: {
        model: 'my-custom-model-id',
        messages: [{ role: 'user', content: 'hi' }],
        temperature: 0.3,
        max_tokens: 50,
      },
    });
    const body = res.json() as { model: string };
    expect(body.model).toBe('my-custom-model-id');
  });

  it('没有可用账号时返回统一错误体（503）', async () => {
    harness = await createTestHarness();
    const key = harness.context.apiKeys.create({ name: 'k' });
    const res = await harness.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: auth(key.key),
      payload: { model: 'm', messages: [{ role: 'user', content: 'hi' }] },
    });
    expect(res.statusCode).toBe(503);
    expect((res.json() as { error: { type: string } }).error.type).toBe('account_pool_exhausted');
  });
});

describe('POST /v1/chat/completions 流式', () => {
  it('逐块 chat.completion.chunk，末尾 [DONE]', async () => {
    const { h, apiKey } = await setup(['分片一', '分片二']);
    const res = await h.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: auth(apiKey),
      payload: { model: 'm', messages: [{ role: 'user', content: '你好' }], stream: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');

    const blocks = res.body.split('\n\n').filter((b) => b.trim() !== '');
    expect(blocks[blocks.length - 1]).toBe('data: [DONE]');

    const chunks = blocks
      .filter((b) => b !== 'data: [DONE]')
      .map((b) => JSON.parse(b.replace(/^data: /, '')) as Record<string, unknown>);

    expect(chunks.every((c) => c.object === 'chat.completion.chunk')).toBe(true);

    const firstChoice = chunks[0]?.choices as { delta: { role?: string } }[];
    expect(firstChoice[0]?.delta.role).toBe('assistant');

    const joinedText = chunks
      .map((c) => (c.choices as { delta: { content?: string } }[])[0]?.delta.content ?? '')
      .join('');
    expect(joinedText).toBe('分片一分片二');

    const lastChunk = chunks[chunks.length - 1];
    const lastChoice = (lastChunk?.choices as { finish_reason: string | null }[])[0];
    expect(lastChoice?.finish_reason).toBe('stop');
  });
});
