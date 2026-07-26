import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router';
import { AuthProvider } from '../auth/AuthContext';
import { ApiKeysPage } from '../pages/ApiKeysPage';
import type { ApiKeyCreated, ApiKeyView } from '../api';

const PLAINTEXT_KEY = 'sk-TESTONLYNOTREALSECRETVALUE0000000000000000';

const listApiKeys = vi.fn<[], Promise<ApiKeyView[]>>();
const createApiKey = vi.fn<[unknown], Promise<ApiKeyCreated>>();

vi.mock('../api', async () => {
  const actual = await vi.importActual<typeof import('../api')>('../api');
  return {
    ...actual,
    api: {
      ...actual.api,
      listApiKeys: (...args: []) => listApiKeys(...args),
      createApiKey: (...args: [unknown]) => createApiKey(...args),
    },
  };
});

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/api-keys']}>
      <AuthProvider>
        <ApiKeysPage />
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe('API Key 明文只显示一次', () => {
  beforeEach(() => {
    listApiKeys.mockReset().mockResolvedValue([]);
    createApiKey.mockReset();
  });

  it('创建后弹窗展示明文，关闭前必须勾选「我已保存」，关闭后列表只剩掩码', async () => {
    const created: ApiKeyCreated = {
      id: 'key_new',
      name: '测试密钥',
      masked_key: 'sk-Ab12************wxYZ',
      enabled: true,
      created_at: Date.now(),
      starts_at: null,
      expires_at: null,
      revoked_at: null,
      last_used_at: null,
      rpm_limit: null,
      daily_limit: null,
      max_concurrency: null,
      allowed_endpoints: null,
      allowed_models: null,
      key: PLAINTEXT_KEY,
    };
    createApiKey.mockResolvedValue(created);
    listApiKeys
      .mockResolvedValueOnce([]) // 初次加载
      .mockResolvedValueOnce([created]); // 创建后刷新

    renderPage();

    const nameInput = await screen.findByLabelText('名称');
    fireEvent.change(nameInput, { target: { value: '测试密钥' } });
    fireEvent.click(screen.getByRole('button', { name: '创建' }));

    // 明文只应该在弹窗里出现一次
    await screen.findByText(PLAINTEXT_KEY);
    expect(screen.getByText('这是唯一一次显示完整密钥的机会')).toBeTruthy();

    const closeButton = screen.getByRole('button', { name: '关闭' });
    // 未勾选「我已保存」之前，关闭按钮必须被禁用
    expect((closeButton as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByLabelText('我已保存这个密钥'));
    expect((closeButton as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(closeButton);

    await waitFor(() => {
      expect(screen.queryByText(PLAINTEXT_KEY)).toBeNull();
    });
    // 关闭后列表页只应该显示掩码，明文不能残留在 DOM 任何地方
    expect(screen.getByText(created.masked_key)).toBeTruthy();
    expect(document.body.textContent?.includes(PLAINTEXT_KEY)).toBe(false);
  });
});
