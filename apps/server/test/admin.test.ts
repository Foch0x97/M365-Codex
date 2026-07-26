import { afterEach, describe, expect, it } from 'vitest';
import type { ApiKeyCreated, ApiKeyView } from '@m365-codex/shared';
import { createTestHarness, loginAdmin, TEST_ADMIN_PASSWORD, type TestHarness } from './helpers/testApp.js';

let harness: TestHarness | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

async function setup(): Promise<{ harness: TestHarness; token: string }> {
  harness = await createTestHarness();
  const token = await loginAdmin(harness.app);
  return { harness, token };
}

function auth(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

describe('POST /admin/login', () => {
  it('密码正确时下发会话令牌', async () => {
    harness = await createTestHarness();
    const response = await harness.app.inject({
      method: 'POST',
      url: '/admin/login',
      payload: { password: TEST_ADMIN_PASSWORD },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { token: string; expires_at: number };
    expect(body.token.length).toBeGreaterThan(20);
    expect(body.expires_at).toBeGreaterThan(Date.now());
  });

  it('密码错误返回 401 且不下发令牌', async () => {
    harness = await createTestHarness();
    const response = await harness.app.inject({
      method: 'POST',
      url: '/admin/login',
      payload: { password: 'wrong-password' },
    });
    expect(response.statusCode).toBe(401);
    const body = response.json() as { error: { type: string } };
    expect(body.error.type).toBe('authentication_error');
    expect(response.body).not.toContain('token');
  });

  it('连续失败后触发登录节流', async () => {
    harness = await createTestHarness();
    let lastStatus = 0;
    for (let i = 0; i < 10; i += 1) {
      const response = await harness.app.inject({
        method: 'POST',
        url: '/admin/login',
        payload: { password: 'wrong-password' },
      });
      lastStatus = response.statusCode;
    }
    expect(lastStatus).toBe(429);
  });

  it('缺少密码字段返回 400', async () => {
    harness = await createTestHarness();
    const response = await harness.app.inject({ method: 'POST', url: '/admin/login', payload: {} });
    expect(response.statusCode).toBe(400);
    expect((response.json() as { error: { type: string } }).error.type).toBe('invalid_request_error');
  });
});

describe('管理端会话', () => {
  it('无令牌访问受保护接口返回 401', async () => {
    harness = await createTestHarness();
    const response = await harness.app.inject({ method: 'GET', url: '/admin/api-keys' });
    expect(response.statusCode).toBe(401);
  });

  it('伪造令牌返回 401', async () => {
    harness = await createTestHarness();
    const response = await harness.app.inject({
      method: 'GET',
      url: '/admin/api-keys',
      headers: auth('forged-token'),
    });
    expect(response.statusCode).toBe(401);
  });

  it('登出后令牌立即失效', async () => {
    const { harness: h, token } = await setup();
    expect((await h.app.inject({ method: 'POST', url: '/admin/logout', headers: auth(token) })).statusCode).toBe(
      200,
    );
    const after = await h.app.inject({ method: 'GET', url: '/admin/api-keys', headers: auth(token) });
    expect(after.statusCode).toBe(401);
  });
});

describe('API Key 管理', () => {
  it('创建时返回一次明文 Key，之后不再出现', async () => {
    const { harness: h, token } = await setup();
    const created = await h.app.inject({
      method: 'POST',
      url: '/admin/api-keys',
      headers: auth(token),
      payload: { name: '本地 Codex' },
    });
    expect(created.statusCode).toBe(201);
    const body = created.json() as ApiKeyCreated;
    expect(body.key.startsWith('sk-')).toBe(true);
    expect(body.masked_key).not.toBe(body.key);

    const list = await h.app.inject({ method: 'GET', url: '/admin/api-keys', headers: auth(token) });
    expect(list.body).not.toContain(body.key);
    const keys = (list.json() as { data: ApiKeyView[] }).data;
    expect(keys).toHaveLength(1);
    expect(keys[0]?.masked_key).toBe(body.masked_key);
  });

  it('数据库中只存哈希，不存明文', async () => {
    const { harness: h, token } = await setup();
    const created = (
      await h.app.inject({
        method: 'POST',
        url: '/admin/api-keys',
        headers: auth(token),
        payload: { name: '哈希校验' },
      })
    ).json() as ApiKeyCreated;

    const rows = h.db.prepare('SELECT * FROM api_keys').all() as Record<string, unknown>[];
    expect(JSON.stringify(rows)).not.toContain(created.key);
    expect(rows[0]?.hash).toBeTypeOf('string');
    expect(rows[0]?.salt).toBeTypeOf('string');
  });

  it('创建时校验有效期窗口', async () => {
    const { harness: h, token } = await setup();
    const response = await h.app.inject({
      method: 'POST',
      url: '/admin/api-keys',
      headers: auth(token),
      payload: { name: '窗口非法', starts_at: 2000, expires_at: 1000 },
    });
    expect(response.statusCode).toBe(400);
    expect((response.json() as { error: { param: string } }).error.param).toBe('expires_at');
  });

  it('创建时拒绝空名称', async () => {
    const { harness: h, token } = await setup();
    const response = await h.app.inject({
      method: 'POST',
      url: '/admin/api-keys',
      headers: auth(token),
      payload: { name: '' },
    });
    expect(response.statusCode).toBe(400);
  });

  it('可以停用与撤销', async () => {
    const { harness: h, token } = await setup();
    const created = (
      await h.app.inject({
        method: 'POST',
        url: '/admin/api-keys',
        headers: auth(token),
        payload: { name: '待撤销' },
      })
    ).json() as ApiKeyCreated;

    const disabled = await h.app.inject({
      method: 'PATCH',
      url: `/admin/api-keys/${created.id}`,
      headers: auth(token),
      payload: { enabled: false },
    });
    expect(disabled.statusCode).toBe(200);
    expect((disabled.json() as ApiKeyView).enabled).toBe(false);

    const revoked = await h.app.inject({
      method: 'DELETE',
      url: `/admin/api-keys/${created.id}`,
      headers: auth(token),
    });
    expect(revoked.statusCode).toBe(200);
    expect((revoked.json() as ApiKeyView).revoked_at).toBeTypeOf('number');
  });

  it('操作不存在的 Key 返回 404', async () => {
    const { harness: h, token } = await setup();
    const response = await h.app.inject({
      method: 'DELETE',
      url: '/admin/api-keys/00000000-0000-0000-0000-000000000000',
      headers: auth(token),
    });
    expect(response.statusCode).toBe(404);
  });

  describe('§10.1 补充字段：备注 / 累计请求次数 / 工具调用与上传大小限制', () => {
    it('创建时可以写入备注与限制，列表/创建响应都能读到', async () => {
      const { harness: h, token } = await setup();
      const created = await h.app.inject({
        method: 'POST',
        url: '/admin/api-keys',
        headers: auth(token),
        payload: { name: '带备注', note: '给某某项目用', max_tool_calls: 5, max_file_bytes: 1024 },
      });
      expect(created.statusCode).toBe(201);
      const body = created.json() as {
        note: string | null;
        request_count: number;
        max_tool_calls: number | null;
        max_file_bytes: number | null;
      };
      expect(body.note).toBe('给某某项目用');
      expect(body.request_count).toBe(0);
      expect(body.max_tool_calls).toBe(5);
      expect(body.max_file_bytes).toBe(1024);

      const list = await h.app.inject({ method: 'GET', url: '/admin/api-keys', headers: auth(token) });
      const keys = (list.json() as { data: typeof body[] }).data;
      expect(keys[0]?.note).toBe('给某某项目用');
      expect(keys[0]?.max_tool_calls).toBe(5);
      expect(keys[0]?.max_file_bytes).toBe(1024);
    });

    it('不传时默认 null / 0，不强制要求这些字段', async () => {
      const { harness: h, token } = await setup();
      const created = await h.app.inject({
        method: 'POST',
        url: '/admin/api-keys',
        headers: auth(token),
        payload: { name: '不带备注' },
      });
      const body = created.json() as {
        note: string | null;
        request_count: number;
        max_tool_calls: number | null;
        max_file_bytes: number | null;
      };
      expect(body.note).toBeNull();
      expect(body.request_count).toBe(0);
      expect(body.max_tool_calls).toBeNull();
      expect(body.max_file_bytes).toBeNull();
    });

    it('PATCH 可以更新备注与限制', async () => {
      const { harness: h, token } = await setup();
      const created = (
        await h.app.inject({
          method: 'POST',
          url: '/admin/api-keys',
          headers: auth(token),
          payload: { name: '待更新' },
        })
      ).json() as { id: string };

      const updated = await h.app.inject({
        method: 'PATCH',
        url: `/admin/api-keys/${created.id}`,
        headers: auth(token),
        payload: { note: '新备注', max_tool_calls: 3, max_file_bytes: 2048 },
      });
      expect(updated.statusCode).toBe(200);
      const body = updated.json() as { note: string | null; max_tool_calls: number | null; max_file_bytes: number | null };
      expect(body.note).toBe('新备注');
      expect(body.max_tool_calls).toBe(3);
      expect(body.max_file_bytes).toBe(2048);
    });

    it('备注过长时拒绝', async () => {
      const { harness: h, token } = await setup();
      const response = await h.app.inject({
        method: 'POST',
        url: '/admin/api-keys',
        headers: auth(token),
        payload: { name: '备注超长', note: 'x'.repeat(501) },
      });
      expect(response.statusCode).toBe(400);
    });

    it('累计请求次数随实际调用增加（管理界面用量展示）', async () => {
      const { harness: h, token } = await setup();
      const created = (
        await h.app.inject({
          method: 'POST',
          url: '/admin/api-keys',
          headers: auth(token),
          payload: { name: '用量统计' },
        })
      ).json() as { key: string; id: string };

      await h.app.inject({ method: 'GET', url: '/v1/models', headers: { authorization: `Bearer ${created.key}` } });
      await h.app.inject({ method: 'GET', url: '/v1/models', headers: { authorization: `Bearer ${created.key}` } });

      const list = await h.app.inject({ method: 'GET', url: '/admin/api-keys', headers: auth(token) });
      const keys = (list.json() as { data: { id: string; request_count: number }[] }).data;
      expect(keys.find((k) => k.id === created.id)?.request_count).toBe(2);
    });
  });
});

describe('审计日志', () => {
  it('记录登录与 Key 创建，且不含凭据', async () => {
    const { harness: h, token } = await setup();
    const created = (
      await h.app.inject({
        method: 'POST',
        url: '/admin/api-keys',
        headers: auth(token),
        payload: { name: '审计校验' },
      })
    ).json() as ApiKeyCreated;

    const response = await h.app.inject({ method: 'GET', url: '/admin/audit-logs', headers: auth(token) });
    expect(response.statusCode).toBe(200);
    const actions = (response.json() as { data: { action: string }[] }).data.map((row) => row.action);
    expect(actions).toEqual(expect.arrayContaining(['admin.login.success', 'api_key.create']));
    expect(response.body).not.toContain(created.key);
    expect(response.body).not.toContain(TEST_ADMIN_PASSWORD);
  });
});
