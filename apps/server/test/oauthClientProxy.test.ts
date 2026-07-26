import { ProxyAgent } from 'undici';
import { describe, expect, it } from 'vitest';
import { resolveDispatcherForTokenUrl } from '../src/oauth/client.js';

/**
 * OAuth token 端点的出口代理选择要尊重 NO_PROXY（同上游 WebSocket 连接层的
 * 约定，见 test/connection.test.ts 的 NO_PROXY 分组）：命中排除列表时，
 * 无论传入全局默认代理还是账号专属代理，都必须直连。
 */

const TOKEN_URL = 'https://login.microsoftonline.com/common/oauth2/v2.0/token';

describe('resolveDispatcherForTokenUrl', () => {
  it('未设置 NO_PROXY 时，配了 proxyUrl 就走代理', () => {
    const dispatcher = resolveDispatcherForTokenUrl(TOKEN_URL, 'http://proxy.invalid:8080', null);
    expect(dispatcher).toBeInstanceOf(ProxyAgent);
  });

  it('未配置 proxyUrl 时始终直连', () => {
    expect(resolveDispatcherForTokenUrl(TOKEN_URL, null, null)).toBeUndefined();
    expect(resolveDispatcherForTokenUrl(TOKEN_URL, undefined, null)).toBeUndefined();
  });

  it('token 端点主机命中 NO_PROXY 时直连，即使配了 proxyUrl', () => {
    const dispatcher = resolveDispatcherForTokenUrl(
      TOKEN_URL,
      'http://proxy.invalid:8080',
      'login.microsoftonline.com',
    );
    expect(dispatcher).toBeUndefined();
  });

  it('NO_PROXY 命中的是账号专属代理覆盖时同样直连', () => {
    // 模拟账号绑定了专属代理（TokenManager.refresh 的 proxyUrl 覆盖场景）
    const dispatcher = resolveDispatcherForTokenUrl(
      TOKEN_URL,
      'http://account-specific-proxy.invalid:8080',
      '*.microsoftonline.com',
    );
    expect(dispatcher).toBeUndefined();
  });

  it('NO_PROXY 里没有命中的条目不影响代理生效', () => {
    const dispatcher = resolveDispatcherForTokenUrl(TOKEN_URL, 'http://proxy.invalid:8080', 'other.invalid');
    expect(dispatcher).toBeInstanceOf(ProxyAgent);
  });
});
