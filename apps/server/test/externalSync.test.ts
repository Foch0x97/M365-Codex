import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { pino } from 'pino';
import { ExternalAccountSync } from '../src/accounts/externalSync.js';
import { loadConfig } from '../src/config/index.js';
import { Cryptor } from '../src/crypto/index.js';
import { openDatabase, runMigrations, type Database } from '../src/db/index.js';
import { AccountRepository } from '../src/repo/accounts.js';
import { makeFakeJwt } from './helpers/fakeOAuth.js';
import { testEnv } from './helpers/testApp.js';

/**
 * 外部账号文件同步测试。
 * 模拟「M365 Native 容器持续刷新 accounts.json」的场景。
 */

let db: Database | undefined;
let tempDir: string | undefined;
let sync: ExternalAccountSync | undefined;

afterEach(async () => {
  sync?.stop();
  sync = undefined;
  db?.close();
  db = undefined;
  if (tempDir !== undefined) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

function createRepo(): AccountRepository {
  const config = loadConfig(testEnv());
  db = openDatabase(':memory:');
  runMigrations(db);
  return new AccountRepository(db, new Cryptor(config.masterKey, config.masterKeyVersion));
}

function accountsPayload(emails: string[], marker: string): string {
  return JSON.stringify({
    source: 'pkce-browser-gateway-local',
    updatedAt: new Date().toISOString(),
    accounts: emails.map((email) => {
      const oid = email.split('@')[0] ?? email;
      const claims = { tid: 'tenant-1', oid, preferred_username: email };
      return {
        id: oid,
        email,
        displayName: oid,
        tid: 'tenant-1',
        oid,
        accessToken: makeFakeJwt({ ...claims, marker }),
        refreshToken: `refresh-${oid}-${marker}`,
        idToken: makeFakeJwt(claims),
        expiresAt: '2099-01-01T00:00:00Z',
      };
    }),
  });
}

async function setup(emails: string[], marker = 'v1') {
  const accounts = createRepo();
  tempDir = await mkdtemp(join(tmpdir(), 'm365-codex-sync-'));
  const filePath = join(tempDir, 'accounts.json');
  await writeFile(filePath, accountsPayload(emails, marker), 'utf8');

  sync = new ExternalAccountSync({
    filePath,
    accounts,
    logger: pino({ level: 'silent' }),
    intervalMs: 0,
  });
  return { accounts, filePath, sync };
}

describe('ExternalAccountSync', () => {
  it('首次运行导入全部账号', async () => {
    const { accounts, sync: s } = await setup(['a@office.example.invalid', 'b@office.example.invalid']);
    const state = await s.runOnce();

    expect(state.last_error).toBeNull();
    expect(state.last_summary?.created).toBe(2);
    expect(accounts.listViews()).toHaveLength(2);
  });

  it('文件未变化时跳过，不重复写库', async () => {
    const { sync: s } = await setup(['a@office.example.invalid']);
    await s.runOnce();
    const second = await s.runOnce();
    // 第二次没有产生新的导入结果（沿用上一次的 summary，但 created 不会翻倍）
    expect(second.last_summary?.created).toBe(1);
    expect(second.last_summary?.updated).toBe(0);
  });

  it('文件更新后同步新 Token', async () => {
    const { accounts, filePath, sync: s } = await setup(['a@office.example.invalid'], 'v1');
    await s.runOnce();
    const accountId = accounts.listViews()[0]!.id;
    const before = accounts.readRefreshToken(accountId);

    // 模拟 M365 Native 容器刷新了 Token
    await new Promise((resolve) => setTimeout(resolve, 15));
    await writeFile(filePath, accountsPayload(['a@office.example.invalid'], 'v2'), 'utf8');

    const state = await s.runOnce();
    expect(state.last_summary?.updated).toBe(1);
    expect(accounts.readRefreshToken(accountId)).not.toBe(before);
    expect(accounts.readRefreshToken(accountId)).toContain('v2');
  });

  it('force 可以绕过 mtime 判断强制重新导入', async () => {
    const { sync: s } = await setup(['a@office.example.invalid']);
    await s.runOnce();
    const forced = await s.runOnce(true);
    expect(forced.last_summary?.updated).toBe(1);
  });

  it('文件不存在时记录错误但不抛出', async () => {
    const accounts = createRepo();
    sync = new ExternalAccountSync({
      filePath: '/不存在的目录/accounts.json',
      accounts,
      logger: pino({ level: 'silent' }),
      intervalMs: 0,
    });
    const state = await sync.runOnce();
    expect(state.last_error).toContain('不可读');
    expect(state.last_success_at).toBeNull();
  });

  it('文件损坏时记录错误但保留已有账号', async () => {
    const { accounts, filePath, sync: s } = await setup(['a@office.example.invalid']);
    await s.runOnce();
    expect(accounts.listViews()).toHaveLength(1);

    await new Promise((resolve) => setTimeout(resolve, 15));
    await writeFile(filePath, '{ 损坏的 json', 'utf8');
    const state = await s.runOnce();

    expect(state.last_error).toContain('不是合法 JSON');
    // 已有账号不受影响
    expect(accounts.listViews()).toHaveLength(1);
  });

  it('start 在间隔为 0 时不留下定时器', async () => {
    const { sync: s } = await setup(['a@office.example.invalid']);
    await s.start();
    s.stop();
    expect(s.state.last_success_at).toBeTypeOf('number');
  });
});
