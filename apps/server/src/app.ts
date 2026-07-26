import { randomBytes } from 'node:crypto';
import { ApiError, buildErrorBody, REQUEST_ID_HEADER } from '@m365-codex/shared';
import Fastify, { LogController, type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import type { AppContext } from './context.js';
import { registerAdminRoutes } from './routes/admin.js';
import { registerHealthRoutes } from './routes/health.js';

/** 组装 Fastify 应用。测试通过 `app.inject()` 直接调用，无需真实监听端口。 */

export interface BuildAppOptions {
  /** 请求体大小上限，默认 8 MiB */
  bodyLimit?: number;
}

function generateRequestId(): string {
  return `req_${randomBytes(12).toString('hex')}`;
}

export function buildApp(context: AppContext, options: BuildAppOptions = {}): FastifyInstance {
  const logger: FastifyBaseLogger = context.logger;
  const app = Fastify({
    // 声明为 FastifyBaseLogger，让实例类型保持默认泛型，
    // 否则各 route 注册函数的 FastifyInstance 参数会因日志泛型不同而不兼容
    loggerInstance: logger,
    trustProxy: context.config.trustProxy,
    genReqId: generateRequestId,
    bodyLimit: options.bodyLimit ?? 8 * 1024 * 1024,
    // strict 隐私模式下关闭逐请求访问日志，避免 URL、查询串被落盘
    logController: new LogController({
      disableRequestLogging: context.config.logPrivacyMode === 'strict',
    }),
  });

  // 请求 ID 贯穿响应头与错误体，便于用户报障时定位
  app.addHook('onRequest', async (request, reply) => {
    reply.header(REQUEST_ID_HEADER, request.id);
  });

  app.setErrorHandler<Error & { statusCode?: number }>((error, request, reply) => {
    const requestId = String(request.id);

    if (error instanceof ApiError) {
      request.log.warn(
        { err_type: error.type, status: error.status, details: error.details },
        '请求被拒绝',
      );
      reply.code(error.status).send(error.toBody(requestId));
      return;
    }

    // Fastify 内建错误：JSON 解析失败、请求体过大、路由校验失败等
    const statusCode = typeof error.statusCode === 'number' ? error.statusCode : 500;
    if (statusCode >= 400 && statusCode < 500) {
      reply
        .code(statusCode)
        .send(
          buildErrorBody('invalid_request_error', statusCode, error.message, { requestId }),
        );
      return;
    }

    // 未预期错误：日志留完整栈，响应只给通用信息，避免泄露内部细节
    request.log.error({ err: error }, '未处理的服务端错误');
    reply
      .code(500)
      .send(buildErrorBody('internal_error', 500, 'Internal server error', { requestId }));
  });

  app.setNotFoundHandler((request, reply) => {
    reply
      .code(404)
      .send(
        buildErrorBody('not_found_error', 404, `未找到路由 ${request.method} ${request.url}`, {
          requestId: String(request.id),
        }),
      );
  });

  registerHealthRoutes(app, context);
  registerAdminRoutes(app, context);

  return app;
}
