import { afterEach, describe, expect, it } from 'vitest';
import { startMockSydneyServer, type MockSydneyServer } from '../../apps/server/test/helpers/mockSydneyServer.js';
import { runSingleToolTrial } from '../src/toolCall.js';
import { TOOL_GET_TIME, TOOL_PROMPT_SINGLE } from '../src/testInputs.js';
import { makeFakeContext } from './helpers/fakeContext.js';

let server: MockSydneyServer | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

describe('runSingleToolTrial', () => {
  it('一次就拿到合法参数：无需修复即通过', async () => {
    server = await startMockSydneyServer({
      kind: 'tool-call',
      callId: 'call_1',
      name: 'probe_get_time',
      arguments: '{"timezone":"Asia/Shanghai"}',
    });
    const ctx = makeFakeContext(server.url);
    const { stats, lastDetection } = await runSingleToolTrial(ctx, TOOL_PROMPT_SINGLE, [TOOL_GET_TIME]);

    expect(stats.trials).toBe(1);
    expect(stats.nativeHits).toBe(1);
    expect(stats.firstPassSchemaOk).toBe(1);
    expect(stats.passWithinTwoRepairs).toBe(1);
    expect(stats.undeclaredToolCalls).toBe(0);
    expect(lastDetection.name).toBe('probe_get_time');
  });

  it('首次参数不合法，修复一次后通过', async () => {
    server = await startMockSydneyServer({
      kind: 'tool-call-repair',
      callId: 'call_1',
      name: 'probe_get_time',
      badArgs: '{}',
      goodArgs: '{"timezone":"Asia/Shanghai"}',
    });
    const ctx = makeFakeContext(server.url);
    const { stats } = await runSingleToolTrial(ctx, TOOL_PROMPT_SINGLE, [TOOL_GET_TIME]);

    expect(stats.firstPassSchemaOk).toBe(0);
    expect(stats.passWithinTwoRepairs).toBe(1);
  });

  it('调用了未声明的工具：记为 undeclared，且不误判为通过', async () => {
    server = await startMockSydneyServer({
      kind: 'tool-call',
      callId: 'call_1',
      name: 'some_other_tool',
      arguments: '{}',
    });
    const ctx = makeFakeContext(server.url);
    const { stats } = await runSingleToolTrial(ctx, TOOL_PROMPT_SINGLE, [TOOL_GET_TIME]);

    expect(stats.undeclaredToolCalls).toBeGreaterThan(0);
  });

  it('并行工具调用：一轮里出现两个 tool_call_begin', async () => {
    server = await startMockSydneyServer({
      kind: 'tool-calls',
      calls: [
        { callId: 'call_1', name: 'probe_get_time', arguments: '{"timezone":"Asia/Shanghai"}' },
        { callId: 'call_2', name: 'probe_echo', arguments: '{"message":"ping"}' },
      ],
    });
    const ctx = makeFakeContext(server.url);
    const { lastDetection } = await runSingleToolTrial(ctx, TOOL_PROMPT_SINGLE, [TOOL_GET_TIME]);
    expect(lastDetection.nativeCallCount).toBe(2);
  });

  it('普通文本回复（无工具调用）：channel 为 none，不计入命中', async () => {
    server = await startMockSydneyServer({ kind: 'normal', chunks: ['这是一个不涉及工具的普通回复。'] });
    const ctx = makeFakeContext(server.url);
    const { stats, lastDetection } = await runSingleToolTrial(ctx, TOOL_PROMPT_SINGLE, [TOOL_GET_TIME]);
    expect(lastDetection.channel).toBe('none');
    expect(stats.noCallHits).toBe(1);
  });
});
