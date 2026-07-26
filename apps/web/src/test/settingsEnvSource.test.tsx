import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router';
import { AuthProvider } from '../auth/AuthContext';
import { SystemSettingsPage } from '../pages/SystemSettingsPage';
import type { SettingsResponse } from '../api';

/**
 * source="env" 的设置项：容器编排是唯一真源，界面必须禁用输入并明确提示
 * 「改这里不会生效」，不能让人误以为保存按钮真的能覆盖环境变量。
 */
const settingsFixture: SettingsResponse = {
  network: {
    public_api_base_url: { value: 'http://192.168.0.5:8080/v1', source: 'env', editable: false, requires_restart: true },
    public_admin_url: { value: 'http://192.168.0.5:8080/admin', source: 'db', editable: true, requires_restart: true },
    trust_proxy: { value: false, source: 'default', editable: true, requires_restart: true },
    http_proxy: { value: '', source: 'default', editable: true, requires_restart: true },
    https_proxy: { value: '', source: 'default', editable: true, requires_restart: true },
    no_proxy: { value: '', source: 'default', editable: true, requires_restart: true },
  },
  scheduler: {
    cleanup_interval_ms: { value: 300_000, source: 'default', editable: true, requires_restart: true },
    response_retention_ms: { value: 604_800_000, source: 'default', editable: true, requires_restart: true },
    audit_log_retention_ms: { value: 2_592_000_000, source: 'default', editable: true, requires_restart: true },
    idempotency_retention_ms: { value: 86_400_000, source: 'default', editable: true, requires_restart: true },
    files_retention_ms: { value: 259_200_000, source: 'default', editable: true, requires_restart: true },
    files_upload_ttl_ms: { value: 3_600_000, source: 'default', editable: true, requires_restart: true },
  },
  logging: {
    log_level: { value: 'info', source: 'default', editable: true, requires_restart: false },
    log_privacy_mode: { value: 'strict', source: 'default', editable: true, requires_restart: true },
  },
  oauth: {
    client_id: { value: 'client-id', source: 'default', editable: true, requires_restart: true },
    redirect_uri: { value: 'https://login.microsoftonline.com/common/oauth2/nativeclient', source: 'default', editable: true, requires_restart: true },
    authorize_url: { value: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize', source: 'default', editable: true, requires_restart: true },
    token_url: { value: 'https://login.microsoftonline.com/common/oauth2/v2.0/token', source: 'default', editable: true, requires_restart: true },
    scopes: { value: ['openid', 'profile'], source: 'default', editable: true, requires_restart: true },
  },
  tools: {
    mode: { value: 'auto', source: 'default', editable: true, requires_restart: true },
    max_calls_per_round: { value: 4, source: 'default', editable: true, requires_restart: true },
    max_rounds: { value: 8, source: 'default', editable: true, requires_restart: true },
    max_total_calls: { value: 32, source: 'default', editable: true, requires_restart: true },
    max_result_bytes: { value: 65_536, source: 'default', editable: true, requires_restart: true },
    max_arg_repairs: { value: 2, source: 'default', editable: true, requires_restart: true },
    allow_parallel: { value: true, source: 'default', editable: true, requires_restart: true },
  },
  files: {
    max_file_bytes: { value: 20_971_520, source: 'default', editable: true, requires_restart: true },
    max_request_bytes: { value: 52_428_800, source: 'default', editable: true, requires_restart: true },
    max_total_bytes_per_key: { value: 524_288_000, source: 'default', editable: true, requires_restart: true },
  },
};

vi.mock('../api', async () => {
  const actual = await vi.importActual<typeof import('../api')>('../api');
  return {
    ...actual,
    api: {
      ...actual.api,
      getSettings: () => Promise.resolve(settingsFixture),
    },
  };
});

describe('设置页 source=env 的禁用展示', () => {
  it('env 来源的字段渲染为禁用输入，并提示改这里不会生效', async () => {
    render(
      <MemoryRouter initialEntries={['/settings/system']}>
        <AuthProvider>
          <SystemSettingsPage />
        </AuthProvider>
      </MemoryRouter>,
    );

    const input = (await screen.findByLabelText(/对外 API Base URL/)) as HTMLInputElement;
    expect(input.disabled).toBe(true);
    expect(input.value).toBe('http://192.168.0.5:8080/v1');

    expect(screen.getAllByText('由环境变量固定，改这里不会生效。').length).toBeGreaterThan(0);

    // 同一分组里 source=db 的字段应保持可编辑，不能被 env 字段的禁用状态误伤
    const adminUrlInput = (await screen.findByLabelText(/管理界面公开地址/)) as HTMLInputElement;
    expect(adminUrlInput.disabled).toBe(false);
  });

  it('max_arg_repairs 输入框限制在 0-2 之间，并说明这是协议规则', async () => {
    render(
      <MemoryRouter initialEntries={['/settings/system']}>
        <AuthProvider>
          <SystemSettingsPage />
        </AuthProvider>
      </MemoryRouter>,
    );

    const input = (await screen.findByLabelText(/参数修复最大次数/)) as HTMLInputElement;
    expect(input.min).toBe('0');
    expect(input.max).toBe('2');
    expect(screen.getByText(/协议规则封顶 2 次/)).toBeTruthy();
  });
});
