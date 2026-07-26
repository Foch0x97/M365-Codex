import type { Buffer } from 'node:buffer';
import { ApiError, type AccountStatus } from '@m365-codex/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppContext } from '../context.js';
import { summarizeConfig } from '../config/index.js';
import { createAdminGuard } from '../gateway/auth.js';
import { currentSchemaVersion, LATEST_SCHEMA_VERSION } from '../db/index.js';
import { buildDiagnostics } from '../observability/diagnostics.js';
import { evaluateReadiness } from './health.js';
import { APP_VERSION } from '../version.js';

/**
 * 备份 / 恢复 / 诊断（对应实施计划 §15.4、§17，契约 §三）。
 */

interface MultipartFileField {
  type: 'file';
  filename: string;
  mimetype: string;
  toBuffer: () => Promise<Buffer>;
}
type MultipartBody = Record<string, MultipartFileField | { type: 'field'; value: unknown } | undefined>;

function requireUploadedFile(request: FastifyRequest): MultipartFileField {
  if (!request.isMultipart()) {
    throw ApiError.badRequest('请求必须是 multipart/form-data，字段名为 file');
  }
  const body = (request.body ?? {}) as MultipartBody;
  const field = body.file;
  if (field === undefined || field.type !== 'file') {
    throw ApiError.badRequest('缺少文件字段 file', 'file');
  }
  return field;
}

export function registerBackupRoutes(app: FastifyInstance, context: AppContext): void {
  const adminGuard = createAdminGuard(context);

  // -----------------------------------------------------------------------
  // 备份
  // -----------------------------------------------------------------------
  app.post('/admin/backup', { preHandler: adminGuard }, async (_request, reply) => {
    const { archive } = context.backup.create();
    const saved = context.backupStore.save(archive);
    context.auditLogs.record({ actor: 'admin', action: 'backup.create', target: saved.id, detail: { bytes: saved.bytes } });
    reply.code(201);
    return saved;
  });

  app.get('/admin/backup', { preHandler: adminGuard }, async () => {
    return { items: context.backupStore.list() };
  });

  app.get<{ Params: { id: string } }>(
    '/admin/backup/:id/download',
    { preHandler: adminGuard },
    async (request, reply) => {
      const content = context.backupStore.read(request.params.id);
      if (content === undefined) throw ApiError.notFound('备份包不存在');
      reply.header('content-type', 'application/gzip');
      reply.header('content-disposition', `attachment; filename="${request.params.id}.tar.gz"`);
      return reply.send(content);
    },
  );

  // -----------------------------------------------------------------------
  // 恢复：写盘校验通过即完成，但**必须重启进程才生效**——正在运行的连接
  // 还握着旧数据库，这里绝不假装恢复已经对当前进程生效
  // -----------------------------------------------------------------------
  app.post(
    '/admin/restore',
    { preHandler: adminGuard, bodyLimit: 512 * 1024 * 1024 },
    async (request) => {
      const field = requireUploadedFile(request);
      const content = await field.toBuffer();
      const manifest = context.backup.restore(content);
      context.auditLogs.record({
        actor: 'admin',
        action: 'restore.apply',
        detail: { schema_version: manifest.schema_version, file_count: manifest.file_count },
      });
      return {
        restored: true,
        requires_restart: true,
        message: '备份已校验并写入数据目录，需重启服务后才会生效',
        manifest,
      };
    },
  );

  // -----------------------------------------------------------------------
  // 诊断包
  // -----------------------------------------------------------------------
  app.get('/admin/diagnostics', { preHandler: adminGuard }, async () => {
    const accounts = context.accounts.listViews();
    const accountsByStatus: Record<AccountStatus, number> = {
      probing: 0,
      online: 0,
      busy: 0,
      cooldown: 0,
      reauth_required: 0,
      disabled: 0,
      unsupported: 0,
      error: 0,
    };
    for (const account of accounts) {
      accountsByStatus[account.status] += 1;
    }

    const readiness = evaluateReadiness(context);
    const usage = context.backup.usage();
    const maintenanceJobs = context.scheduler.statuses().map((job) => ({
      name: job.name,
      lastRunAt: job.lastRunAt,
      lastError: job.lastError,
    }));

    const report = buildDiagnostics({
      appVersion: APP_VERSION,
      schemaVersion: currentSchemaVersion(context.db),
      expectedSchemaVersion: LATEST_SCHEMA_VERSION,
      startedAt: context.startedAt,
      now: Date.now(),
      accountsByStatus,
      // 进程生命周期内的累计计数（重启归零），与 /admin/overview 的
      // arg_pass_rate 是同一种「够用但不是历史精确值」的取舍
      recentErrorsByType: context.metrics.upstreamErrors.sumByLabel('disposition'),
      inFlightRequests: context.inFlight.size,
      configSummary: summarizeConfig(context.config),
      storage: { dbBytes: usage.dbBytes, filesBytes: usage.filesBytes, fileCount: usage.fileCount },
      maintenanceJobs,
      readiness: readiness.checks.map((check) => ({ name: check.name, ok: check.ok })),
    });
    return report;
  });
}
