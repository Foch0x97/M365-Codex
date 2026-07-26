import { setTimeout as delay } from 'node:timers/promises';
import { pino } from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import { SHUTDOWN_ABORT_REASON, InFlightRegistry } from '../src/responses/inFlight.js';
import { gracefulShutdown } from '../src/server.js';
import { createTestHarness, type TestHarness } from './helpers/testApp.js';
import { startMockSydneyServer, type MockSydneyServer } from './helpers/mockSydneyServer.js';

/**
 * 优雅关闭（§19）：关闭时要主动中止在途请求的上游连接，并把仍处于
 * in_progress 的 Response 落库为 incomplete——处置与 `recovery.ts` 的重启
 * 恢复一致，不写两套语义；绝不自动重放任何有副作用的操作。
 */

let harness: TestHarness | undefined;
let server: MockSydneyServer | undefined;

afterEach(async () => {
  await harness?.close().catch(() => undefined);
  harness = undefined;
  await server?.close();
  server = undefined;
});

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('等待条件超时');
    await delay(5);
  }
}

describe('InFlightRegistry.cancelAll', () => {
  it('中止全部登记中的 AbortController，标记 reason 为关闭专用哨兵值，并清空登记表', () => {
    const registry = new InFlightRegistry();
    const c1 = new AbortController();
    const c2 = new AbortController();
    registry.register('resp_a', c1);
    registry.register('resp_b', c2);

    const ids = registry.cancelAll();

    expect(ids.sort()).toEqual(['resp_a', 'resp_b']);
    expect(c1.signal.aborted).toBe(true);
    expect(c1.signal.reason).toBe(SHUTDOWN_ABORT_REASON);
    expect(c2.signal.aborted).toBe(true);
    expect(c2.signal.reason).toBe(SHUTDOWN_ABORT_REASON);
    expect(registry.size).toBe(0);
  });

  it('没有在途请求时是安全的空操作', () => {
    const registry = new InFlightRegistry();
    expect(registry.cancelAll()).toEqual([]);
  });
});

describe('gracefulShutdown', () => {
  it('中止在途请求的上游连接，把仍处于 in_progress 的记录落库为 incomplete', async () => {
    server = await startMockSydneyServer({ kind: 'idle' });
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

    // 捕获稍后仍要用到的引用：gracefulShutdown 会把 db 关掉，但这次测试
    // 想在关闭流程跑完之后再检查数据库状态，所以给它一个「不真正关闭」的
    // 代理——真正的 db.close() 放到本测试末尾自己调用
    const { app, db, context } = harness;
    const dbNoClose = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === 'close') return () => undefined;
        return Reflect.get(target, prop, receiver);
      },
    });

    const pending = app.inject({
      method: 'POST',
      url: '/v1/responses',
      headers: { authorization: `Bearer ${key.key}` },
      payload: { model: 'gpt-5-codex', input: '在吗' },
    });

    // 上游是 'idle'（握手后什么都不发），请求会一直卡在 in_progress，
    // 直到被登记进 inFlight——这里等它真正进入这个状态再触发关闭
    await waitFor(() => context.inFlight.size > 0);
    expect(context.inFlight.size).toBe(1);

    const logger = pino({ level: 'silent' });
    await gracefulShutdown({ context, app, db: dbNoClose, logger }, 'SIGTERM');
    harness = undefined; // app 已经被 gracefulShutdown 关闭，afterEach 不用再关一次

    expect(context.inFlight.size).toBe(0);

    // 挂起的请求应当随着 abort 收尾（不抛也不永久挂起）
    await pending.catch(() => undefined);

    const rows = db.prepare('SELECT id, status, body FROM responses').all() as {
      id: string;
      status: string;
      body: string | null;
    }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('incomplete');
    const body = JSON.parse(rows[0]?.body ?? '{}') as { incomplete_details: { reason: string } | null };
    expect(body.incomplete_details).toEqual({ reason: 'server_shutting_down' });

    db.close();
  });

  it('没有在途请求时也能正常走完关闭流程', async () => {
    harness = await createTestHarness();
    const { app, db, context } = harness;
    const logger = pino({ level: 'silent' });

    await gracefulShutdown({ context, app, db, logger }, 'SIGINT');
    harness = undefined;

    expect(context.inFlight.size).toBe(0);
  });

  it('停止定时任务调度，关闭后不再产生新的调度动作', async () => {
    harness = await createTestHarness();
    const { app, db, context } = harness;
    context.scheduler.start({ initialDelayMs: 60_000 });

    const logger = pino({ level: 'silent' });
    await gracefulShutdown({ context, app, db, logger }, 'SIGTERM');
    harness = undefined;

    // stop() 之后再注册应当被允许失败（说明已经真正停下、状态被重置）——
    // 这里换一种断言方式：直接确认 register 不再抛"调度已启动"的错误
    expect(() => context.scheduler.register({ name: 'x', intervalMs: 1000, run: () => 0 })).not.toThrow();
  });
});
