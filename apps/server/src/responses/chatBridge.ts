import { ApiError, type ResponseStatus } from '@m365-codex/shared';
import { z } from 'zod';
import type { SseEvent } from './types.js';
import type { ResponseObject } from './types.js';

/**
 * `/v1/chat/completions` ↔ Responses 的双向转换（对应实施计划 §M6）。
 *
 * 硬约束：**不建第二套推理逻辑**。这里只做协议转换：Chat 请求转成一个
 * Responses 请求对象（交给现有 `parseResponsesRequest` + `ResponsesService`
 * 处理推理/工具循环/账号调度），再把 Responses 的结果/事件流转回 Chat 形态。
 *
 * `model`、`temperature`、`max_tokens`、`tools`、`tool_choice`、
 * `parallel_tool_calls` 原样透传给 Responses 请求，不新造别名、不改写取值。
 */

const chatContentPart = z.object({ type: z.string() }).passthrough();

const chatToolCall = z
  .object({
    id: z.string(),
    type: z.literal('function').optional(),
    function: z.object({ name: z.string(), arguments: z.string() }),
  })
  .passthrough();

const chatMessage = z
  .object({
    role: z.enum(['system', 'developer', 'user', 'assistant', 'tool']),
    content: z.union([z.string(), z.array(chatContentPart)]).nullish(),
    tool_calls: z.array(chatToolCall).optional(),
    tool_call_id: z.string().optional(),
    name: z.string().optional(),
  })
  .passthrough();

export const chatCompletionRequestSchema = z
  .object({
    model: z.string().min(1, 'model 不能为空'),
    messages: z.array(chatMessage).min(1, 'messages 不能为空'),
    stream: z.boolean().optional().default(false),
    temperature: z.number().optional(),
    max_tokens: z.number().int().positive().optional(),
    tools: z.array(z.unknown()).optional(),
    tool_choice: z.unknown().optional(),
    parallel_tool_calls: z.boolean().optional(),
    // 部分 OpenAI 兼容客户端（如 o 系列模型）用这个键传思考等级；
    // 原样映射到 Responses 的 reasoning.effort，不枚举、不改写取值。
    reasoning_effort: z.string().optional(),
  })
  .passthrough();

export type ChatCompletionRequest = z.infer<typeof chatCompletionRequestSchema>;
export type ChatMessage = z.infer<typeof chatMessage>;

export function parseChatCompletionRequest(payload: unknown): ChatCompletionRequest {
  const result = chatCompletionRequestSchema.safeParse(payload);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw ApiError.badRequest(issue?.message ?? '请求体不合法', issue?.path.join('.') || undefined);
  }
  return result.data;
}

/** 把 Chat 的 content（string 或 part 数组）映射成 Responses 的 content 形态。 */
function mapContent(content: ChatMessage['content']): string | Record<string, unknown>[] {
  if (content === null || content === undefined) return '';
  if (typeof content === 'string') return content;
  return content.map((part) => {
    if (part.type === 'text' && typeof part.text === 'string') {
      return { type: 'input_text', text: part.text };
    }
    if (part.type === 'image_url') {
      const imageUrl = part.image_url as { url?: string } | string | undefined;
      const url = typeof imageUrl === 'string' ? imageUrl : imageUrl?.url;
      return { type: 'input_image', image_url: url };
    }
    // 未识别的 part 类型：原样透传，交给 Responses 侧「未识别 part 不猜测、不报错」的兜底逻辑
    return part;
  });
}

function contentToPlainText(content: ChatMessage['content']): string {
  if (content === null || content === undefined) return '';
  if (typeof content === 'string') return content;
  return content
    .map((part) => (part.type === 'text' && typeof part.text === 'string' ? part.text : ''))
    .join('');
}

/**
 * messages → Responses `input`（对应实施计划 §M6「messages 到 input 的映射覆盖
 * system/developer/user/assistant/tool 五种 role」）。
 *
 * - `tool` 消息转成 `function_call_output`；
 * - 助手消息带 `tool_calls` 时，每个 tool_call 转成一条 `function_call`
 *   历史回放项（Responses 侧本就支持解析，见 schema.ts 的多轮历史重建）；
 *   若同时还带了文字内容，文字部分再作为一条独立的 assistant message 跟上；
 * - 其余角色按 role 直接转成 message 项。
 */
export function chatMessagesToInput(messages: readonly ChatMessage[]): unknown[] {
  const input: unknown[] = [];
  for (const message of messages) {
    if (message.role === 'tool') {
      input.push({
        type: 'function_call_output',
        call_id: message.tool_call_id ?? '',
        output: contentToPlainText(message.content),
      });
      continue;
    }

    if (message.tool_calls !== undefined && message.tool_calls.length > 0) {
      for (const call of message.tool_calls) {
        input.push({
          type: 'function_call',
          call_id: call.id,
          name: call.function.name,
          arguments: call.function.arguments,
        });
      }
      if (message.content !== null && message.content !== undefined && message.content !== '') {
        input.push({ role: message.role, content: mapContent(message.content) });
      }
      continue;
    }

    input.push({ role: message.role, content: mapContent(message.content) });
  }
  return input;
}

