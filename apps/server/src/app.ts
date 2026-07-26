import { randomBytes } from 'node:crypto';
import { ApiError, buildErrorBody, REQUEST_ID_HEADER } from '@m365-codex/shared';
import multipart from '@fastify/multipart';
import Fastify, { LogController, type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import type { AppContext } from './context.js';
import { registerAccountRoutes } from './routes/accounts.js';
import { registerAdminRoutes } from './routes/admin.js';
import { registerChatRoutes } from './routes/chat.js';
import { registerFileRoutes } from './routes/files.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerUiRoutes } from './routes/ui.js';
import { registerV1Routes } from './routes/v1.js';

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

  /*
   * 若干管理端点（登出、生成授权链接、手动触发同步）本来就不需要请求体，
   * 但不少 HTTP 客户端在 POST 时会自作主张带上 Content-Type——例如 PowerShell 的
   * Invoke-RestMethod 默认发 application/x-www-form-urlencoded。Fastify 找不到
   * 对应解析器就会直接回 415，对调用方很莫名其妙。
   *
   * 这里兜底：无法识别的 Content-Type 下，空请求体按「没有请求体」处理，
   * 非空才拒绝，并且用本项目的统一错误体回复。
   */
  app.addContentTypeParser('*', { parseAs: 'buffer' }, (_request, body: Buffer, done) => {
    if (body.length === 0) {
      done(null, undefined);
      return;
    }
    // Fastify 会给解析器抛出的错误补默认 statusCode，这里显式带上 415，
    // 让它走下面错误处理器的 4xx 分支，输出统一错误体
    const error = Object.assign(
      new Error('不支持的 Content-Type，请求体请使用 application/json'),
      { statusCode: 415 },
    );
    done(error, undefined);
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

  // Files/Uploads 用 multipart/form-data；attachFieldsToBody 让文件字段以
  // 缓冲区形式挂在 request.body 上，同时保留其它文本字段，路由里统一处理。
  // 单文件大小上限走配置，具体路由再各自设置更贴合场景的 bodyLimit。
  void app.register(multipart, {
    attachFieldsToBody: true,
    limits: { fileSize: context.config.files.maxFileBytes + 1, files: 1 },
  });

  registerHealthRoutes(app, context);
  registerAdminRoutes(app, context);
  registerAccountRoutes(app, context);
  registerV1Routes(app, context);
  registerFileRoutes(app, context);
  registerChatRoutes(app, context);
  // 放在最后注册：/ui/* 是通配路由，前面那些显式路由要先匹配
  registerUiRoutes(app);

  return app;
}
