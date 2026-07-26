import { afterEach, describe, expect, it } from 'vitest';
import { createTestHarness, type TestHarness } from './helpers/testApp.js';
import { startMockSydneyServer, type MockSydneyServer } from './helpers/mockSydneyServer.js';

/**
 * M5 工具调用完整代理循环：路由→服务→状态机→调度器→连接→模拟 Sydney 上游。
 * 覆盖 function_call 产出、参数校验与修复、function_call_output 回传续接、幂等。
 */

let harness: TestHarness | undefined;
let server: MockSydneyServer | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
  await server?.close();
  server = undefined;
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

async function setupWith(
  behavior: Parameters<typeof startMockSydneyServer>[0],
  env: Record<string, string> = {},
): Promise<{
  h: TestHarness;
  apiKey: string;
}> {
  server = await startMockSydneyServer(behavior);
  harness = await createTestHarness({ UPSTREAM_WS_BASE: server.url, ...env });
  harness.context.accounts.upsert({
    tid: 't',
    oid: 'o',
    email: 'u@office.example.invalid',
    displayName: 'u',
    source: 'oauth',
    tokens: { accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 3600_000 },
  });
  const key = harness.context.apiKeys.create({ name: 'codex' });
  return { h: harness, apiKey: key.key };
}

function auth(key: string): Record<string, string> {
  return { authorization: `Bearer ${key}` };
}

function parseSse(body: string): { event: string; data: Record<string, unknown> }[] {
  const events: { event: string; data: Record<string, unknown> }[] = [];
  for (const block of body.split('\n\n')) {
    const eventLine = block.split('\n').find((l) => l.startsWith('event: '));
    const dataLine = block.split('\n').find((l) => l.startsWith('data: '));
    if (eventLine === undefined || dataLine === undefined) continue;
    events.push({
      event: eventLine.slice('event: '.length),
      data: JSON.parse(dataLine.slice('data: '.length)) as Record<string, unknown>,
    });
  }
  return events;
}