/** 组装交给 `parseResponsesRequest` 的原始对象；字段原样透传，不新造别名。 */
export function chatRequestToResponsesPayload(chat: ChatCompletionRequest): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    model: chat.model,
    input: chatMessagesToInput(chat.messages),
    stream: chat.stream,
  };
  if (chat.temperature !== undefined) payload.temperature = chat.temperature;
  if (chat.max_tokens !== undefined) payload.max_output_tokens = chat.max_tokens;
  if (chat.tools !== undefined) payload.tools = chat.tools;
  if (chat.tool_choice !== undefined) payload.tool_choice = chat.tool_choice;
  if (chat.parallel_tool_calls !== undefined) payload.parallel_tool_calls = chat.parallel_tool_calls;
  if (chat.reasoning_effort !== undefined) payload.reasoning = { effort: chat.reasoning_effort };
  return payload;
}

function mapFinishReason(status: ResponseStatus, hasToolCalls: boolean): string {
  if (hasToolCalls) return 'tool_calls';
  switch (status) {
    case 'incomplete':
      return 'length';
    case 'cancelled':
      return 'stop';
    case 'failed':
      return 'stop';
    default:
      return 'stop';
  }
}

/** 非流式：Responses 的最终对象 → `chat.completion`。 */
export function responseToChatCompletion(response: ResponseObject): Record<string, unknown> {
  const textParts: string[] = [];
  const toolCalls: Record<string, unknown>[] = [];

  for (const item of response.output) {
    if (item.type === 'message') {
      for (const part of item.content) textParts.push(part.text);
    } else if (item.type === 'function_call') {
      toolCalls.push({
        id: item.call_id,
        type: 'function',
        function: { name: item.name, arguments: item.arguments },
      });
    }
    // reasoning 项：chat.completion 没有对应字段承载，不体现（不是丢弃语义，只是这个协议没地方放）
  }

  const message: Record<string, unknown> = {
    role: 'assistant',
    content: textParts.length > 0 ? textParts.join('') : null,
  };
  if (toolCalls.length > 0) message.tool_calls = toolCalls;

  return {
    id: response.id,
    object: 'chat.completion',
    created: response.created_at,
    model: response.model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: mapFinishReason(response.status, toolCalls.length > 0),
      },
    ],
    usage: null,
  };
}

/**
 * 流式：把 Responses 的 SSE 事件流逐个翻译成 `chat.completion.chunk`。
 * 有状态（要记住每个工具调用分到第几个 tool_calls 下标），所以是个类。
 */
export class ChatStreamTranslator {
  readonly #id: string;
  readonly #model: string;
  readonly #createdAt: number;
  readonly #toolCallIndex = new Map<string, number>();
  /** `function_call_arguments.delta` 本身不带工具名，name 来自更早的 output_item.added。 */
  readonly #names = new Map<string, string>();
  #nextToolCallIndex = 0;
  #sawToolCall = false;

  constructor(id: string, model: string, createdAt: number) {
    this.#id = id;
    this.#model = model;
    this.#createdAt = createdAt;
  }

  get hasToolCalls(): boolean {
    return this.#sawToolCall;
  }

  /** 首个 chunk：只带 role，与 OpenAI 真实流式行为一致。 */
  start(): Record<string, unknown> {
    return this.#chunk({ role: 'assistant' }, null);
  }

  /** 把一个 Responses SSE 事件翻译成 0 或 1 个 chat chunk。 */
  translate(event: SseEvent): Record<string, unknown> | null {
    switch (event.event) {
      case 'response.output_item.added': {
        // function_call 项一开始就带完整的工具名，但 arguments 增量事件本身不带名字，
        // 这里先记下来，供后面翻译 function_call_arguments.delta 时拼出首个 chunk
        const item = event.data.item as { type?: string; call_id?: string; name?: string } | undefined;
        if (item?.type === 'function_call' && typeof item.call_id === 'string' && typeof item.name === 'string') {
          this.#names.set(item.call_id, item.name);
        }
        return null;
      }

      case 'response.output_text.delta':
        return this.#chunk({ content: event.data.delta }, null);

      case 'response.function_call_arguments.delta': {
        this.#sawToolCall = true;
        const callId = event.data.call_id as string;
        let index = this.#toolCallIndex.get(callId);
        const isFirst = index === undefined;
        if (index === undefined) {
          index = this.#nextToolCallIndex++;
          this.#toolCallIndex.set(callId, index);
        }
        const toolCallDelta: Record<string, unknown> = { index, function: { arguments: event.data.delta } };
        if (isFirst) {
          toolCallDelta.id = callId;
          toolCallDelta.type = 'function';
          (toolCallDelta.function as Record<string, unknown>).name = this.#functionName(event) ?? '';
        }
        return this.#chunk({ tool_calls: [toolCallDelta] }, null);
      }

      case 'response.completed':
      case 'response.incomplete':
      case 'response.failed': {
        const status = (event.data.response as { status?: ResponseStatus } | undefined)?.status ?? 'completed';
        return this.#chunk({}, mapFinishReason(status, this.#sawToolCall));
      }

      default:
        return null;
    }
  }

  #functionName(event: SseEvent): string | undefined {
    const callId = event.data.call_id as string;
    return this.#names.get(callId);
  }

  #chunk(delta: Record<string, unknown>, finishReason: string | null): Record<string, unknown> {
    return {
      id: this.#id,
      object: 'chat.completion.chunk',
      created: this.#createdAt,
      model: this.#model,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    };
  }
}
