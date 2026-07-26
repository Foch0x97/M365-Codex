import { ApiError } from '@m365-codex/shared';
import { Buffer } from 'node:buffer';
import { randomBytes } from 'node:crypto';
import type { Logger } from 'pino';
import type { ToolsConfig } from '../config/index.js';
import type { UpstreamEvent } from '../adapter/protocol.js';
import type { DispatchRequest, UpstreamDispatcher } from '../scheduler/dispatcher.js';
import type { Metrics } from '../observability/metrics.js';
import type { ResponseRepository } from '../repo/responses.js';
import type { ToolCallRepository } from '../repo/toolCalls.js';
import type { FilesService } from '../files/service.js';
import { buildToolInstruction, PromptToolScanner } from '../tools/promptProtocol.js';
import { ToolRegistry, type ValidationReason } from '../tools/registry.js';
import { ResponseStreamBuilder } from './builder.js';
import {
  buildPassthrough,
  extractInputText,
  extractReasoningEffort,
  type ExtractInputDeps,
  type ResponsesRequest,
  type ToolResult,
} from './schema.js';
import type { ResponseObject, SseEvent } from './types.js';

/**
 * Responses 服务：串起 dispatch → 状态机 → 持久化，并实现工具调用的完整代理循环
 * （对应实施计划 §7）。
 *
 * 可靠性规则（§7.3）在这里的落点：
 * - **只调声明过的工具**：未声明的调用先请求修复，修复无果就丢弃并判失败，绝不发给客户端；
 * - **参数必须是合法 JSON**：修复无果同样判失败（发出去客户端也解析不了）；
 * - **参数不符合 schema**：修复无果时如实发出并记录告警——schema 可能只是客户端的期望，
 *   由客户端自己决定怎么处理，比整轮失败更可用；
 * - **每个调用唯一 call_id**、**不因重连重复发出**：靠 tool_calls 表的
 *   `UNIQUE (response_id, call_id)`；
 * - **结果回传必须匹配未完成的 call_id**：在 create() 里同步校验，早于任何上游动作；
 * - **副作用阶段不跨账号重放**：带工具结果的请求打上 sideEffect，由调度器保证失败即止；
 * - **工具 JSON 不重复出现在正文**：提示词模拟模式下由 PromptToolScanner 从文本流里剥离。
 */

export interface CreateResponseInput {
  request: ResponsesRequest;
  apiKeyId: string | null;
  signal?: AbortSignal | undefined;
  idempotencyKey?: string | null;
}

export interface ResponseExecution {
  responseId: string;
  stream: AsyncGenerator<SseEvent>;
  getFinal: () => ResponseObject;
  getError: () => ApiError | null;
  /** 客户端声明了但本网关执行不了、已被跳过的工具名（供路由回写响应头告知调用方） */
  skippedTools: readonly string[];
}

export interface ResponsesServiceDeps {
  dispatcher: UpstreamDispatcher;
  responses: ResponseRepository;
  toolCalls: ToolCallRepository;
  tools: ToolsConfig;
  logger: Logger;
  /** M6 新增：解析 input_file / input_image 的 file_id 引用（按发起请求的 API Key 限定归属） */
  files?: FilesService;
  /** M6 新增：上游是否真支持图片输入（UPSTREAM_IMAGE_INPUT，默认 false） */
  upstreamImageInput?: boolean;
  /** M6 新增：重建出的上下文文本超过多少字符就从最旧历史开始截断 */
  contextMaxChars?: number;
  /** M7 新增：在关键路径打点，供 /admin/overview 与未来 M8 的 /metrics 使用 */
  metrics?: Metrics;
}

/** 缓冲中的工具调用（按 call_id 累积参数）。 */
interface PendingToolCall {
  callId: string;
  name: string;
  args: string;
}

/** 一轮工具调用的校验结论。 */
interface RoundVerdict {
  /** 必须请求修复、且修复无果就不能发出的问题 */
  fatal: string[];
  /** 只是不符合 schema，修复无果时仍可发出 */
  soft: string[];
  /** 未声明或参数非法、不允许发给客户端的调用 */
  rejected: Set<string>;
}

export class ResponsesService {
  readonly #deps: ResponsesServiceDeps;

  constructor(deps: ResponsesServiceDeps) {
    this.#deps = deps;
  }

