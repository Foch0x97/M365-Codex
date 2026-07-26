import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { OAuthRequestError } from '../src/oauth/client.js';
import { makeFakeJwt } from './helpers/fakeOAuth.js';
import { createTestHarness, loginAdmin, type TestHarness } from './helpers/testApp.js';

let harness: TestHarness | undefined;
let tempDir: string | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
  if (tempDir !== undefined) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

function auth(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

async function setup(env: Record<string, string> = {}): Promise<{ h: TestHarness; token: string }> {
  harness = await createTestHarness(env);
  return { h: harness, token: await loginAdmin(harness.app) };
}

function seedAccount(h: TestHarness, oid = 'user-1') {
  return h.context.accounts.upsert({
    tid: 'tenant-1',
    oid,
    email: `${oid}@office.example.invalid`,
    displayName: oid,
    source: 'oauth',
    tokens: {
      accessToken: 'ACCESS-PLAINTEXT',
      refreshToken: `fake-refresh-${oid}-v1`,
      expiresAt: Date.now() + 3600_000,
    },
  });
}

describe('GET /admin/accounts', () => {
  it('列表不含 Token', async () => {
    const { h, token } = await setup();
    seedAccount(h);
    const response = await h.app.inject({
      method: 'GET',
      url: '/admin/accounts',
      headers: auth(token),
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain('ACCESS-PLAINTEXT');
    expect(response.body).not.toContain('fake-refresh');
    const data = (response.json() as { data: { has_refresh_token: boolean }[] }).data;
    expect(data[0]?.has_refresh_token).toBe(true);
  });

  it('未登录返回 401', async () => {
    harness = await createTestHarness();
    expect((await harness.app.inject({ method: 'GET', url: '/admin/accounts' })).statusCode).toBe(401);
  });

  it('查询不存在的账号返回 404', async () => {
    const { h, token } = await setup();
    const response = await h.app.inject({
      method: 'GET',
      url: '/admin/accounts/not-exist',
      headers: auth(token),
    });
    expect(response.statusCode).toBe(404);
  });
});

describe('PATCH /admin/accounts/:id/status', () => {
  it('允许的状态迁移返回新状态', async () => {
    const { h, token } = await setup();
    const account = seedAccount(h);
    const response = await h.app.inject({
      method: 'PATCH',
      url: `/admin/accounts/${account.id}/status`,
      headers: auth(token),
      payload: { status: 'online' },
    });
    expect(response.statusCode).toBe(200);
    expect((response.json() as { status: string }).status).toBe('online');
  });

  it('非法迁移返回 400 并说明原因', async () => {
    const { h, token } = await setup();
    const account = seedAccount(h);
    h.context.accounts.forceStatus(account.id, 'disabled');

    const response = await h.app.inject({
      method: 'PATCH',
      url: `/admin/accounts/${account.id}/status`,
      headers: auth(token),
      payload: { status: 'online' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.body).toContain('不允许从 disabled 迁移到 online');
  });

  it('未知状态值返回 400', async () => {
    const { h, token } = await setup();
    const account = seedAccount(h);
    const response = await h.app.inject({
      method: 'PATCH',
      url: `/admin/accounts/${account.id}/status`,
      headers: auth(token),
      payload: { status: '随便一个状态' },
    });
    expect(response.statusCode).toBe(400);
  });
});

describe('POST /admin/accounts/:id/refresh', () => {
  it('刷新成功返回账号视图且不含 Token', async () => {
    const { h, token } = await setup();
    const account = seedAccount(h);
    const response = await h.app.inject({
      method: 'POST',
      url: `/admin/accounts/${account.id}/refresh`,
      headers: auth(token),
    });
    expect(response.statusCode).toBe(200);
    const newToken = h.context.accounts.readAccessToken(account.id)?.token ?? '';
    expect(response.body).not.toContain(newToken);
    expect(h.oauth.refreshCount).toBe(1);
  });

  it('刷新凭据失效时返回 409', async () => {
    const { h, token } = await setup();
    const account = seedAccount(h);
    h.oauth.nextRefreshError = new OAuthRequestError(400, 'invalid_grant', '已失效');

    const response = await h.app.inject({
      method: 'POST',
      url: `/admin/accounts/${account.id}/refresh`,
      headers: auth(token),
    });
    expect(response.statusCode).toBe(409);
    expect(h.context.accounts.findById(account.id)?.status).toBe('reauth_required');
  });

  it('上游临时故障返回 502', async () => {
    const { h, token } = await setup();
    const account = seedAccount(h);
    h.oauth.nextRefreshError = new OAuthRequestError(503, 'temporarily_unavailable', '抖动');

    const response = await h.app.inject({
      method: 'POST',
      url: `/admin/accounts/${account.id}/refresh`,
      headers: auth(token),
    });
    expect(response.statusCode).toBe(502);
  });
});

describe('DELETE /admin/accounts/:id', () => {
  it('删除账号并写审计', async () => {
    const { h, token } = await setup();
    const account = seedAccount(h);
    const response = await h.app.inject({
      method: 'DELETE',
      url: `/admin/accounts/${account.id}`,
      headers: auth(token),
    });
    expect(response.statusCode).toBe(200);
    expect(h.context.accounts.listViews()).toHaveLength(0);

    const audit = await h.app.inject({
      method: 'GET',
      url: '/admin/audit-logs',
      headers: auth(token),
    });
    expect(audit.body).toContain('account.delete');
    // 审计里只有脱敏邮箱
    expect(audit.body).toContain('us***@office.example.invalid');
  });
});

describe('POST /admin/accounts/import', () => {
  async function writeAccountsFile(emails: string[]): Promise<string> {
    tempDir = await mkdtemp(join(tmpdir(), 'm365-codex-routes-'));
    const filePath = join(tempDir, 'accounts.json');
    await writeFile(
      filePath,
      JSON.stringify({
        source: 'pkce-browser-gateway-local',
        updatedAt: '2026-07-25T08:00:00Z',
        accounts: emails.map((email) => {
          const oid = email.split('@')[0] ?? email;
          return {
            id: oid,
            email,
            tid: 'tenant-1',
            oid,
            accessToken: makeFakeJwt({ tid: 'tenant-1', oid, preferred_username: email }),
            refreshToken: `refresh-${oid}`,
            expiresAt: '2099-01-01T00:00:00Z',
          };
        }),
      }),
      'utf8',
    );
    return filePath;
  }

  it('按路径导入账号', async () => {
    const { h, token } = await setup();
    const filePath = await writeAccountsFile([
      'foch001@office.example.invalid',
      'foch002@office.example.invalid',
    ]);

    const response = await h.app.inject({
      method: 'POST',
      url: '/admin/accounts/import',
      headers: auth(token),
      payload: { file: filePath },
    });
    expect(response.statusCode).toBe(200);
    const summary = response.json() as { total: number; created: number };
    expect(summary.total).toBe(2);
    expect(summary.created).toBe(2);
    expect(h.context.accounts.listViews()).toHaveLength(2);
  });

  it('未指定路径且未配置外部文件时返回 400', async () => {
    const { h, token } = await setup();
    const response = await h.app.inject({
      method: 'POST',
      url: '/admin/accounts/import',
      headers: auth(token),
      payload: {},
    });
    expect(response.statusCode).toBe(400);
    expect(response.body).toContain('EXTERNAL_ACCOUNTS_FILE');
  });

  it('文件不存在返回 400 而不是 500', async () => {
    const { h, token } = await setup();
    const response = await h.app.inject({
      method: 'POST',
      url: '/admin/accounts/import',
      headers: auth(token),
      payload: { file: '/不存在/accounts.json' },
    });
    expect(response.statusCode).toBe(400);
  });
});

describe('外部同步状态接口', () => {
  it('未配置时报告 enabled=false', async () => {
    const { h, token } = await setup();
    const response = await h.app.inject({
      method: 'GET',
      url: '/admin/accounts-sync/status',
      headers: auth(token),
    });
    expect(response.statusCode).toBe(200);
    expect((response.json() as { enabled: boolean }).enabled).toBe(false);
  });

  it('未配置时手动触发返回 400', async () => {
    const { h, token } = await setup();
    const response = await h.app.inject({
      method: 'POST',
      url: '/admin/accounts-sync/run',
      headers: auth(token),
    });
    expect(response.statusCode).toBe(400);
  });

  it('配置后可查询状态并手动触发同步', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'm365-codex-routes-'));
    const filePath = join(tempDir, 'accounts.json');
    await writeFile(
      filePath,
      JSON.stringify({
        accounts: [
          {
            email: 'sync@office.example.invalid',
            tid: 'tenant-1',
            oid: 'sync-user',
            accessToken: makeFakeJwt({ tid: 'tenant-1', oid: 'sync-user' }),
            refreshToken: 'refresh-sync',
            expiresAt: '2099-01-01T00:00:00Z',
          },
        ],
      }),
      'utf8',
    );

    const { h, token } = await setup({
      EXTERNAL_ACCOUNTS_FILE: filePath,
      EXTERNAL_ACCOUNTS_SYNC_INTERVAL_MS: '0',
    });

    const status = await h.app.inject({
      method: 'GET',
      url: '/admin/accounts-sync/status',
      headers: auth(token),
    });
    expect((status.json() as { enabled: boolean }).enabled).toBe(true);

    const run = await h.app.inject({
      method: 'POST',
      url: '/admin/accounts-sync/run',
      headers: auth(token),
    });
    expect(run.statusCode).toBe(200);
    expect(h.context.accounts.listViews()).toHaveLength(1);
    expect(h.context.accounts.listViews()[0]?.source).toBe('sync:m365-native');
  });
});
