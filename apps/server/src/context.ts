import type { Logger } from 'pino';
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
import { defaultProxyChecker, type ProxyChecker } from './scheduler/proxyHealth.js';
import { AdminSessionRepository } from './repo/adminSessions.js';
import { ApiKeyRepository } from './repo/apiKeys.js';
import { AuditLogRepository } from './repo/auditLogs.js';
import { FileRepository, UploadRepository } from './repo/files.js';
import { OAuthSessionRepository } from './repo/oauthSessions.js';
import { ProxyNodeRepository } from './repo/proxyNodes.js';
import { ResponseRepository } from './repo/responses.js';
import { SettingsRepository } from './repo/settings.js';
import { ToolCallRepository } from './repo/toolCalls.js';
import { FilesService } from './files/service.js';
import { cleanupExpiredFiles, cleanupExpiredUploads } from './files/cleanup.js';
import { FileStorage } from './files/storage.js';
import { IdempotencyStore } from './gateway/idempotency.js';
import { RateLimiter } from './gateway/rateLimit.js';
import { MaintenanceScheduler } from './maintenance/scheduler.js';
import { Metrics } from './observability/metrics.js';
import { InFlightRegistry } from './responses/inFlight.js';
import { ResponsesService } from './responses/service.js';
import { SettingsService } from './settings/service.js';

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
  readonly responses: ResponsesService;
  readonly responseRepo: ResponseRepository;
  readonly toolCalls: ToolCallRepository;
  readonly inFlight: InFlightRegistry;
  readonly fileRepo: FileRepository;
  readonly uploadRepo: UploadRepository;
  readonly fileStorage: FileStorage;
  readonly files: FilesService;
  /** M7：请求幂等（§18），接进 /v1/responses 与 /v1/chat/completions */
  readonly idempotency: IdempotencyStore;
  /** M7：API Key 级限额（§10），进程内计数，单容器前提 */
  readonly rateLimiter: RateLimiter;
  /** M7：出口代理池（§13.1） */
  readonly proxyNodes: ProxyNodeRepository;
  /** M7：代理健康检查，测试可注入假实现 */
  readonly proxyChecker: ProxyChecker;
  /** M7：设置读写（契约 §2.3） */
  readonly settingsRepo: SettingsRepository;
  readonly settings: SettingsService;
  /** M7：定时清理任务调度（§18），已注册好各清理 job，未 start（由 server.ts 决定何时启动） */
  readonly scheduler: MaintenanceScheduler;
  /** 指标注册表；M8 会接 /metrics，这里先在关键路径打点 */
  readonly metrics: Metrics;
  readonly startedAt: number;
}

export interface CreateContextOptions {
  config: AppConfig;
  db: Database;
  logger: Logger;
  startedAt?: number;
  /** 注入模拟上游，集成测试用；不传则走真实 HTTP */
  oauthClient?: OAuthClient;
  /** 注入假的代理健康检查，测试用；不传则走真实 TCP 探测 */
  proxyChecker?: ProxyChecker;
}

