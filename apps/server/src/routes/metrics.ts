import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { createAdminGuard } from '../gateway/auth.js';
import { CONTENT_TYPE_PROMETHEUS } from '../observability/metrics.js';

/**
 * `GET /metrics`（对应实施计划 §17、契约 §三）。
 *
 * 两个开关都走配置：
 * - `METRICS_ENABLED`（默认开）：关闭时整个端点当作不存在，返回 404，
 *   不透出「这个功能被禁用了」这类信息本身；
 * - `METRICS_REQUIRE_AUTH`（默认开）：指标会暴露账号数量与错误分布，
 *   默认要求管理会话；显式关闭才允许无鉴权抓取（放行给内网 Prometheus）。
 *
 * 抓取时才计算的即时值（gauge）在这里现填，而不是常驻更新——账号数、
 * 在途请求数、数据库与文件占用都是「查询时的快照」，没必要在每次状态变化时
 * 都重新计算一遍。
 */
export function registerMetricsRoutes(app: FastifyInstance, context: AppContext): void {
  if (!context.config.metrics.enabled) return;

  const adminGuard = createAdminGuard(context);

  app.get('/metrics', { preHandler: context.config.metrics.requireAuth ? adminGuard : undefined }, async (_request, reply) => {
    fillGauges(context);
    reply.header('content-type', CONTENT_TYPE_PROMETHEUS);
    return context.metrics.render();
  });
}

/** 账号状态本身是有限枚举，作为标签值安全；不含任何账号标识。 */
function fillGauges(context: AppContext): void {
  const accounts = context.accounts.listViews();
  const byStatus = new Map<string, number>();
  for (const account of accounts) {
    byStatus.set(account.status, (byStatus.get(account.status) ?? 0) + 1);
  }
  for (const [status, count] of byStatus) {
    context.metrics.setGauge('m365codex_accounts', '各状态账号数', count, { status });
  }

  context.metrics.setGauge('m365codex_requests_in_flight', '当前在途请求数', context.inFlight.size);

  const usage = context.backup.usage();
  context.metrics.setGauge('m365codex_db_bytes', 'SQLite 数据库文件占用字节数', usage.dbBytes);
  context.metrics.setGauge('m365codex_files_bytes', '已上传文件占用字节数', usage.filesBytes);
  context.metrics.setGauge('m365codex_files_count', '已上传文件数量', usage.fileCount);
}
