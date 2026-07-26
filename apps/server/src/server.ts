import { buildApp } from './app.js';
import { ConfigError, loadConfig, summarizeConfig, type AppConfig } from './config/index.js';
import { createContext } from './context.js';
import { openDatabase, resolveDatabasePath, runMigrations, type Database } from './db/index.js';
import { recoverOnStartup } from './maintenance/recovery.js';
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
    logger.info({ signal }, '收到退出信号，开始优雅关闭');
    context.scheduler.stop();
    void app
      .close()
      .then(() => {
        db.close();
        logger.info('已完成优雅关闭');
        process.exit(0);
      })
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

main().catch((error: unknown) => {
  process.stderr.write(`[M365-Codex] 启动异常：${String(error)}\n`);
  process.exit(1);
});
