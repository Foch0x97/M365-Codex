import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/index.js';
import { Cryptor } from '../src/crypto/index.js';
import { openDatabase, runMigrations, type Database } from '../src/db/index.js';
import {
  importAccountsFromFile,
  importAccountsFromObject,
  maskEmail,
  parseIsoTimestamp,
} from '../src/accounts/importer.js';
import { AccountRepository } from '../src/repo/accounts.js';
import { makeFakeJwt } from './helpers/fakeOAuth.js';
import { testEnv } from './helpers/testApp.js';

/**
 * 导入器测试全部使用**虚构**的账号文件。
 * 真实的 accounts.json 绝不进入仓库或测试夹具。
 */

let db: Database | undefined;
let tempDir: string | undefined;

afterEach(async () => {
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

/** 构造一份与 M365 Native 助手输出同构的账号文件。 */
function makeAccountsFile(
  accounts: {
    email: string;
    tid?: string;
    oid?: string;
    accessToken?: string;
    refreshToken?: string | null;
    expiresAt?: string;
    omitIdentity?: boolean;
  }[],
): Record<string, unknown> {
  return {
    source: 'pkce-browser-gateway-local',
    clientId: 'fake-client-id',
    redirectUri: 'https://login.microsoftonline.com/common/oauth2/nativeclient',
    updatedAt: '2026-07-25T08:00:00Z',
    accounts: accounts.map((account) => {
      const tid = account.tid ?? 'tenant-1';
      const oid = account.oid ?? account.email.split('@')[0];
      const claims = { tid, oid, preferred_username: account.email };
      const entry: Record<string, unknown> = {
        id: oid,
        email: account.email,
        displayName: account.email.split('@')[0],
        status: 'online',
        accessToken: account.accessToken ?? makeFakeJwt(claims),
        idToken: makeFakeJwt(claims),
        expiresAt: account.expiresAt ?? '2099-01-01T00:00:00Z',
        updatedAt: '2026-07-25T08:00:00Z',
        aud: 'https://substrate.office.com/sydney',
      };
      if (account.refreshToken !== null) {
        entry.refreshToken = account.refreshToken ?? `fake-refresh-${String(oid)}`;
      }
      if (account.omitIdentity !== true) {
        entry.tid = tid;
        entry.oid = oid;
      }
      return entry;
    }),
  };
}

describe('maskEmail', () => {
  it('保留前两位与域名', () => {
    expect(maskEmail('foch0x97@office.example.invalid')).toBe('fo***@office.example.invalid');
  });

  it('处理空值与异常格式', () => {
    expect(maskEmail(null)).toBe('(无邮箱)');
    expect(maskEmail('')).toBe('(无邮箱)');
    expect(maskEmail('没有at符号')).toBe('***');
  });
});

describe('parseIsoTimestamp', () => {
  it('解析 ISO 时间串', () => {
    expect(parseIsoTimestamp('2026-07-25T08:00:00Z')).toBe(Date.parse('2026-07-25T08:00:00Z'));
  });

  it('无法解析时返回 null', () => {
    expect(parseIsoTimestamp(undefined)).toBeNull();
    expect(parseIsoTimestamp('')).toBeNull();
    expect(parseIsoTimestamp('不是时间')).toBeNull();
  });
});

describe('importAccountsFromObject', () => {
  it('导入多个账号并给出计数', () => {
    const repo = createRepo();
    const summary = importAccountsFromObject(
      makeAccountsFile([
        { email: 'foch001@office.example.invalid' },
        { email: 'foch002@office.example.invalid' },
        { email: 'foch003@office.example.invalid' },
      ]),
      repo,
    );

    expect(summary.total).toBe(3);
    expect(summary.created).toBe(3);
    expect(summary.updated).toBe(0);
    expect(summary.skipped).toHaveLength(0);
    expect(repo.listViews()).toHaveLength(3);
  });

  it('二次导入同一份文件走更新，不产生重复账号', () => {
    const repo = createRepo();
    const file = makeAccountsFile([
      { email: 'foch001@office.example.invalid' },
      { email: 'foch002@office.example.invalid' },
    ]);
    importAccountsFromObject(file, repo);
    const second = importAccountsFromObject(file, repo);

    expect(second.created).toBe(0);
    expect(second.updated).toBe(2);
    expect(repo.listViews()).toHaveLength(2);
  });

  it('文件内重复的 (tid, oid) 只取最后一条', () => {
    const repo = createRepo();
    const file = makeAccountsFile([
      { email: 'dup@office.example.invalid', oid: 'same', accessToken: 'token-old' },
      { email: 'dup@office.example.invalid', oid: 'same', accessToken: 'token-new' },
    ]);
    const summary = importAccountsFromObject(file, repo);

    expect(summary.total).toBe(2);
    expect(summary.created).toBe(1);
    const view = repo.listViews()[0];
    expect(repo.readAccessToken(view!.id)?.token).toBe('token-new');
  });

  it('tid/oid 缺失时从 Token 声明里补齐', () => {
    const repo = createRepo();
    const summary = importAccountsFromObject(
      makeAccountsFile([
        { email: 'claims@office.example.invalid', oid: 'from-claims', omitIdentity: true },
      ]),
      repo,
    );
    expect(summary.created).toBe(1);
    expect(repo.listViews()[0]?.oid).toBe('from-claims');
  });

  it('完全无法识别身份的条目被跳过，不影响其他账号', () => {
    const repo = createRepo();
    const file = makeAccountsFile([{ email: 'ok@office.example.invalid' }]);
    (file.accounts as unknown[]).push({
      email: 'broken@office.example.invalid',
      accessToken: 'not-a-jwt',
    });

    const summary = importAccountsFromObject(file, repo);
    expect(summary.created).toBe(1);
    expect(summary.skipped).toHaveLength(1);
    expect(summary.skipped[0]?.email).toBe('br***@office.example.invalid');
    expect(summary.skipped[0]?.reason).toContain('tid 或 oid');
  });

  it('缺少 accessToken 的条目被跳过', () => {
    const repo = createRepo();
    const file = makeAccountsFile([{ email: 'ok@office.example.invalid' }]);
    (file.accounts as Record<string, unknown>[]).push({
      email: 'notoken@office.example.invalid',
      tid: 'tenant-1',
      oid: 'notoken',
    });

    const summary = importAccountsFromObject(file, repo);
    expect(summary.skipped).toHaveLength(1);
    expect(summary.skipped[0]?.reason).toContain('accessToken');
  });

  it('skipExpired 打开时跳过已过期条目', () => {
    const repo = createRepo();
    const file = makeAccountsFile([
      { email: 'fresh@office.example.invalid', expiresAt: '2099-01-01T00:00:00Z' },
      { email: 'stale@office.example.invalid', expiresAt: '2020-01-01T00:00:00Z' },
    ]);

    const summary = importAccountsFromObject(file, repo, { skipExpired: true });
    expect(summary.created).toBe(1);
    expect(summary.skipped[0]?.reason).toContain('已过期');
  });

  it('默认不跳过已过期条目——它们可能还带着有效的 refresh_token', () => {
    const repo = createRepo();
    const summary = importAccountsFromObject(
      makeAccountsFile([{ email: 'stale@office.example.invalid', expiresAt: '2020-01-01T00:00:00Z' }]),
      repo,
    );
    expect(summary.created).toBe(1);
    expect(repo.listViews()[0]?.has_refresh_token).toBe(true);
  });

  it('导入结果与跳过原因中不含任何 Token', () => {
    const repo = createRepo();
    const file = makeAccountsFile([
      { email: 'a@office.example.invalid', accessToken: 'SECRET-ACCESS-TOKEN' },
    ]);
    const summary = importAccountsFromObject(file, repo);
    expect(JSON.stringify(summary)).not.toContain('SECRET-ACCESS-TOKEN');
  });

  it('导入的 Token 在库中是加密的', () => {
    const repo = createRepo();
    importAccountsFromObject(
      makeAccountsFile([
        { email: 'a@office.example.invalid', accessToken: 'PLAINTEXT-ACCESS', refreshToken: 'PLAINTEXT-REFRESH' },
      ]),
      repo,
    );
    const raw = JSON.stringify(db!.prepare('SELECT * FROM account_tokens').all());
    expect(raw).not.toContain('PLAINTEXT-ACCESS');
    expect(raw).not.toContain('PLAINTEXT-REFRESH');
  });

  it('标记来源，便于区分人工授权与外部导入', () => {
    const repo = createRepo();
    importAccountsFromObject(makeAccountsFile([{ email: 'a@office.example.invalid' }]), repo, {
      sourceLabel: 'sync:m365-native',
    });
    expect(repo.listViews()[0]?.source).toBe('sync:m365-native');
  });

  it('格式不正确的文件抛出可读错误', () => {
    const repo = createRepo();
    expect(() => importAccountsFromObject({ accounts: 'not-an-array' }, repo)).toThrow(/格式不正确/);
  });

  it('空账号列表不报错', () => {
    const repo = createRepo();
    const summary = importAccountsFromObject({ accounts: [] }, repo);
    expect(summary.total).toBe(0);
    expect(summary.created).toBe(0);
  });
});

describe('importAccountsFromFile', () => {
  it('从文件导入且不修改源文件', async () => {
    const repo = createRepo();
    tempDir = await mkdtemp(join(tmpdir(), 'm365-codex-test-'));
    const filePath = join(tempDir, 'accounts.json');
    const content = JSON.stringify(
      makeAccountsFile([
        { email: 'foch001@office.example.invalid' },
        { email: 'foch002@office.example.invalid' },
      ]),
      null,
      2,
    );
    await writeFile(filePath, content, 'utf8');

    const summary = await importAccountsFromFile(filePath, repo);
    expect(summary.created).toBe(2);
    expect(summary.source_updated_at).toBe('2026-07-25T08:00:00Z');

    // 源文件必须逐字节不变
    expect(await readFile(filePath, 'utf8')).toBe(content);
  });

  it('文件不存在时给出明确错误', async () => {
    const repo = createRepo();
    await expect(importAccountsFromFile('/不存在/accounts.json', repo)).rejects.toThrow(/无法读取账号文件/);
  });

  it('容忍 UTF-8 BOM——Windows 上的工具常会写入', async () => {
    const repo = createRepo();
    tempDir = await mkdtemp(join(tmpdir(), 'm365-codex-test-'));
    const filePath = join(tempDir, 'bom.json');
    const BOM = String.fromCharCode(0xfeff);
    const content = BOM + JSON.stringify(makeAccountsFile([{ email: 'bom@office.example.invalid' }]));
    await writeFile(filePath, content, 'utf8');

    const summary = await importAccountsFromFile(filePath, repo);
    expect(summary.created).toBe(1);
  });

  it('文件不是合法 JSON 时给出明确错误', async () => {
    const repo = createRepo();
    tempDir = await mkdtemp(join(tmpdir(), 'm365-codex-test-'));
    const filePath = join(tempDir, 'broken.json');
    await writeFile(filePath, '{ 这不是 json', 'utf8');
    await expect(importAccountsFromFile(filePath, repo)).rejects.toThrow(/不是合法 JSON/);
  });
});
