import type { Logger } from 'pino';
import type { AppConfig } from './config/index.js';
import { Cryptor } from './crypto/index.js';
import { hashPassword } from './crypto/password.js';
import type { Database } from './db/index.js';
import { AdminSessionRepository } from './repo/adminSessions.js';
import { ApiKeyRepository } from './repo/apiKeys.js';
import { AuditLogRepository } from './repo/auditLogs.js';

/**
 * 运行时上下文：把配置、数据库、加密器、日志与各数据访问层集中传递，
 * 便于测试时注入内存数据库与静默日志。
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
  readonly startedAt: number;
}

export interface CreateContextOptions {
  config: AppConfig;
  db: Database;
  logger: Logger;
  startedAt?: number;
}

export function createContext(options: CreateContextOptions): AppContext {
  const { config, db, logger } = options;
  return {
    config,
    db,
    cryptor: new Cryptor(config.masterKey, config.masterKeyVersion),
    logger,
    adminPasswordHash: hashPassword(config.adminPassword),
    apiKeys: new ApiKeyRepository(db),
    adminSessions: new AdminSessionRepository(db),
    auditLogs: new AuditLogRepository(db),
    startedAt: options.startedAt ?? Date.now(),
  };
}
