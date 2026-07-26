import { buildApp } from './app.js';
import { ConfigError, loadConfig, summarizeConfig } from './config/index.js';
import { createContext } from './context.js';
import { openDatabase, resolveDatabasePath, runMigrations } from './db/index.js';
import { createLogger } from './observability/logger.js';
import { evaluateReadiness } from './routes/health.js';
import { APP_VERSION } from './version.js';

/**
 * 进程入口：加载配置 → 打开数据库 → 执行迁移 → 启动 HTTP 服务。
 * 收到 SIGTERM/SIGINT 时优雅退出，先停止接收新请求再关闭数据库。
 */

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`\n[M365-Codex] 启动失败：\n${error.message}\n\n请参考 .env.example 补全配置。\n`);
      process.exit(78); // EX_CONFIG
    }
    throw error;
  }

  const logger = createLogger({
    level: config.logLevel,
    privacyMode: config.logPrivacyMode,
    pretty: process.env.NODE_ENV === 'development',
  });

  logger.info({ version: APP_VERSION, config: summarizeConfig(config) }, 'M365-Codex 启动中');

  const db = openDatabase(resolveDatabasePath(config.dataDir));
  const migration = runMigrations(db);
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

  const app = buildApp(context);

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, '收到退出信号，开始优雅关闭');
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
