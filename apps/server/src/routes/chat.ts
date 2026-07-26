import { REQUEST_ID_HEADER } from '@m365-codex/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from '../context.js';
import { createApiKeyGuard } from '../gateway/auth.js';
import { beginIdempotency } from '../gateway/idempotency.js';
import {
  ChatStreamTranslator,
  chatRequestToResponsesPayload,
  parseChatCompletionRequest,
  responseToChatCompletion,
} from '../responses/chatBridge.js';
import { parseResponsesRequest } from '../responses/schema.js';
import type { SseEvent } from '../responses/types.js';

/**
 * `POST /v1/chat/completions`（对应实施计划 §M6）。
 *
 * **复用 Responses 内核，绝不另建一套推理逻辑**：把 Chat 请求转成
 * `ResponsesRequest` 交给现有 `ResponsesService`，再把结果/事件流转回
 * Chat 形态。账号调度、工具代理循环、SSE 生命周期全部沿用 `/v1/responses`
 * 已有实现，这里只做协议转换（见 `responses/chatBridge.ts`）。
 */
export function registerChatRoutes(app: FastifyInstance, context: AppContext): void {
  const apiKeyGuard = createApiKeyGuard(context);

  app.post('/v1/chat/completions', { preHandler: apiKeyGuard }, async (request, reply) => {
    const chat = parseChatCompletionRequest(request.body);
    const responsesRequest = parseResponsesRequest(chatRequestToResponsesPayload(chat));
    const apiKeyId = request.apiKeyRow?.id ?? null;
    const idempotencyKey = headerValue(request, 'idempotency-key');

    const idem = beginIdempotency({
      store: context.idempotency,
      key: idempotencyKey,
      apiKeyId,
      endpoint: 'POST /v1/chat/completions',
      rawBody: request.body,
      stream: chat.stream === true,
    });
    if (idem.replay !== undefined) {
      reply.code(idem.replay.statusCode);
      return idem.replay.body;
    }

    try {
      // 客户端断开 → 取消上游（与 /v1/responses 共用同一套取消机制）
      const controller = new AbortController();
      const execution = context.responses.create({
        request: responsesRequest,
        apiKeyId,
        signal: controller.signal,
        idempotencyKey,
      });
      context.inFlight.register(execution.responseId, controller);

      // 见 routes/v1.ts 同名变量的注释：hijack 后 onResponse 不再触发，
      // 靠这个标记区分「流未结束时客户端断开」（算中断）与「流已收尾后连接关闭」
      let handlerDone = false;
      const onClose = (): void => {
        if (!handlerDone && chat.stream === true) {
          context.metrics.sseInterrupted.inc({ endpoint: 'chat_completions' });
        }
        controller.abort();
      };
      reply.raw.on('close', onClose);

      try {
        if (chat.stream) {
          const startedAt = process.hrtime.bigint();
          const streamed = await streamChatCompletion(reply, execution.stream, execution.responseId, chat.model);
          context.metrics.requests.inc({ endpoint: 'POST /v1/chat/completions', status: '200' });
          context.metrics.requestDuration.observe(elapsedSeconds(startedAt), {
            endpoint: 'POST /v1/chat/completions',
          });
          idem.handle?.complete(0, null, null);
          return streamed;
        }
        // 非流式：把事件流跑干（驱动上游），再把最终 Response 对象转成 chat.completion
        for await (const _event of execution.stream) {
          void _event;
        }
        const error = execution.getError();
        if (error !== null) throw error;
        reply.code(200);
        const final = responseToChatCompletion(execution.getFinal());
        idem.handle?.complete(200, final, execution.responseId);
        return final;
      } finally {
        handlerDone = true;
        reply.raw.removeListener('close', onClose);
        context.inFlight.unregister(execution.responseId);
      }
    } catch (error) {
      idem.handle?.release();
      throw error;
    }
  });
}

/** 以 `chat.completion.chunk` 的 SSE 形态流式回传，末尾发 `data: [DONE]`。 */
async function streamChatCompletion(
  reply: FastifyReply,
  stream: AsyncGenerator<SseEvent>,
  responseId: string,
  model: string,
): Promise<void> {
  reply.raw.setHeader('content-type', 'text/event-stream; charset=utf-8');
  reply.raw.setHeader('cache-control', 'no-cache, no-transform');
  reply.raw.setHeader('connection', 'keep-alive');
  reply.raw.setHeader('x-accel-buffering', 'no');
  reply.raw.setHeader(REQUEST_ID_HEADER, String(reply.request.id));
  reply.hijack();
  reply.raw.flushHeaders();

  const createdAt = Math.floor(Date.now() / 1000);
  const translator = new ChatStreamTranslator(responseId, model, createdAt);

  const write = async (payload: Record<string, unknown>): Promise<void> => {
    if (reply.raw.destroyed) return;
    const ok = reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`);
    // 客户端断开后 'drain' 永远不会来（见 routes/v1.ts 的 waitForDrainOrClose 同款注释），
    // 必须同时听 'close'，否则这里会永久挂起，inFlight 也就永远释放不掉
    if (!ok) await waitForDrainOrClose(reply);
  };

  try {
    await write(translator.start());
    for await (const event of stream) {
      const chunk = translator.translate(event);
      if (chunk !== null) await write(chunk);
    }
    if (!reply.raw.destroyed) reply.raw.write('data: [DONE]\n\n');
  } catch (error) {
    // 事件流内部理应已把错误转为 response.failed（会译成带 finish_reason 的 chunk）；
    // 走到这里是意外，与 /v1/responses 的对应处理保持一致
    reply.request.log.error({ err: error }, 'Chat Completions SSE 流意外中断');
  } finally {
    if (!reply.raw.writableEnded && !reply.raw.destroyed) reply.raw.end();
  }
}

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