  create(input: CreateResponseInput): ResponseExecution {
    const { request } = input;
    // input_file / input_image 的 file_id 引用按发起请求的 API Key 限定归属，
    // 不允许跨 Key 读取他人上传的文件内容（见 files/service.ts 的 resolveOwned*）。
    const extracted = extractInputText(request, this.#buildExtractDeps(input.apiKeyId)); // 不支持内容会在此抛清晰错误
    if (extracted.truncatedChars > 0) {
      // 不静默：上下文因为超过 CONTEXT_MAX_CHARS 被截断，留痕方便排查"模型突然失忆"
      this.#deps.logger.info(
        { truncated_chars: extracted.truncatedChars },
        '重建的对话上下文超过字符上限，已从最旧历史开始截断',
      );
    }
    if (extracted.skippedItemTypes.length > 0) {
      this.#deps.logger.warn(
        { skipped_item_types: extracted.skippedItemTypes },
        'input 中出现无法识别的历史项类型，已跳过（不影响用户可见内容）',
      );
    }
    const registry = ToolRegistry.fromRequest(request.tools);
    const previousResponseId = request.previous_response_id ?? null;

    // 工具结果回传：必须匹配已发出的调用、且不超过结果大小上限。
    // 放在这里（而不是生成器里）是为了在动上游之前就把 4xx 明确返回给客户端。
    this.#validateToolResults(extracted.toolResults, previousResponseId);

    const inherited = this.#inheritToolCounters(previousResponseId);
    const limits = this.#deps.tools;
    if (registry.size > 0 && inherited.round >= limits.maxRounds) {
      throw ApiError.badRequest(
        `本对话链已达最大工具轮次 ${limits.maxRounds}，不再继续代理循环`,
        'previous_response_id',
      );
    }

    const responseId = `resp_${randomBytes(16).toString('hex')}`;
    const now = Date.now();
    const sticky = this.#resolveSticky(previousResponseId);
    const reasoningEffort = extractReasoningEffort(request);
    const passthrough = buildPassthrough(request);
    if (extracted.images.length > 0) {
      // 「适配层约定」：invocation 的透传字段本就是给上游的通用扩展通道
      // （model/reasoning/temperature 都走这条路），图片沿用同一通道，
      // 具体线上字段名/结构待 M0 探针校准（见 adapter/protocol.ts 的注释）。
      passthrough.images = extracted.images;
    }

    const builder = new ResponseStreamBuilder({
      responseId,
      model: request.model,
      previousResponseId,
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
        previousResponseId,
        idempotencyKey: input.idempotencyKey ?? null,
        toolRound: inherited.round,
        toolCallsTotal: inherited.total,
      },
      now,
    );

