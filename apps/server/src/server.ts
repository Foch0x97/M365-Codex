import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import type { Logger } from 'pino';
import { buildApp } from './app.js';
import { ConfigError, loadConfig, summarizeConfig, type AppConfig } from './config/index.js';
import { createContext, type AppContext } from './context.js';
import { openDatabase, resolveDatabasePath, runMigrations, type Database } from './db/index.js';
import { markInProgressAsIncomplete, recoverOnStartup, SHUTDOWN_INCOMPLETE_REASON } from './maintenance/recovery.js';
import { createLogger } from './observability/logger.js';
import { evaluateReadiness } from './routes/health.js';
import { SettingsRepository } from './repo/settings.js';
import { buildEnvOverridesFromSettings } from './settings/service.js';
import { APP_VERSION } from './version.js';

/**
 * 进程入口：加载配置 → 打开数据库 → 执行迁移 → 启动 HTTP 服务。
 * 收到 SIGTERM/SIGINT 时优雅退出，先停止接收新请求再关闭数据库。
 */

/** 首次按纯环境变量加载配置——只为了拿到 dataDir/masterKey 等，打开数据库。 */
function loadConfigOrExit(env: NodeJS.ProcessEnv): AppConfig {
  try {
    return loadConfig(env);
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`\n[M365-Codex] 启动失败：\n${error.message}\n\n请参考 .env.example 补全配置。\n`);
      process.exit(78); // EX_CONFIG
    }
    throw error;
  }
}

/**
 * 把 `settings` 表里「需要重启才生效」的历史改动（§M7、契约 §2.3）合成一层
 * env 覆盖，重新走一遍 `loadConfig`，让上一次通过 `/admin/settings` 保存的配置
 * 在这次启动时真正生效。环境变量本身显式设置过的项不会被覆盖。
 */
function reloadConfigWithSettings(db: Database, initialConfig: AppConfig): AppConfig {
  const overrides = buildEnvOverridesFromSettings(new SettingsRepository(db), initialConfig.envKeysPresent);
  if (Object.keys(overrides).length === 0) return initialConfig;
  return loadConfigOrExit({ ...process.env, ...overrides });
}

export interface ShutdownDeps {
  context: AppContext;
  app: FastifyInstance;
  db: Database;
  logger: Logger;
}

/**
 * 优雅关闭（对应实施计划 §19）。
 *
 * 此前这里只是「停调度器 → app.close() → db.close()」：没有主动处理在途
 * 请求——`InFlightRegistry` 里的上游连接不会被中止，仍处于 `in_progress`
 * 的 Response 只能指望**下次启动**时 `recovery.ts` 的兜底；一旦排空超时被
 * SIGKILL，这次兜底永远不会发生，数据库里会留下永久卡死的 in_progress 行。
 *
 * 处置顺序：
 * 1. 停止定时任务调度；
 * 2. 中止全部在途请求的 `AbortController`——促使上游 WebSocket / dispatch
 *    循环尽快收尾。`responses/service.ts` 会识别出这是关闭触发的中止
 *    （`SHUTDOWN_ABORT_REASON`），自己不再落库，把写状态的职责完全交给这里，
 *    避免两处并发写同一行、产生竞争或两套不一致的终态语义；
 * 3. 把仍处于 `in_progress` 的 Response 落库为 `incomplete`——处置逻辑
 *    直接复用 `maintenance/recovery.ts` 给重启恢复用的同一个函数，只是
 *    `reason` 换成 `SHUTDOWN_INCOMPLETE_REASON`，不是另一套语义；
 * 4. 等 Fastify 排空/关闭 HTTP 连接；
 * 5. 关闭数据库。
 *
 * 绝不自动重放任何有副作用的操作：已发出的工具调用原样保留、仍可查询，
 * 这里不做任何补偿性动作。
 */
export async function gracefulShutdown(deps: ShutdownDeps, signal: string): Promise<void> {
  const { context, app, db, logger } = deps;
  logger.info({ signal }, '收到退出信号，开始优雅关闭');

  context.scheduler.stop();

  const abortedIds = context.inFlight.cancelAll();
  const markedIncomplete = markInProgressAsIncomplete(context.responseRepo, SHUTDOWN_INCOMPLETE_REASON);
  if (abortedIds.length > 0 || markedIncomplete.length > 0) {
    logger.info(
      { aborted: abortedIds.length, marked_incomplete: markedIncomplete.length },
      '已中止在途请求的上游连接，并将仍处于 in_progress 的记录落库为 incomplete',
    );
  }

  await app.close();
  db.close();
  logger.info('已完成优雅关闭');
}

async function main(): Promise<void> {
  const bootConfig = loadConfigOrExit(process.env);

  const db = openDatabase(resolveDatabasePath(bootConfig.dataDir));
  const migration = runMigrations(db);

  // 迁移跑完、settings 表可读之后，才能把上次保存的设置合并进配置
  const config = reloadConfigWithSettings(db, bootConfig);

  const logger = createLogger({
    level: config.logLevel,
    privacyMode: config.logPrivacyMode,
    pretty: process.env.NODE_ENV === 'development',
  });

  logger.info({ version: APP_VERSION, config: summarizeConfig(config) }, 'M365-Codex 启动中');
  if (migration.applied.length > 0) {
    logger.info({ applied: migration.applied, schema_version: migration.schemaVersion }, '数据库迁移完成');
  }

  const context = createContext({ config, db, logger });

  const readiness = evaluateReadiness(context);
  if (readiness.status !== 'ready') {
    logger.fatal({ checks: readiness.checks }, '就绪检查未通过，拒绝启动');
    db.close();
    process.exit(78);
  }

  // 重启恢复（§18）：queued 保持原状可查询；无法确认进度的 in_progress 标记为
  // incomplete，绝不自动重放任何有副作用的操作
  const recovery = recoverOnStartup({ responses: context.responseRepo, logger });
  if (recovery.inProgressMarkedIncomplete > 0 || recovery.queuedKept > 0) {
    logger.info({ recovery }, '重启恢复完成');
  }

  const app = buildApp(context);
  context.scheduler.start();

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    void gracefulShutdown({ context, app, db, logger }, signal)
      .then(() => process.exit(0))
      .catch((error: unknown) => {
        logger.error({ err: error }, '优雅关闭失败');
        process.exit(1);
      });
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  await app.listen({ host: '0.0.0.0', port: config.port });
  logger.info({ port: config.port }, 'M365-Codex 已就绪');
}

/**
 * 只有直接执行本文件（`node dist/server.js` / `tsx src/server.ts`）才跑
 * `main()`；被测试用例 `import` 只为了拿 `gracefulShutdown` 之类的导出时，
 * 不能顺带把整个进程入口跑起来——否则测试环境缺的 `.env` 配置会导致
 * `main()` 里的 `loadConfigOrExit` 直接 `process.exit`，把测试进程带走。
 */
const isMainModule = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (isMainModule) {
  main().catch((error: unknown) => {
    process.stderr.write(`[M365-Codex] 启动异常：${String(error)}\n`);
    process.exit(1);
  });
}
