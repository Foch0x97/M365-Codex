import { ApiError } from '@m365-codex/shared';
import { randomBytes } from 'node:crypto';
import type { Logger } from 'pino';
import type { UpstreamDispatcher } from '../scheduler/dispatcher.js';
import type { ResponseRepository } from '../repo/responses.js';
import { ResponseStreamBuilder } from './builder.js';
import {
  buildPassthrough,
  extractInputText,
  extractReasoningEffort,
  type ResponsesRequest,
} from './schema.js';
import type { ResponseObject, SseEvent } from './types.js';

/**
 * Responses 服务：把一次请求串起 dispatch → 状态机 → 持久化。
 *
 * 对外暴露一个统一的执行入口，产出 SSE 事件流；非流式由路由把事件流跑干后取
 * 最终 Response 对象。响应记录在开始时入库（queued），结束时落最终 JSON。
 */

export interface CreateResponseInput {
  request: ResponsesRequest;
  apiKeyId: string | null;
  /** 客户端断开时触发，用于取消上游 */
  signal?: AbortSignal | undefined;
  idempotencyKey?: string | null;
}

export interface ResponseExecution {
  responseId: string;
  /** SSE 事件流；迭代驱动整个上游对话 */
  stream: AsyncGenerator<SseEvent>;
  /** 事件流跑完后取最终 Response 对象（非流式用） */
  getFinal: () => ResponseObject;
  /**
   * 事件流跑完后取硬错误（非流式用）。
   * 流式已在事件流内以 response.failed 表达，非流式据此返回对应 HTTP 状态。
   */
  getError: () => ApiError | null;
}

export interface ResponsesServiceDeps {
  dispatcher: UpstreamDispatcher;
  responses: ResponseRepository;
  logger: Logger;
}

export class ResponsesService {
  readonly #deps: ResponsesServiceDeps;

  constructor(deps: ResponsesServiceDeps) {
    this.#deps = deps;
  }

  create(input: CreateResponseInput): ResponseExecution {
    const { request } = input;
    const extracted = extractInputText(request); // 不支持内容会在此抛清晰错误
    const responseId = `resp_${randomBytes(16).toString('hex')}`;
    const now = Date.now();

    // 续接：从 previous_response_id 找出上一轮的账号与上游会话，实现粘性
    const sticky = this.#resolveSticky(request.previous_response_id ?? null);
    const reasoningEffort = extractReasoningEffort(request);
    const passthrough = buildPassthrough(request);

    const builder = new ResponseStreamBuilder({
      responseId,
      model: request.model,
      previousResponseId: request.previous_response_id ?? null,
      metadata: request.metadata ?? null,
      reasoningEffort,
      maxOutputTokens: request.max_output_tokens ?? null,
      temperature: request.temperature ?? null,
      createdAt: now,
    });

    this.#deps.responses.create(
      {
        id: responseId,
        apiKeyId: input.apiKeyId,
        status: 'queued',
        requestedModel: request.model,
        requestedReasoningEffort: reasoningEffort,
        upstreamModelParameter: request.model,
        previousResponseId: request.previous_response_id ?? null,
        idempotencyKey: input.idempotencyKey ?? null,
      },
      now,
    );

    const errorHolder: { error: ApiError | null } = { error: null };
    const stream = this.#run({ input, extracted, sticky, passthrough, builder, errorHolder });
    return {
      responseId,
      stream,
      getFinal: () => builder.snapshot(),
      getError: () => errorHolder.error,
    };
  }

  async *#run(ctx: {
    input: CreateResponseInput;
    extracted: ReturnType<typeof extractInputText>;
    sticky: { accountId: string; conversationRef: string | null } | null;
    passthrough: Record<string, unknown>;
    builder: ResponseStreamBuilder;
    errorHolder: { error: ApiError | null };
  }): AsyncGenerator<SseEvent> {
    const { responses, logger } = this.#deps;
    const { builder } = ctx;
    const responseId = builder.responseId;

    yield* iter(builder.begin());
    responses.updateStatus(responseId, 'in_progress');

    const dispatch = this.#deps.dispatcher.dispatch({
      text: ctx.extracted.text,
      sticky: ctx.sticky,
      passthrough: ctx.passthrough,
      signal: ctx.input.signal,
    });

    try {
      for await (const event of dispatch.events) {
        yield* iter(builder.consume(event));
      }

      // 若客户端已取消，收尾为 incomplete
      if (ctx.input.signal?.aborted === true) {
        yield* iter(builder.cancel());
        this.#persistFinal(responseId, dispatch.accountId, dispatch.conversationRef, builder);
        return;
      }

      yield* iter(builder.finish());
      // 流内不可重试的上游错误不会抛异常，但会让状态机收尾为 failed。
      // 非流式据此返回错误 HTTP 状态（流式已在事件流内以 response.failed 表达）。
      const finalStatus = builder.snapshot();
      if (finalStatus.status === 'failed') {
        ctx.errorHolder.error = new ApiError({
          type: 'upstream_error',
          status: 502,
          message: finalStatus.error?.message ?? '上游返回错误',
        });
      }
      this.#persistFinal(responseId, dispatch.accountId, dispatch.conversationRef, builder);
    } catch (error) {
      if (ctx.input.signal?.aborted === true) {
        yield* iter(builder.cancel());
        this.#persistFinal(responseId, dispatch.accountId, dispatch.conversationRef, builder);
        return;
      }
      const apiError =
        error instanceof ApiError ? error : ApiError.internal('上游处理失败', error);
      ctx.errorHolder.error = apiError;
      logger.warn({ response_id: responseId, err_code: apiError.type }, 'Responses 执行失败');
      yield* iter(builder.fail(apiError.message, apiError.type));
      this.#persistFinal(responseId, dispatch.accountId, dispatch.conversationRef, builder);
    }
  }

  #persistFinal(
    responseId: string,
    accountId: string,
    conversationRef: string | null,
    builder: ResponseStreamBuilder,
  ): void {
    const snapshot = builder.snapshot();
    if (accountId !== '') {
      this.#deps.responses.setAccount(responseId, accountId);
      this.#deps.responses.upsertBinding({
        response_id: responseId,
        account_id: accountId,
        upstream_conversation_ref: conversationRef,
        created_at: Date.now(),
      });
    }
    this.#deps.responses.complete(responseId, snapshot.status, snapshot, {
      errorMessage: snapshot.error?.message ?? null,
    });
  }

  /** 从 previous_response_id 解析出粘性绑定。找不到就返回 null（当作新会话）。 */
  #resolveSticky(previousResponseId: string | null): { accountId: string; conversationRef: string | null } | null {
    if (previousResponseId === null) return null;
    const binding = this.#deps.responses.findBinding(previousResponseId);
    if (binding?.account_id == null) return null;
    return { accountId: binding.account_id, conversationRef: binding.upstream_conversation_ref };
  }
}

/** 把 SSE 事件数组转成可 yield* 的生成器。 */
function* iter(events: SseEvent[]): Generator<SseEvent> {
  for (const event of events) yield event;
}
