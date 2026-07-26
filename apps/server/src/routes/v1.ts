import { ApiError, REQUEST_ID_HEADER } from '@m365-codex/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from '../context.js';
import { createApiKeyGuard } from '../gateway/auth.js';
import { beginIdempotency } from '../gateway/idempotency.js';
import { loadModels } from '../responses/models.js';
import { parseResponsesRequest } from '../responses/schema.js';
import { serializeSse, type SseEvent } from '../responses/types.js';

/**
 * 对外 `/v1/*` 兼容接口（对应实施计划 §4.1）。
 * 全部走 API Key 鉴权。Responses 支持非流式与 SSE 流式。
 */

export function registerV1Routes(app: FastifyInstance, context: AppContext): void {
  const apiKeyGuard = createApiKeyGuard(context);
  const models = loadModels();

  app.get('/v1/models', { preHandler: apiKeyGuard }, async () => models);

  app.post('/v1/responses', { preHandler: apiKeyGuard }, async (request, reply) => {
    const body = parseResponsesRequest(request.body);
    const apiKeyId = request.apiKeyRow?.id ?? null;
    const idempotencyKey = headerValue(request, 'idempotency-key');

    const idem = beginIdempotency({
      store: context.idempotency,
      key: idempotencyKey,
      apiKeyId,
      endpoint: 'POST /v1/responses',
      rawBody: request.body,
      stream: body.stream === true,
    });
    if (idem.replay !== undefined) {
      reply.code(idem.replay.statusCode);
      return idem.replay.body;
    }

    try {
      // 客户端断开 → 取消上游
      const controller = new AbortController();
      const execution = context.responses.create({
        request: body,
        apiKeyId,
        signal: controller.signal,
        idempotencyKey,
      });
      context.inFlight.register(execution.responseId, controller);

      // 声明了但执行不了的工具（如 OpenAI 托管的 web_search）不静默丢弃：
      // 在这里回一个响应头，调用方能立刻看见自己有哪些工具不会生效
      if (execution.skippedTools.length > 0) {
        void reply.header('x-m365-codex-skipped-tools', execution.skippedTools.join(','));
      }

      const onClose = (): void => controller.abort();
      reply.raw.on('close', onClose);

      try {
        if (body.stream) {
          const streamed = await streamResponse(reply, execution.stream);
          idem.handle?.complete(0, null, null);
          return streamed;
        }
        // 非流式：把事件流跑干（驱动上游），再返回最终对象
        for await (const _event of execution.stream) {
          void _event;
        }
        const error = execution.getError();
        if (error !== null) throw error;
        reply.code(200);
        const final = execution.getFinal();
        idem.handle?.complete(200, final, execution.responseId);
        return final;
      } finally {
        reply.raw.removeListener('close', onClose);
        context.inFlight.unregister(execution.responseId);
      }
    } catch (error) {
      // 首次失败要把幂等键释放掉，否则同键重试会一直撞见 in_progress
      idem.handle?.release();
      throw error;
    }
  });

  app.get<{ Params: { id: string } }>(
    '/v1/responses/:id',
    { preHandler: apiKeyGuard },
    async (request) => {
      const row = context.responseRepo.findById(request.params.id);
      if (row === undefined) throw ApiError.notFound('response 不存在');
      assertOwnership(row.api_key_id, request.apiKeyRow?.id ?? null);
      const body = context.responseRepo.readBody(request.params.id);
      if (body === null) {
        // 尚未完成或无快照：返回精简状态
        return { id: row.id, object: 'response', status: row.status };
      }
      return body;
    },
  );

  app.post<{ Params: { id: string } }>(
    '/v1/responses/:id/cancel',
    { preHandler: apiKeyGuard },
    async (request) => {
      const row = context.responseRepo.findById(request.params.id);
      if (row === undefined) throw ApiError.notFound('response 不存在');
      assertOwnership(row.api_key_id, request.apiKeyRow?.id ?? null);
      const cancelled = context.inFlight.cancel(request.params.id);
      if (!cancelled && (row.status === 'completed' || row.status === 'failed')) {
        throw ApiError.badRequest(`response 已处于 ${row.status} 状态，无法取消`);
      }
      return { id: row.id, object: 'response', status: 'cancelling' };
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/v1/responses/:id',
    { preHandler: apiKeyGuard },
    async (request) => {
      const row = context.responseRepo.findById(request.params.id);
      if (row === undefined) throw ApiError.notFound('response 不存在');
      assertOwnership(row.api_key_id, request.apiKeyRow?.id ?? null);
      context.inFlight.cancel(request.params.id);
      return { id: row.id, object: 'response', deleted: true };
    },
  );
}

/** 以 SSE 流式回传。第一条事件前设置 SSE 头并 hijack。 */
async function streamResponse(reply: FastifyReply, stream: AsyncGenerator<SseEvent>): Promise<void> {
  reply.raw.setHeader('content-type', 'text/event-stream; charset=utf-8');
  reply.raw.setHeader('cache-control', 'no-cache, no-transform');
  reply.raw.setHeader('connection', 'keep-alive');
  reply.raw.setHeader('x-accel-buffering', 'no');
  reply.raw.setHeader(REQUEST_ID_HEADER, String(reply.request.id));
  reply.hijack();
  reply.raw.flushHeaders();

  try {
    for await (const event of stream) {
      const ok = reply.raw.write(serializeSse(event));
      if (!ok) {
        // 背压：等到可写再继续
        await new Promise<void>((resolve) => reply.raw.once('drain', resolve));
      }
    }
  } catch (error) {
    // 事件流内部理应已把错误转为 response.failed；走到这里是意外
    reply.request.log.error({ err: error }, 'SSE 流意外中断');
  } finally {
    if (!reply.raw.writableEnded) reply.raw.end();
  }
}

function headerValue(request: FastifyRequest, name: string): string | null {
  const value = request.headers[name];
  if (typeof value === 'string' && value.trim() !== '') return value.trim();
  return null;
}

function assertOwnership(rowApiKeyId: string | null, requesterApiKeyId: string | null): void {
  // 一个 API Key 只能看自己的 response
  if (rowApiKeyId !== null && requesterApiKeyId !== null && rowApiKeyId !== requesterApiKeyId) {
    throw ApiError.notFound('response 不存在');
  }
}