    if (registry.skipped.length > 0) {
      // 不静默：跳过的托管工具要留痕，路由还会通过响应头告诉调用方
      this.#deps.logger.warn(
        { response_id: responseId, skipped: registry.skipped.map((t) => `${t.type}:${t.name}`) },
        '声明了本网关执行不了的工具，已跳过',
      );
    }

    const errorHolder: { error: ApiError | null } = { error: null };
    const stream = this.#run({ input, extracted, sticky, passthrough, registry, builder, errorHolder, inherited });
    return {
      responseId,
      stream,
      getFinal: () => builder.snapshot(),
      getError: () => errorHolder.error,
      skippedTools: registry.skipped.map((t) => t.name),
    };
  }

  async *#run(ctx: {
    input: CreateResponseInput;
    extracted: ReturnType<typeof extractInputText>;
    sticky: { accountId: string; conversationRef: string | null } | null;
    passthrough: Record<string, unknown>;
    registry: ToolRegistry;
    builder: ResponseStreamBuilder;
    errorHolder: { error: ApiError | null };
    inherited: { round: number; total: number };
  }): AsyncGenerator<SseEvent> {
    const { builder, registry } = ctx;
    const limits = this.#deps.tools;
    const responseId = builder.responseId;

    yield* iter(builder.begin());
    this.#deps.responses.updateStatus(responseId, 'in_progress');

    // 续接：把上一轮发出的、这次带结果回传的工具调用标记为完成（幂等）
    this.#markPriorToolCallsCompleted(ctx.input.request.previous_response_id ?? null, ctx.extracted.toolResults);

    const toolResults = ctx.extracted.toolResults.map((r) => ({ callId: r.callId, output: r.output }));
    const hasToolResults = toolResults.length > 0;
    const hasTools = registry.size > 0;
    // native / auto 走结构化声明；prompt / auto 额外把工具目录写进提示词（§3.5）
    const tools = hasTools && limits.mode !== 'prompt' ? registry.toDeclarations() : undefined;
    const instruction = hasTools && limits.mode !== 'native' ? buildToolInstruction(registry.list()) : '';
    const scanText = instruction !== '';
    const allowParallel = limits.allowParallel && ctx.input.request.parallel_tool_calls !== false;
    const maxPerRound = allowParallel ? limits.maxCallsPerRound : 1;

    let lastAccountId = '';
    let lastConversationRef: string | null = ctx.sticky?.conversationRef ?? null;

    try {
      let attempt = 0;
      let text = withInstruction(instruction, ctx.extracted.text);
      let sticky = ctx.sticky;
      let sideEffect = hasToolResults;
      let carryToolResults: typeof toolResults | undefined = hasToolResults ? toolResults : undefined;

      for (;;) {
        const request: DispatchRequest = {
          text,
          sticky,
          passthrough: ctx.passthrough,
          tools,
          toolResults: carryToolResults,
          sideEffect,
          signal: ctx.input.signal,
        };
        const dispatch = this.#deps.dispatcher.dispatch(request);
        const pending = new Map<string, PendingToolCall>();
        const order: string[] = [];
        const scanner = scanText ? new PromptToolScanner() : null;

        for await (const raw of dispatch.events) {
          for (const event of expand(raw, scanner)) {
            if (this.#accumulateToolEvent(event, pending, order)) continue;
            // 修复轮（attempt>0）不再向客户端重复输出文本，只取工具调用
            if (attempt === 0) {
              yield* iter(builder.consume(event));
            }
          }
        }
        if (scanner !== null) {
          for (const event of flush(scanner)) {
            if (this.#accumulateToolEvent(event, pending, order)) continue;
            if (attempt === 0) yield* iter(builder.consume(event));
          }
        }
        lastAccountId = dispatch.accountId;
        lastConversationRef = dispatch.conversationRef;

        const toolCalls = order.map((id) => pending.get(id)).filter((c): c is PendingToolCall => c !== undefined);
        if (toolCalls.length === 0) {
          break; // 没有工具调用，本轮结束
        }

        const verdict = this.#judgeRound(toolCalls, registry, maxPerRound, allowParallel);

        if ((verdict.fatal.length > 0 || verdict.soft.length > 0) && attempt < limits.maxArgRepairs) {
          attempt += 1;
          text = withInstruction(instruction, buildRepairPrompt([...verdict.fatal, ...verdict.soft]));
          sticky = { accountId: dispatch.accountId, conversationRef: dispatch.conversationRef };
          // 修复轮只是重新要一次工具调用，本身不产生副作用
          sideEffect = false;
          carryToolResults = undefined;
          this.#deps.logger.info(
            { response_id: responseId, attempt, fatal: verdict.fatal.length, soft: verdict.soft.length },
            '工具调用不合规，请求上游修复',
          );
          continue;
        }

        if (verdict.fatal.length > 0) {
          // 修复额度用尽仍不合规：未声明的工具、非法 JSON 一律不发给客户端
          throw new ApiError({
            type: 'upstream_error',
            status: 502,
            message: `上游的工具调用不合规且修复 ${limits.maxArgRepairs} 次后仍未纠正：${verdict.fatal.join('；')}`,
          });
        }

        const emitted = toolCalls.filter((tc) => !verdict.rejected.has(tc.callId));
        if (ctx.inherited.total + emitted.length > limits.maxTotalCalls) {
          throw ApiError.badRequest(
            `本对话链累计工具调用数将超过上限 ${limits.maxTotalCalls}，不再继续代理循环`,
          );
        }
        if (verdict.soft.length > 0) {
          this.#deps.logger.warn(
            { response_id: responseId, issues: verdict.soft.length },
            '工具参数不符合 schema，修复额度用尽后如实发出',
          );
        }

        // 打点供 /admin/overview 的 tools.calls_last_hour / arg_pass_rate 使用：
        // rejected 是本轮被判定不合规、绝不下发给客户端的调用数；emitted 是实际下发数。
        if (verdict.rejected.size > 0) {
          this.#deps.metrics?.toolArgValidations.inc({ result: 'rejected' }, verdict.rejected.size);
        }
        if (emitted.length > 0) {
          this.#deps.metrics?.toolCalls.inc({}, emitted.length);
          this.#deps.metrics?.toolArgValidations.inc({ result: 'pass' }, emitted.length);
        }

        for (const tc of emitted) {
          yield* iter(builder.emitFunctionCall(tc.callId, tc.name, tc.args));
          this.#deps.toolCalls.recordEmitted({
            responseId,
            callId: tc.callId,
            name: tc.name,
            arguments: tc.args,
            sideEffect: registry.isSideEffect(tc.name),
          });
        }
        this.#deps.responses.setToolCounters(
          responseId,
          ctx.inherited.round + 1,
          ctx.inherited.total + emitted.length,
        );
        break;
      }

      if (ctx.input.signal?.aborted === true) {
        yield* iter(builder.cancel());
        this.#persistFinal(responseId, lastAccountId, lastConversationRef, builder);
        return;
      }

      yield* iter(builder.finish());
      const finalStatus = builder.snapshot();
      if (finalStatus.status === 'failed') {
        ctx.errorHolder.error = new ApiError({
          type: 'upstream_error',
          status: 502,
          message: finalStatus.error?.message ?? '上游返回错误',
        });
      }
      this.#persistFinal(responseId, lastAccountId, lastConversationRef, builder);
    } catch (error) {
      if (ctx.input.signal?.aborted === true) {
        yield* iter(builder.cancel());
        this.#persistFinal(responseId, lastAccountId, lastConversationRef, builder);
        return;
      }
      const apiError = error instanceof ApiError ? error : ApiError.internal('上游处理失败', error);
      ctx.errorHolder.error = apiError;
      this.#deps.logger.warn({ response_id: responseId, err_code: apiError.type }, 'Responses 执行失败');
      yield* iter(builder.fail(apiError.message, apiError.type));
      this.#persistFinal(responseId, lastAccountId, lastConversationRef, builder);
    }
  }

  /**
   * 审一轮工具调用：数量是否超限、工具是否声明过、参数是否合法。
   * 未声明与非法 JSON 进 rejected（绝不发给客户端），schema 不符只记软问题。
   */
  #judgeRound(
    toolCalls: readonly PendingToolCall[],
    registry: ToolRegistry,
    maxPerRound: number,
    allowParallel: boolean,
  ): RoundVerdict {
    const verdict: RoundVerdict = { fatal: [], soft: [], rejected: new Set() };

    if (toolCalls.length > maxPerRound) {
      verdict.fatal.push(
        allowParallel
          ? `一轮最多 ${maxPerRound} 个工具调用，收到 ${toolCalls.length} 个`
          : `本次请求禁止并行工具调用，但收到 ${toolCalls.length} 个`,
      );
    }

    for (const call of toolCalls) {
      const result = registry.validateArguments(call.name, call.args);
      if (result.valid) continue;
      const summary = `工具 ${call.name}：${result.errors.join('；')}`;
      const reason: ValidationReason = result.reason ?? 'schema';
      if (reason === 'schema') {
        verdict.soft.push(summary);
      } else {
        verdict.fatal.push(summary);
        verdict.rejected.add(call.callId);
      }
    }
    return verdict;
  }

  /** 把工具事件累积到缓冲区；返回 true 表示该事件是工具事件（已消费）。 */
  #accumulateToolEvent(
    event: UpstreamEvent,
    pending: Map<string, PendingToolCall>,
    order: string[],
  ): boolean {
    switch (event.kind) {
      case 'tool_call_begin':
        if (!pending.has(event.callId)) {
          pending.set(event.callId, { callId: event.callId, name: event.name, args: '' });
          order.push(event.callId);
        }
        return true;
      case 'tool_call_args_delta': {
        const call = pending.get(event.callId);
        if (call !== undefined) call.args += event.delta;
        return true;
      }
      case 'tool_call_end':
        return true;
      default:
        return false;
    }
  }

  /** 校验工具结果回传：必须对应已发出的调用，且不超过大小上限（§7.3、§7.4）。 */
  #validateToolResults(toolResults: readonly ToolResult[], previousResponseId: string | null): void {
    const maxBytes = this.#deps.tools.maxResultBytes;
    for (const result of toolResults) {
      const size = Buffer.byteLength(result.output, 'utf8');
      if (size > maxBytes) {
        throw new ApiError({
          type: 'invalid_request_error',
          status: 413,
          message: `工具结果 ${size} 字节，超过上限 ${maxBytes} 字节`,
          param: 'input',
        });
      }
      const known =
        (previousResponseId === null
          ? undefined
          : this.#deps.toolCalls.findByCallId(previousResponseId, result.callId)) ??
        this.#deps.toolCalls.findAnyByCallId(result.callId);
      if (known === undefined) {
        throw ApiError.badRequest(
          `function_call_output 的 call_id ${result.callId} 不对应任何已发出的工具调用`,
          'input',
        );
      }
    }
  }

  /** 从上一轮继承工具轮次与累计调用数。 */
  #inheritToolCounters(previousResponseId: string | null): { round: number; total: number } {
    if (previousResponseId === null) return { round: 0, total: 0 };
    const parent = this.#deps.responses.findById(previousResponseId);
    return { round: parent?.tool_round ?? 0, total: parent?.tool_calls_total ?? 0 };
  }

  /** 续接时把上一轮发出、这次回传结果的工具调用标记完成（幂等）。 */
  #markPriorToolCallsCompleted(
    previousResponseId: string | null,
    toolResults: readonly { callId: string; output: string }[],
  ): void {
    if (toolResults.length === 0) return;
    for (const result of toolResults) {
      const existing =
        (previousResponseId === null
          ? undefined
          : this.#deps.toolCalls.findByCallId(previousResponseId, result.callId)) ??
        this.#deps.toolCalls.findAnyByCallId(result.callId);
      if (existing === undefined) continue;
      // markCompleted 只在 emitted→completed 时生效，重复回传不会二次处理
      this.#deps.toolCalls.markCompleted(existing.response_id, result.callId, result.output);
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

  #resolveSticky(previousResponseId: string | null): { accountId: string; conversationRef: string | null } | null {
    if (previousResponseId === null) return null;
    const binding = this.#deps.responses.findBinding(previousResponseId);
    if (binding?.account_id == null) return null;
    return { accountId: binding.account_id, conversationRef: binding.upstream_conversation_ref };
  }

  /** 把 FilesService 适配成 extractInputText 需要的、按 apiKeyId 限定归属的查找接口。 */
  #buildExtractDeps(apiKeyId: string | null): ExtractInputDeps {
    const files = this.#deps.files;
    if (files === undefined || apiKeyId === null) {
      return {
        imageInputEnabled: this.#deps.upstreamImageInput === true,
        contextMaxChars: this.#deps.contextMaxChars,
      };
    }
    return {
      imageInputEnabled: this.#deps.upstreamImageInput === true,
      contextMaxChars: this.#deps.contextMaxChars,
      files: {
        resolveText: (fileId) => files.resolveOwnedText(fileId, apiKeyId),
        resolveImageDataUrl: (fileId) => files.resolveOwnedImageDataUrl(fileId, apiKeyId),
      },
    };
  }
}

/** 提示词模拟模式下，工具目录跟在用户文本前面一起发给上游。 */
function withInstruction(instruction: string, text: string): string {
  return instruction === '' ? text : `${instruction}\n\n${text}`;
}

/** 构造请求上游修复的提示。 */
function buildRepairPrompt(issues: readonly string[]): string {
  return `上一次的工具调用不符合要求，请仅重新发起工具调用并给出合法参数。\n${issues.join('\n')}`;
}

/** 提示词模拟模式下把正文里的工具调用剥离出来；其余事件原样通过。 */
function expand(event: UpstreamEvent, scanner: PromptToolScanner | null): UpstreamEvent[] {
  if (scanner === null || event.kind !== 'text_delta') return [event];
  const { text, events } = scanner.push(event.text);
  return text === '' ? events : [{ kind: 'text_delta', text }, ...events];
}

function flush(scanner: PromptToolScanner): UpstreamEvent[] {
  const { text, events } = scanner.flush();
  return text === '' ? events : [{ kind: 'text_delta', text }, ...events];
}

function* iter(events: SseEvent[]): Generator<SseEvent> {
  for (const event of events) yield event;
}
