import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import Ajv2020Cjs from 'ajv/dist/2020.js';

// ajv 是 CJS 模块，NodeNext 下默认导入绑定的是命名空间，真正的类在 .default 上
const Ajv2020 = Ajv2020Cjs.default;
import { createTestHarness, type TestHarness } from './helpers/testApp.js';
import { startMockSydneyServer, type MockSydneyServer } from './helpers/mockSydneyServer.js';

/**
 * OpenAPI 契约测试（对应实施计划 §M4 DoD）。
 * 用 openapi/openapi.json 里的 schema 校验真实接口返回，保证实现不偏离契约。
 */

const openapiPath = fileURLToPath(new URL('../../../openapi/openapi.json', import.meta.url));
const openapi = JSON.parse(readFileSync(openapiPath, 'utf8')) as {
  components: { schemas: Record<string, object> };
};

const ajv = new Ajv2020({ strict: false, allErrors: true });
// 注册所有组件 schema，供 $ref 解析
for (const [name, schema] of Object.entries(openapi.components.schemas)) {
  ajv.addSchema(schema, `#/components/schemas/${name}`);
}

function validator(name: string) {
  const schema = openapi.components.schemas[name];
  if (schema === undefined) throw new Error(`schema 不存在：${name}`);
  return ajv.compile(schema);
}

let harness: TestHarness | undefined;
let server: MockSydneyServer | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
  await server?.close();
  server = undefined;
});

async function setup(): Promise<{ h: TestHarness; apiKey: string }> {
  server = await startMockSydneyServer({
    kind: 'normal',
    chunks: ['契约', '测试'],
    citations: [{ url: 'https://src.example', title: '来源' }],
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
  const key = harness.context.apiKeys.create({ name: 'k' });
  return { h: harness, apiKey: key.key };
}

function auth(key: string): Record<string, string> {
  return { authorization: `Bearer ${key}` };
}

describe('契约：/v1/models', () => {
  it('响应符合 ModelList schema', async () => {
    const { h, apiKey } = await setup();
    const res = await h.app.inject({ method: 'GET', url: '/v1/models', headers: auth(apiKey) });
    const validate = validator('ModelList');
    expect(validate(res.json())).toBe(true);
  });
});

describe('契约：POST /v1/responses 非流式', () => {
  it('响应符合 Response schema', async () => {
    const { h, apiKey } = await setup();
    const res = await h.app.inject({
      method: 'POST',
      url: '/v1/responses',
      headers: auth(apiKey),
      payload: { model: 'gpt-5-codex', input: 'q' },
    });
    const validate = validator('Response');
    const ok = validate(res.json());
    if (!ok) {
      throw new Error(`不符合契约: ${JSON.stringify(validate.errors)}`);
    }
    expect(ok).toBe(true);
  });
});

describe('契约：错误体', () => {
  it('503 符合 ErrorBody schema', async () => {
    server = await startMockSydneyServer({ kind: 'normal', chunks: ['x'] });
    harness = await createTestHarness({ UPSTREAM_WS_BASE: server.url });
    const key = harness.context.apiKeys.create({ name: 'k' });
    const res = await harness.app.inject({
      method: 'POST',
      url: '/v1/responses',
      headers: auth(key.key),
      payload: { model: 'm', input: 'q' },
    });
    expect(res.statusCode).toBe(503);
    const validate = validator('ErrorBody');
    expect(validate(res.json())).toBe(true);
  });

  it('422 符合 ErrorBody schema', async () => {
    const { h, apiKey } = await setup();
    const res = await h.app.inject({
      method: 'POST',
      url: '/v1/responses',
      headers: auth(apiKey),
      payload: { model: 'm', input: [{ role: 'user', content: [{ type: 'input_image' }] }] },
    });
    expect(res.statusCode).toBe(422);
    expect(validator('ErrorBody')(res.json())).toBe(true);
  });
});

describe('契约：SSE 完成事件里的 response 符合 schema', () => {
  it('response.completed.data.response 符合 Response schema', async () => {
    const { h, apiKey } = await setup();
    const res = await h.app.inject({
      method: 'POST',
      url: '/v1/responses',
      headers: auth(apiKey),
      payload: { model: 'gpt-5-codex', input: 'q', stream: true },
    });
    const completedBlock = res.body
      .split('\n\n')
      .find((block) => block.includes('event: response.completed'));
    expect(completedBlock).toBeDefined();
    const dataLine = completedBlock?.split('\n').find((l) => l.startsWith('data: '));
    const data = JSON.parse(dataLine!.slice('data: '.length)) as { response: unknown };
    const validate = validator('Response');
    const ok = validate(data.response);
    if (!ok) throw new Error(`不符合契约: ${JSON.stringify(validate.errors)}`);
    expect(ok).toBe(true);
  });
});
