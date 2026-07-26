import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router';
import { AuthProvider } from '../auth/AuthContext';
import { ProxiesPage } from '../pages/ProxiesPage';
import type { ProxyView } from '../api';

const FULL_PLAINTEXT_ADDRESS = 'socks5://realuser:SuperSecretPass1@203.0.113.7:1080';
const MASKED_ADDRESS = 'socks5://***:***@203.0.113.7:1080';

const proxyFixture: ProxyView = {
  id: 'proxy_1',
  name: '出口节点-测试',
  url_masked: MASKED_ADDRESS,
  protocol: 'socks5',
  enabled: true,
  weight: 10,
  priority: 1,
  status: 'healthy',
  latency_ms: 42,
  last_check_at: Date.now(),
  failure_count: 0,
  cooldown_until: null,
  bound_accounts: [],
};

vi.mock('../api', async () => {
  const actual = await vi.importActual<typeof import('../api')>('../api');
  return {
    ...actual,
    api: {
      ...actual.api,
      listProxies: () => Promise.resolve([proxyFixture]),
    },
  };
});

describe('代理池地址掩码', () => {
  it('列表只渲染打码地址，完整地址（含用户名密码）不会出现在 DOM 里', async () => {
    render(
      <MemoryRouter initialEntries={['/proxies']}>
        <AuthProvider>
          <ProxiesPage />
        </AuthProvider>
      </MemoryRouter>,
    );

    expect(await screen.findByText(MASKED_ADDRESS)).toBeTruthy();
    expect(document.body.textContent?.includes(FULL_PLAINTEXT_ADDRESS)).toBe(false);
    expect(document.body.textContent?.includes('SuperSecretPass1')).toBe(false);
    expect(document.body.innerHTML.includes('SuperSecretPass1')).toBe(false);
  });
});
