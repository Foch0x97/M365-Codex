import { createLogger } from '../../../apps/server/dist/observability/logger.js';
import { SydneyCodecV1 } from '../../../apps/server/dist/adapter/codecV1.js';
import type { AccountRepository } from '../../../apps/server/dist/repo/accounts.js';
import type { OAuthClient } from '../../../apps/server/dist/oauth/client.js';
import type { TokenManager } from '../../../apps/server/dist/oauth/tokenManager.js';
import type { ProbeContext } from '../../src/types.js';

/**
 * 测试用的最小 `ProbeContext`：只把「跑一次 invocation」所需的字段填真，
 * Token 刷新相关的依赖（`accounts`/`oauthClient`/`tokenManager`）用不会被
 * 调用到的占位对象填充——用到的用例会在各自的测试里替换成真正的 fake。
 */
export function makeFakeContext(mockServerUrl: string, overrides: Partial<ProbeContext> = {}): ProbeContext {
  return {
    account: { id: 'test-account', oid: 'test-oid', tid: 'test-tid', email: 'probe@example.invalid' },
    getAccessToken: () => Promise.resolve('mock-access-token-not-real'),
    upstream: {
      wsBase: mockServerUrl,
      pathTemplate: '/{oid}@{tid}',
      protocolVersion: 'sydney-json-v1',
      heartbeatIntervalMs: 15_000,
      handshakeTimeoutMs: 2000,
      idleTimeoutMs: 2000,
    },
    codec: new SydneyCodecV1(),
    logger: createLogger({ level: 'silent', privacyMode: 'strict' }),
    delayMs: 0,
    repeat: 3,
    invocationTimeoutMs: 5000,
    accounts: {} as unknown as AccountRepository,
    oauthClient: {} as unknown as OAuthClient,
    tokenManager: {} as unknown as TokenManager,
    ...overrides,
  };
}