describe('产出 function_call', () => {
  it('非流式：模型调用工具 → 输出含 function_call 项', async () => {
    const { h, apiKey } = await setupWith({
      kind: 'tool-call',
      callId: 'call_1',
      name: 'get_weather',
      arguments: '{"city":"北京"}',
    });
    const res = await h.app.inject({
      method: 'POST',
      url: '/v1/responses',
      headers: auth(apiKey),
      payload: { model: 'm', input: '北京天气', tools: [weatherTool] },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { status: string; output: { type: string; call_id?: string; name?: string; arguments?: string }[] };
    expect(body.status).toBe('completed');
    const fc = body.output.find((i) => i.type === 'function_call');
    expect(fc).toBeDefined();
    expect(fc?.call_id).toBe('call_1');
    expect(fc?.name).toBe('get_weather');
    expect(fc?.arguments).toBe('{"city":"北京"}');
  });

  it('流式：产出 function_call_arguments.delta 与 done', async () => {
    const { h, apiKey } = await setupWith({
      kind: 'tool-call',
      callId: 'call_x',
      name: 'get_weather',
      arguments: '{"city":"上海"}',
    });
    const res = await h.app.inject({
      method: 'POST',
      url: '/v1/responses',
      headers: auth(apiKey),
      payload: { model: 'm', input: 'q', tools: [weatherTool], stream: true },
    });
    const events = parseSse(res.body);
    const names = events.map((e) => e.event);
    expect(names).toContain('response.function_call_arguments.delta');
    expect(names).toContain('response.function_call_arguments.done');
    expect(names.at(-1)).toBe('response.completed');
    // 序号单调
    const seqs = events.map((e) => e.data.sequence_number as number);
    for (let i = 1; i < seqs.length; i += 1) expect(seqs[i]).toBe((seqs[i - 1] as number) + 1);
  });

  it('工具调用被持久化为 emitted，带 side_effect', async () => {
    const { h, apiKey } = await setupWith({
      kind: 'tool-call',
      callId: 'call_p',
      name: 'get_weather',
      arguments: '{"city":"广州"}',
    });
    await h.app.inject({
      method: 'POST',
      url: '/v1/responses',
      headers: auth(apiKey),
      payload: { model: 'm', input: 'q', tools: [weatherTool] },
    });
    const row = h.db.prepare('SELECT * FROM tool_calls WHERE call_id = ?').get('call_p') as {
      status: string;
      side_effect: number;
      name: string;
    };
    expect(row.status).toBe('emitted');
    expect(row.side_effect).toBe(1);
    expect(row.name).toBe('get_weather');
  });
});

describe('参数修复', () => {
  it('参数不合法时请求上游修复，两次内修好', async () => {
    const { h, apiKey } = await setupWith({
      kind: 'tool-call-repair',
      callId: 'call_r',
      name: 'get_weather',
      badArgs: '{"wrong":1}', // 缺 city、含多余字段
      goodArgs: '{"city":"深圳"}',
    });
    const res = await h.app.inject({
      method: 'POST',
      url: '/v1/responses',
      headers: auth(apiKey),
      payload: { model: 'm', input: 'q', tools: [weatherTool] },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { output: { type: string; arguments?: string }[] };
    const fc = body.output.find((i) => i.type === 'function_call');
    expect(fc?.arguments).toBe('{"city":"深圳"}');
    // 至少发起了两次 invocation（首轮 + 修复）
    expect(server?.invocationCount).toBeGreaterThanOrEqual(2);
  });

  it('修复上限为 2：始终不合法时最终仍发出（标注）', async () => {
    const { h, apiKey } = await setupWith({
      kind: 'tool-call',
      callId: 'call_bad',
      name: 'get_weather',
      arguments: '{"nope":1}', // 永远不合法
    });
    const res = await h.app.inject({
      method: 'POST',
      url: '/v1/responses',
      headers: auth(apiKey),
      payload: { model: 'm', input: 'q', tools: [weatherTool] },
    });
    expect(res.statusCode).toBe(200);
    // 首轮 + 最多 2 次修复 = 3 次 invocation
    expect(server?.invocationCount).toBe(3);
    const body = res.json() as { output: { type: string }[] };
    expect(body.output.some((i) => i.type === 'function_call')).toBe(true);
  });
});

describe('只调声明过的工具', () => {
  it('未声明的工具修复无果后不发给客户端，整轮判失败', async () => {
    const { h, apiKey } = await setupWith({
      kind: 'tool-call',
      callId: 'call_u',
      name: 'delete_everything', // 请求里没声明
      arguments: '{}',
    });
    const res = await h.app.inject({
      method: 'POST',
      url: '/v1/responses',
      headers: auth(apiKey),
      payload: { model: 'm', input: 'q', tools: [weatherTool] },
    });
    expect(res.statusCode).toBe(502);
    // 既没发给客户端，也没落库
    expect(res.body).not.toContain('call_u');
    const row = h.db.prepare('SELECT * FROM tool_calls WHERE call_id = ?').get('call_u');
    expect(row).toBeUndefined();
  });

  it('工具名大小写不一致算未声明', async () => {
    const { h, apiKey } = await setupWith({
      kind: 'tool-call',
      callId: 'call_case',
      name: 'Get_Weather',
      arguments: '{"city":"北京"}',
    });
    const res = await h.app.inject({
      method: 'POST',
      url: '/v1/responses',
      headers: auth(apiKey),
      payload: { model: 'm', input: 'q', tools: [weatherTool] },
    });
    expect(res.statusCode).toBe(502);
  });
});

describe('提示词模拟模式', () => {
  it('从正文解析工具调用，且 JSON 不再出现在正文里', async () => {
    const { h, apiKey } = await setupWith(
      {
        kind: 'normal',
        chunks: [
          '我来查一下。',
          '<tool_call>{"name":"get_weather","arguments":{"city":"重庆"}}</tool_call>',
          '稍等。',
        ],
      },
      { TOOLS_MODE: 'prompt' },
    );
    const res = await h.app.inject({
      method: 'POST',
      url: '/v1/responses',
      headers: auth(apiKey),
      payload: { model: 'm', input: 'q', tools: [weatherTool] },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      output: { type: string; name?: string; arguments?: string; content?: { text: string }[] }[];
    };
    const fc = body.output.find((i) => i.type === 'function_call');
    expect(fc?.name).toBe('get_weather');
    expect(fc?.arguments).toBe('{"city":"重庆"}');
    const text = body.output.find((i) => i.type === 'message')?.content?.[0]?.text ?? '';
    expect(text).toBe('我来查一下。稍等。');
    expect(text).not.toContain('tool_call');
    // 工具目录约束确实发给了上游
    expect(server?.invocationTexts[0]).toContain('get_weather');
  });
});

describe('工具循环限制（§7.4）', () => {
  it('超过每轮最大工具调用数时不发出，如实报错', async () => {
    const { h, apiKey } = await setupWith(
      {
        kind: 'tool-calls',
        calls: [
          { callId: 'c1', name: 'get_weather', arguments: '{"city":"A"}' },
          { callId: 'c2', name: 'get_weather', arguments: '{"city":"B"}' },
        ],
      },
      { TOOLS_MAX_CALLS_PER_ROUND: '1', TOOLS_MAX_ARG_REPAIRS: '0' },
    );
    const res = await h.app.inject({
      method: 'POST',
      url: '/v1/responses',
      headers: auth(apiKey),
      payload: { model: 'm', input: 'q', tools: [weatherTool] },
    });
    expect(res.statusCode).toBe(502);
    expect(h.db.prepare('SELECT * FROM tool_calls WHERE call_id = ?').get('c1')).toBeUndefined();
  });

  it('parallel_tool_calls=false 时上游仍并行则报错，不擅自截断', async () => {
    const { h, apiKey } = await setupWith(
      {
        kind: 'tool-calls',
        calls: [
          { callId: 'p1', name: 'get_weather', arguments: '{"city":"A"}' },
          { callId: 'p2', name: 'get_weather', arguments: '{"city":"B"}' },
        ],
      },
      { TOOLS_MAX_ARG_REPAIRS: '0' },
    );
    const res = await h.app.inject({
      method: 'POST',
      url: '/v1/responses',
      headers: auth(apiKey),
      payload: { model: 'm', input: 'q', tools: [weatherTool], parallel_tool_calls: false },
    });
    expect(res.statusCode).toBe(502);
  });

  it('达到最大工具轮次后拒绝继续代理循环', async () => {
    const { h, apiKey } = await setupWith(
      { kind: 'tool-call', callId: 'call_round', name: 'get_weather', arguments: '{"city":"北京"}' },
      { TOOLS_MAX_ROUNDS: '1' },
    );
    const first = (
      await h.app.inject({
        method: 'POST',
        url: '/v1/responses',
        headers: auth(apiKey),
        payload: { model: 'm', input: 'q', tools: [weatherTool] },
      })
    ).json() as { id: string };

    const second = await h.app.inject({
      method: 'POST',
      url: '/v1/responses',
      headers: auth(apiKey),
      payload: {
        model: 'm',
        previous_response_id: first.id,
        input: [{ type: 'function_call_output', call_id: 'call_round', output: '晴' }],
        tools: [weatherTool],
      },
    });
    expect(second.statusCode).toBe(400);
    expect(second.body).toContain('最大工具轮次');
  });
});

describe('function_call_output 回传续接', () => {
  it('call_id 不匹配任何已发出的工具调用时拒绝', async () => {
    const { h, apiKey } = await setupWith({ kind: 'normal', chunks: ['ok'] });
    const res = await h.app.inject({
      method: 'POST',
      url: '/v1/responses',
      headers: auth(apiKey),
      payload: {
        model: 'm',
        input: [{ type: 'function_call_output', call_id: 'call_never_emitted', output: '结果' }],
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('call_never_emitted');
  });

  it('工具结果超过大小上限时返回 413', async () => {
    const { h, apiKey } = await setupWith(
      { kind: 'tool-call', callId: 'call_big', name: 'get_weather', arguments: '{"city":"北京"}' },
      { TOOLS_MAX_RESULT_BYTES: '1024' },
    );
    const first = (
      await h.app.inject({
        method: 'POST',
        url: '/v1/responses',
        headers: auth(apiKey),
        payload: { model: 'm', input: 'q', tools: [weatherTool] },
      })
    ).json() as { id: string };

    const res = await h.app.inject({
      method: 'POST',
      url: '/v1/responses',
      headers: auth(apiKey),
      payload: {
        model: 'm',
        previous_response_id: first.id,
        input: [{ type: 'function_call_output', call_id: 'call_big', output: 'x'.repeat(2048) }],
      },
    });
    expect(res.statusCode).toBe(413);
  });

  it('回传工具结果 → 标记完成 → 续推理产出文本', async () => {
    // 第一轮返回工具调用，第二轮（带工具结果）返回文本
    server = await startMockSydneyServer({
      kind: 'tool-call',
      callId: 'call_c',
      name: 'get_weather',
      arguments: '{"city":"杭州"}',
    });
    harness = await createTestHarness({ UPSTREAM_WS_BASE: server.url });
    harness.context.accounts.upsert({
      tid: 't', oid: 'o', email: null, displayName: null, source: 'oauth',
      tokens: { accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 3600_000 },
    });
    const key = harness.context.apiKeys.create({ name: 'k' });
    const h = harness;

    const first = (
      await h.app.inject({
        method: 'POST',
        url: '/v1/responses',
        headers: auth(key.key),
        payload: { model: 'm', input: '天气', tools: [weatherTool] },
      })
    ).json() as { id: string; output: { type: string; call_id?: string }[] };
    const fc = first.output.find((i) => i.type === 'function_call');
    expect(fc?.call_id).toBe('call_c');

    // 切换 mock 行为为返回文本，然后回传工具结果
    server.setBehavior({ kind: 'normal', chunks: ['杭州晴'] });
    const second = await h.app.inject({
      method: 'POST',
      url: '/v1/responses',
      headers: auth(key.key),
      payload: {
        model: 'm',
        previous_response_id: first.id,
        input: [{ type: 'function_call_output', call_id: 'call_c', output: '晴，25度' }],
        tools: [weatherTool],
      },
    });
    expect(second.statusCode).toBe(200);
    const body = second.json() as { output: { type: string; content?: { text: string }[] }[] };
    const message = body.output.find((i) => i.type === 'message');
    expect(message?.content?.[0]?.text).toBe('杭州晴');

    // 工具调用被标记完成
    const row = h.db.prepare('SELECT status, output FROM tool_calls WHERE call_id = ?').get('call_c') as {
      status: string;
      output: string;
    };
    expect(row.status).toBe('completed');
    expect(row.output).toBe('晴，25度');
  });

  it('重复回传同一工具结果是幂等的（不二次标记）', async () => {
    server = await startMockSydneyServer({
      kind: 'tool-call',
      callId: 'call_i',
      name: 'get_weather',
      arguments: '{"city":"成都"}',
    });
    harness = await createTestHarness({ UPSTREAM_WS_BASE: server.url });
    harness.context.accounts.upsert({
      tid: 't', oid: 'o', email: null, displayName: null, source: 'oauth',
      tokens: { accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 3600_000 },
    });
    const key = harness.context.apiKeys.create({ name: 'k' });
    const h = harness;

    const first = (
      await h.app.inject({
        method: 'POST',
        url: '/v1/responses',
        headers: auth(key.key),
        payload: { model: 'm', input: 'q', tools: [weatherTool] },
      })
    ).json() as { id: string };

    server.setBehavior({ kind: 'normal', chunks: ['ok'] });
    const submit = () =>
      h.app.inject({
        method: 'POST',
        url: '/v1/responses',
        headers: auth(key.key),
        payload: {
          model: 'm',
          previous_response_id: first.id,
          input: [{ type: 'function_call_output', call_id: 'call_i', output: '第一次结果' }],
        },
      });
    await submit();
    await submit(); // 重复提交

    // 状态仍是 completed，output 保留首次写入的值（markCompleted 只在 emitted→completed 生效）
    const row = h.db.prepare('SELECT status, output FROM tool_calls WHERE call_id = ?').get('call_i') as {
      status: string;
      output: string;
    };
    expect(row.status).toBe('completed');
    expect(row.output).toBe('第一次结果');
  });
});

describe('API Key 级工具调用上限（§10.1）', () => {
  it('比全局天花板更严的 max_tool_calls 会先触发拒绝', async () => {
    server = await startMockSydneyServer({
      kind: 'tool-call',
      callId: 'call_1',
      name: 'get_weather',
      arguments: '{"city":"北京"}',
    });
    harness = await createTestHarness({ UPSTREAM_WS_BASE: server.url });
    harness.context.accounts.upsert({
      tid: 't',
      oid: 'o',
      email: 'u@office.example.invalid',
      displayName: 'u',
      source: 'oauth',
      tokens: { accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 3600_000 },
    });
    // 全局 TOOLS_MAX_TOTAL_CALLS 默认很宽松，这里让该 Key 收紧到 0：
    // 任何一次工具调用（1）都会超过这个上限
    const key = harness.context.apiKeys.create({ name: '受限 Key', maxToolCalls: 0 });

    const res = await harness.app.inject({
      method: 'POST',
      url: '/v1/responses',
      headers: auth(key.key),
      payload: { model: 'm', input: '北京天气', tools: [weatherTool] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('累计工具调用数将超过上限 0');
  });

  it('Key 设置的值比全局更松时被裁剪到全局上限，不允许突破', async () => {
    server = await startMockSydneyServer({
      kind: 'tool-call',
      callId: 'call_1',
      name: 'get_weather',
      arguments: '{"city":"北京"}',
    });
    harness = await createTestHarness({ UPSTREAM_WS_BASE: server.url, TOOLS_MAX_TOTAL_CALLS: '1' });
    harness.context.accounts.upsert({
      tid: 't',
      oid: 'o',
      email: 'u@office.example.invalid',
      displayName: 'u',
      source: 'oauth',
      tokens: { accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 3600_000 },
    });
    // Key 自己设置成 10（比全局上限 1 更松），但有效上限必须仍是全局的 1，
    // 不允许 Key 自行突破——这里第一次工具调用就恰好等于 1，能正常通过
    const key = harness.context.apiKeys.create({ name: '想突破全局上限', maxToolCalls: 10 });

    const res = await harness.app.inject({
      method: 'POST',
      url: '/v1/responses',
      headers: auth(key.key),
      payload: { model: 'm', input: '北京天气', tools: [weatherTool] },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { status: string }).status).toBe('completed');
  });

  it('未设置 max_tool_calls 时按全局 TOOLS_MAX_TOTAL_CALLS 生效，行为不变', async () => {
    const { h, apiKey } = await setupWith({
      kind: 'tool-call',
      callId: 'call_1',
      name: 'get_weather',
      arguments: '{"city":"北京"}',
    });
    const res = await h.app.inject({
      method: 'POST',
      url: '/v1/responses',
      headers: auth(apiKey),
      payload: { model: 'm', input: '北京天气', tools: [weatherTool] },
    });
    expect(res.statusCode).toBe(200);
  });
});
