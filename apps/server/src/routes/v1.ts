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
  // 读不到目录文件时会退到内置的单条目录——这属于部署问题，必须留痕
  const models = loadModels(undefined, (reason) => context.logger.warn({ reason }, '模型目录降级'));

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
        toolCallsCeiling: request.apiKeyLimits?.maxToolCalls,
      });
      context.inFlight.register(execution.responseId, controller);

      // 声明了但执行不了的工具（如 OpenAI 托管的 web_search）不静默丢弃：
      // 在这里回一个响应头，调用方能立刻看见自己有哪些工具不会生效
      if (execution.skippedTools.length > 0) {
        void reply.header('x-m365-codex-skipped-tools', execution.skippedTools.join(','));
      }

      // handlerDone 标记「本次请求已经跑到了收尾（finally）」——SSE hijack 后
      // Fastify 的 onResponse 不再触发，只能靠这个标记区分「流还没结束时客户端
      // 就断开了」（真正的中断，计入 sseInterrupted）与「流已经正常收尾后连接
      // 才关闭」（不算中断）
      let handlerDone = false;
      const onClose = (): void => {
        if (!handlerDone && body.stream === true) {
          context.metrics.sseInterrupted.inc({ endpoint: 'responses' });
        }
        controller.abort();
      };
      reply.raw.on('close', onClose);

      try {
        if (body.stream) {
          const startedAt = process.hrtime.bigint();
          const streamed = await streamResponse(reply, execution.stream);
          // hijack 后 onResponse 不会触发，这里手动记一次请求量与耗时（§17）
          context.metrics.requests.inc({ endpoint: 'POST /v1/responses', status: '200' });
          context.metrics.requestDuration.observe(elapsedSeconds(startedAt), {
            endpoint: 'POST /v1/responses',
          });
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
        handlerDone = true;
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
      // 连接已经断开就不用再写了——继续 write() 只是把字节丢进一个没人收的缓冲区，
      // 白白拖慢事件流跑干的速度
      if (reply.raw.destroyed) continue;
      const ok = reply.raw.write(serializeSse(event));
      if (!ok) await waitForDrainOrClose(reply);
    }
  } catch (error) {
    // 事件流内部理应已把错误转为 response.failed；走到这里是意外
    reply.request.log.error({ err: error }, 'SSE 流意外中断');
  } finally {
    if (!reply.raw.writableEnded && !reply.raw.destroyed) reply.raw.end();
  }
}

/**
 * 等到可写缓冲区排空（'drain'）再继续写入；但如果连接在等待期间已经关闭/销毁
 * （客户端断开），'drain' 就永远不会来——必须同时监听 'close'，否则流式循环
 * 会在一个没人接收的连接上永久挂起，`inFlight` 永远不会释放。
 */
function waitForDrainOrClose(reply: FastifyReply): Promise<void> {
  if (reply.raw.destroyed) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const cleanup = (): void => {
      reply.raw.removeListener('drain', onSettled);
      reply.raw.removeListener('close', onSettled);
    };
    const onSettled = (): void => {
      cleanup();
      resolve();
    };
    reply.raw.once('drain', onSettled);
    reply.raw.once('close', onSettled);
  });
}

/** `process.hrtime.bigint()` 起点转换成耗时秒数，供直方图打点用。 */
function elapsedSeconds(startedAt: bigint): number {
  return Number(process.hrtime.bigint() - startedAt) / 1e9;
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
