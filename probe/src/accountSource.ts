import { Buffer } from 'node:buffer';
import type { Logger } from 'pino';
import { openDatabase, runMigrations, type Database } from '../../apps/server/dist/db/index.js';
import { Cryptor } from '../../apps/server/dist/crypto/index.js';
import { AccountRepository, type AccountView } from '../../apps/server/dist/repo/accounts.js';
import { HttpOAuthClient } from '../../apps/server/dist/oauth/client.js';
import { TokenManager } from '../../apps/server/dist/oauth/tokenManager.js';
import {
  DEFAULT_OAUTH_AUTHORIZE_URL,
  DEFAULT_OAUTH_CLIENT_ID,
  DEFAULT_OAUTH_REDIRECT_URI,
  DEFAULT_OAUTH_SCOPES,
  DEFAULT_OAUTH_TOKEN_URL,
  type OAuthConfig,
} from '../../apps/server/dist/config/index.js';

/**
 * 账号来源：网关自己的 SQLite 数据库（对应实施计划 §3.2「探针从现有授权账号读取
 * Token」）。账号只能经 PKCE 授权流程添加，探针不做任何登录，只读已有账号。
 *
 * 铁律：Token 解密后只在内存里传递给 WebSocket URL 构造函数，探针任何一层都
 * 不得把它写进文件、日志或返回值以外的地方。
 */

export interface OpenAccountDbOptions {
  dbPath: string;
  masterKeyBase64: string;
  masterKeyVersion: number;
  oauth?: Partial<OAuthConfig>;
  logger: Logger;
}

export interface AccountSource {
  db: Database;
  accounts: AccountRepository;
  tokenManager: TokenManager;
  oauthClient: HttpOAuthClient;
  close: () => void;
}

function parseMasterKey(raw: string): Buffer {
  const decoded = Buffer.from(raw.trim(), 'base64');
  if (decoded.byteLength !== 32) {
    throw new Error(`M365_CODEX_MASTER_KEY 解码后为 ${decoded.byteLength} 字节，要求正好 32 字节`);
  }
  return decoded;
}

/** 打开账号数据库并准备好读取/刷新 Token 所需的组件。不做 schema 之外的任何改动。 */
export function openAccountSource(options: OpenAccountDbOptions): AccountSource {
  const masterKey = parseMasterKey(options.masterKeyBase64);
  const db = openDatabase(options.dbPath);
  runMigrations(db);

  const cryptor = new Cryptor(masterKey, options.masterKeyVersion);
  const accounts = new AccountRepository(db, cryptor);

  const oauthConfig: OAuthConfig = {
    clientId: options.oauth?.clientId ?? DEFAULT_OAUTH_CLIENT_ID,
    redirectUri: options.oauth?.redirectUri ?? DEFAULT_OAUTH_REDIRECT_URI,
    authorizeUrl: options.oauth?.authorizeUrl ?? DEFAULT_OAUTH_AUTHORIZE_URL,
    tokenUrl: options.oauth?.tokenUrl ?? DEFAULT_OAUTH_TOKEN_URL,
    scopes: options.oauth?.scopes ?? DEFAULT_OAUTH_SCOPES,
  };
  const oauthClient = new HttpOAuthClient({ config: oauthConfig });
  const tokenManager = new TokenManager({ accounts, client: oauthClient, logger: options.logger });

  return {
    db,
    accounts,
    tokenManager,
    oauthClient,
    close: () => db.close(),
  };
}

/** 列出可选账号（供 CLI 不带 `--account`/`--all` 时展示）。绝不包含 Token。 */
export function listAccountsForDisplay(accounts: AccountRepository): AccountView[] {
  return accounts.listViews();
}
