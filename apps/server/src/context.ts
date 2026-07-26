import type { Logger } from 'pino';
import { ExternalAccountSync } from './accounts/externalSync.js';
import type { AppConfig } from './config/index.js';
import { Cryptor } from './crypto/index.js';
import { hashPassword } from './crypto/password.js';
import type { Database } from './db/index.js';
import { selectCodec } from './adapter/codecV1.js';
import type { ProtocolCodec } from './adapter/protocol.js';
import { HttpOAuthClient, type OAuthClient } from './oauth/client.js';
import { OAuthService } from './oauth/service.js';
import { TokenManager } from './oauth/tokenManager.js';
import { AccountRepository } from './repo/accounts.js';
import { AccountPool } from './scheduler/accountPool.js';
import { UpstreamDispatcher } from './scheduler/dispatcher.js';
import { AdminSessionRepository } from './repo/adminSessions.js';
import { ApiKeyRepository } from './repo/apiKeys.js';
import { AuditLogRepository } from './repo/auditLogs.js';
import { OAuthSessionRepository } from './repo/oauthSessions.js';

/**
 * 运行时上下文：把配置、数据库、加密器、日志与各服务集中传递，
 * 便于测试时注入内存数据库、静默日志与模拟上游。
 */
export interface AppContext {
  readonly config: AppConfig;
  readonly db: Database;
  readonly cryptor: Cryptor;
  readonly logger: Logger;
  readonly adminPasswordHash: string;
  readonly apiKeys: ApiKeyRepository;
  readonly adminSessions: AdminSessionRepository;
  readonly auditLogs: AuditLogRepository;
  readonly accounts: AccountRepository;
  readonly oauthSessions: OAuthSessionRepository;
  readonly oauthClient: OAuthClient;
  readonly oauth: OAuthService;
  readonly tokens: TokenManager;
  readonly codec: ProtocolCodec;
  readonly pool: AccountPool;
  readonly dispatcher: UpstreamDispatcher;
  /** 仅在配置了 EXTERNAL_ACCOUNTS_FILE 时创建 */
  readonly externalSync: ExternalAccountSync | null;
  readonly startedAt: number;
}

export interface CreateContextOptions {
  config: AppConfig;
  db: Database;
  logger: Logger;
  startedAt?: number;
  /** 注入模拟上游，集成测试用；不传则走真实 HTTP */
  oauthClient?: OAuthClient;
}

export function createContext(options: CreateContextOptions): AppContext {
  const { config, db, logger } = options;
  const cryptor = new Cryptor(config.masterKey, config.masterKeyVersion);

  const accounts = new AccountRepository(db, cryptor);
  const oauthSessions = new OAuthSessionRepository(db, cryptor);
  const oauthClient =
    options.oauthClient ??
    new HttpOAuthClient({
      config: config.oauth,
      proxyUrl: config.httpsProxy ?? config.httpProxy,
    });

  const tokens = new TokenManager({ accounts, client: oauthClient, logger });
  const codec = selectCodec(config.upstream.protocolVersion);
  const pool = new AccountPool(accounts);
  const dispatcher = new UpstreamDispatcher({
    config: config.upstream,
    codec,
    accounts,
    pool,
    tokens,
    logger,
    proxyUrl: config.httpsProxy ?? config.httpProxy,
  });

  return {
    config,
    db,
    cryptor,
    logger,
    adminPasswordHash: hashPassword(config.adminPassword),
    apiKeys: new ApiKeyRepository(db),
    adminSessions: new AdminSessionRepository(db),
    auditLogs: new AuditLogRepository(db),
    accounts,
    oauthSessions,
    oauthClient,
    oauth: new OAuthService({ config: config.oauth, client: oauthClient, sessions: oauthSessions, accounts }),
    tokens,
    codec,
    pool,
    dispatcher,
    externalSync:
      config.externalAccountsFile === null
        ? null
        : new ExternalAccountSync({
            filePath: config.externalAccountsFile,
            accounts,
            logger,
            intervalMs: config.externalAccountsSyncIntervalMs,
          }),
    startedAt: options.startedAt ?? Date.now(),
  };
}
