import type { HealthResponse, ReadinessCheck, ReadinessResponse } from '@m365-codex/shared';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { CryptoError } from '../crypto/index.js';
import { checkWritable, currentSchemaVersion, LATEST_SCHEMA_VERSION } from '../db/index.js';
import { APP_VERSION } from '../version.js';

/**
 * 存活与就绪探针。
 *
 * - `/healthz`：进程是否活着，永远轻量，不碰数据库；
 * - `/readyz`：能否真正提供服务——主密钥可用、迁移到位、数据库可写。
 *   任何一项不通过返回 503，容器编排据此不放流量进来。
 */

export function evaluateReadiness(context: AppContext): ReadinessResponse {
  const checks: ReadinessCheck[] = [];

  // 1) 主密钥：做一次真实的加解密往返，而不是只看长度
  try {
    const probe = context.cryptor.seal('readiness-probe', 'readyz');
    const restored = context.cryptor.open(probe, 'readyz');
    checks.push({
      name: 'master_key',
      ok: restored === 'readiness-probe',
      detail: restored === 'readiness-probe' ? '主密钥可用（AES-256-GCM 往返成功）' : '主密钥往返结果不一致',
    });
  } catch (error) {
    const message = error instanceof CryptoError ? error.message : String(error);
    checks.push({ name: 'master_key', ok: false, detail: `主密钥不可用：${message}` });
  }

  // 2) 数据库迁移版本
  let schemaVersion = 0;
  try {
    schemaVersion = currentSchemaVersion(context.db);
    const ok = schemaVersion === LATEST_SCHEMA_VERSION;
    checks.push({
      name: 'schema_migrations',
      ok,
      detail: ok
        ? `迁移已是最新（v${schemaVersion}）`
        : `迁移版本不匹配：当前 v${schemaVersion}，期望 v${LATEST_SCHEMA_VERSION}`,
    });
  } catch (error) {
    checks.push({
      name: 'schema_migrations',
      ok: false,
      detail: `无法读取迁移版本：${(error as Error).message}`,
    });
  }

  // 3) 数据库可写
  const writable = checkWritable(context.db);
  checks.push({ name: 'database_writable', ok: writable.ok, detail: writable.detail });

  return {
    status: checks.every((check) => check.ok) ? 'ready' : 'not_ready',
    version: APP_VERSION,
    schema_version: schemaVersion,
    checks,
  };
}

export function registerHealthRoutes(app: FastifyInstance, context: AppContext): void {
  app.get('/healthz', async (): Promise<HealthResponse> => {
    return {
      status: 'ok',
      version: APP_VERSION,
      uptime_ms: Date.now() - context.startedAt,
    };
  });

  app.get('/readyz', async (_request, reply) => {
    const result = evaluateReadiness(context);
    reply.code(result.status === 'ready' ? 200 : 503);
    return result;
  });
}
