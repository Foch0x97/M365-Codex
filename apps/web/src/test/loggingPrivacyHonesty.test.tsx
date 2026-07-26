import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router';
import { AuthProvider } from '../auth/AuthContext';
import { LoggingSettingsPage } from '../pages/LoggingSettingsPage';
import type { SettingsResponse } from '../api';

/**
 * 服务端 `log_privacy_mode` 只是个普通字符串设置项：没有过期时间字段、没有定时任务把它切回
 * strict、也没有对应审计动作（全仓库 debugUntil/debug_expires 零匹配）。之前页面文案却向管理员
 * 承诺「会自动过期恢复 strict」「到期自动恢复 strict 并写入审计日志」，这是服务端不存在的机制，
 * 管理员会因此误以为切到 debug 是安全的、会自己收敛，实际上会无限期停留在 debug。
 * 这里断言页面不再出现这类虚假的自动恢复承诺，并且确实提示了需要手动改回。
 */

const settingsFixture: SettingsResponse = {
  network: {
    public_api_base_url: { value: 'http://192.168.0.5:8080/v1', source: 'db', editable: true, requires_restart: true },
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

describe('日志隐私模式文案如实描述（不承诺服务端不存在的自动过期）', () => {
  it('不再出现"自动过期"/"到期自动恢复"这类虚假承诺，且明确提示需手动改回', async () => {
    render(
      <MemoryRouter initialEntries={['/settings/logging']}>
        <AuthProvider>
          <LoggingSettingsPage />
        </AuthProvider>
      </MemoryRouter>,
    );

    await screen.findByLabelText(/隐私模式/);

    // 之前的虚假承诺：「会自动过期恢复 strict」「到期自动恢复 strict 并写入审计日志」——
    // 服务端根本没有这个机制，这两句具体措辞不能再出现（允许如实说明「没有自动过期机制」）。
    expect(document.body.textContent?.includes('会自动过期恢复')).toBe(false);
    expect(document.body.textContent?.includes('到期自动恢复')).toBe(false);
    expect(screen.getByText(/没有自动过期机制/)).toBeTruthy();
    expect(screen.getByText(/必须手动改回来/)).toBeTruthy();
  });
});
