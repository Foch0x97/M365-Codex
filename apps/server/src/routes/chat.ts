import { REQUEST_ID_HEADER } from '@m365-codex/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from '../context.js';
import { createApiKeyGuard } from '../gateway/auth.js';
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

    // 客户端断开 → 取消上游（与 /v1/responses 共用同一套取消机制）
    const controller = new AbortController();
    const execution = context.responses.create({
      request: responsesRequest,
      apiKeyId,
      signal: controller.signal,
      idempotencyKey,
    });
    context.inFlight.register(execution.responseId, controller);

    const onClose = (): void => controller.abort();
    reply.raw.on('close', onClose);

    try {
      if (chat.stream) {
        return await streamChatCompletion(reply, execution.stream, execution.responseId, chat.model);
      }
      // 非流式：把事件流跑干（驱动上游），再把最终 Response 对象转成 chat.completion
      for await (const _event of execution.stream) {
        void _event;
      }
      const error = execution.getError();
      if (error !== null) throw error;
      reply.code(200);
      return responseToChatCompletion(execution.getFinal());
    } finally {
      reply.raw.removeListener('close', onClose);
      context.inFlight.unregister(execution.responseId);
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
    const ok = reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`);
    if (!ok) await new Promise<void>((resolve) => reply.raw.once('drain', resolve));
  };

  try {
    await write(translator.start());
    for await (const event of stream) {
      const chunk = translator.translate(event);
      if (chunk !== null) await write(chunk);
    }
    reply.raw.write('data: [DONE]\n\n');
  } catch (error) {
    // 事件流内部理应已把错误转为 response.failed（会译成带 finish_reason 的 chunk）；
    // 走到这里是意外，与 /v1/responses 的对应处理保持一致
    reply.request.log.error({ err: error }, 'Chat Completions SSE 流意外中断');
  } finally {
    if (!reply.raw.writableEnded) reply.raw.end();
  }
}

function headerValue(request: FastifyRequest, name: string): string | null {
  const value = request.headers[name];
  if (typeof value === 'string' && value.trim() !== '') return value.trim();
  return null;
}