export function createContext(options: CreateContextOptions): AppContext {
  const { config, db, logger } = options;
  const cryptor = new Cryptor(config.masterKey, config.masterKeyVersion);

  const accounts = new AccountRepository(db, cryptor);
  const oauthSessions = new OAuthSessionRepository(db, cryptor);
  const proxyNodes = new ProxyNodeRepository(db, cryptor);
  const oauthClient =
    options.oauthClient ??
    new HttpOAuthClient({
      config: config.oauth,
      proxyUrl: config.httpsProxy ?? config.httpProxy,
    });

  // 账号绑定了专属出口代理时（§13.1），Token 刷新与上游长连接都走这一个出口，
  // 保持粘性；节点不存在或被停用时回退到全局默认代理
  const resolveProxyForAccount = (accountId: string): string | null => {
    const account = accounts.findById(accountId);
    if (account?.proxy_node_id == null) return null;
    return proxyNodes.resolveActiveUrl(account.proxy_node_id);
  };

  const tokens = new TokenManager({ accounts, client: oauthClient, logger, resolveProxyForAccount });
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
    resolveProxyForAccount,
  });
  const responseRepo = new ResponseRepository(db);
  const toolCallRepo = new ToolCallRepository(db);
  const fileRepo = new FileRepository(db);
  const uploadRepo = new UploadRepository(db);
  const fileStorage = new FileStorage(config.dataDir);
  const filesService = new FilesService({ files: fileRepo, storage: fileStorage, config: config.files });
  const metrics = new Metrics();
  const responsesService = new ResponsesService({
    dispatcher,
    responses: responseRepo,
    toolCalls: toolCallRepo,
    tools: config.tools,
    logger,
    // M6 新增：input_file 按 file-id 取文本、input_image 按配置决定是否放行
    files: filesService,
    upstreamImageInput: config.upstreamImageInput,
    contextMaxChars: config.contextMaxChars,
    metrics,
  });
  const inFlight = new InFlightRegistry();

  const adminSessions = new AdminSessionRepository(db);
  const auditLogs = new AuditLogRepository(db);
  const settingsRepo = new SettingsRepository(db);
  const idempotency = new IdempotencyStore(db);

  const scheduler = new MaintenanceScheduler(logger);
  registerMaintenanceJobs(scheduler, {
    config,
    accounts,
    oauthSessions,
    adminSessions,
    auditLogs,
    idempotency,
    responseRepo,
    fileRepo,
    uploadRepo,
    fileStorage,
  });

  return {
    config,
    db,
    cryptor,
    logger,
    adminPasswordHash: hashPassword(config.adminPassword),
    apiKeys: new ApiKeyRepository(db),
    adminSessions,
    auditLogs,
    accounts,
    oauthSessions,
    oauthClient,
    oauth: new OAuthService({ config: config.oauth, client: oauthClient, sessions: oauthSessions, accounts }),
    tokens,
    codec,
    pool,
    dispatcher,
    responses: responsesService,
    responseRepo,
    toolCalls: toolCallRepo,
    inFlight,
    fileRepo,
    uploadRepo,
    fileStorage,
    files: filesService,
    idempotency,
    rateLimiter: new RateLimiter(config.rateLimit),
    proxyNodes,
    proxyChecker: options.proxyChecker ?? defaultProxyChecker,
    settingsRepo,
    settings: new SettingsService({ repo: settingsRepo, config, logger }),
    scheduler,
    metrics,
    startedAt: options.startedAt ?? Date.now(),
  };
}

/**
 * 注册全部定时清理任务（对应实施计划 §18）。只注册、不 start——是否启动定时器
 * 由 `server.ts` 决定（测试用 `createContext` 时不希望后台定时器悄悄跑起来）。
 */
function registerMaintenanceJobs(
  scheduler: MaintenanceScheduler,
  deps: {
    config: AppConfig;
    accounts: AccountRepository;
    oauthSessions: OAuthSessionRepository;
    adminSessions: AdminSessionRepository;
    auditLogs: AuditLogRepository;
    idempotency: IdempotencyStore;
    responseRepo: ResponseRepository;
    fileRepo: FileRepository;
    uploadRepo: UploadRepository;
    fileStorage: FileStorage;
  },
): void {
  const interval = deps.config.cleanup.intervalMs;

  scheduler.register({
    name: 'oauth_sessions_cleanup',
    intervalMs: interval,
    run: () => deps.oauthSessions.purge(),
  });
  scheduler.register({
    name: 'admin_sessions_cleanup',
    intervalMs: interval,
    run: () => deps.adminSessions.purgeExpired(),
  });
  scheduler.register({
    name: 'files_cleanup',
    intervalMs: interval,
    run: () =>
      cleanupExpiredFiles({ files: deps.fileRepo, uploads: deps.uploadRepo, storage: deps.fileStorage }),
  });
  scheduler.register({
    name: 'uploads_cleanup',
    intervalMs: interval,
    run: () =>
      cleanupExpiredUploads({ files: deps.fileRepo, uploads: deps.uploadRepo, storage: deps.fileStorage }),
  });
  scheduler.register({
    name: 'responses_cleanup',
    intervalMs: interval,
    // 级联删除 tool_calls 与 conversation_bindings（外键 ON DELETE CASCADE），
    // 因此“过期 Response”与“超期请求记录”是同一件事，不必再拆一个任务
    run: () => deps.responseRepo.purgeFinishedOlderThan(Date.now() - deps.config.cleanup.responseRetentionMs),
  });
  scheduler.register({
    name: 'stale_conversation_bindings_cleanup',
    intervalMs: interval,
    run: () => deps.responseRepo.purgeStaleBindings(),
  });
  scheduler.register({
    name: 'audit_logs_cleanup',
    intervalMs: interval,
    run: () => deps.auditLogs.purgeOlderThan(Date.now() - deps.config.cleanup.auditLogRetentionMs),
  });
  scheduler.register({
    name: 'idempotency_keys_cleanup',
    intervalMs: interval,
    run: () => deps.idempotency.purgeOlderThan(Date.now() - deps.config.cleanup.idempotencyRetentionMs),
  });
}
