import { ApiError } from '@m365-codex/shared';
import { z } from 'zod';

/**
 * Responses 请求校验（对应实施计划 §4.2）。
 *
 * 护栏要点：
 * - `model` 与 `reasoning.effort` 只透传、不枚举取值、不改写；
 * - 影响语义又无法在 M4 实现的内容（图片/文件输入、工具执行）必须返回清晰错误，
 *   不得静默伪装生效。图片/文件是 M6，工具代理循环是 M5。
 */

const inputTextPart = z.object({
  type: z.literal('input_text'),
  text: z.string(),
});

const inputImagePart = z.object({ type: z.literal('input_image') }).passthrough();
const inputFilePart = z.object({ type: z.literal('input_file') }).passthrough();

const contentPart = z.union([inputTextPart, inputImagePart, inputFilePart]);

const inputMessage = z.object({
  type: z.literal('message').optional(),
  role: z.enum(['user', 'assistant', 'system', 'developer']),
  content: z.union([z.string(), z.array(contentPart)]),
});

const functionCallOutput = z.object({
  type: z.literal('function_call_output'),
  call_id: z.string(),
  output: z.string(),
});

/** input 项：消息或工具输出。 */
const inputItem = z.union([inputMessage, functionCallOutput]);

const reasoningSchema = z
  .object({
    // effort 合法值随模型而定（none/minimal/low/medium/high/xhigh/max…），不在此枚举
    effort: z.string().optional(),
    summary: z.string().optional(),
  })
  .passthrough();

export const responsesRequestSchema = z
  .object({
    model: z.string().min(1, 'model 不能为空'),
    input: z.union([z.string(), z.array(inputItem)]),
    instructions: z.string().optional(),
    stream: z.boolean().optional().default(false),
    tools: z.array(z.unknown()).optional(),
    tool_choice: z.unknown().optional(),
    parallel_tool_calls: z.boolean().optional(),
    previous_response_id: z.string().optional(),
    metadata: z.record(z.string()).optional(),
    max_output_tokens: z.number().int().positive().optional(),
    temperature: z.number().min(0).max(2).optional(),
    reasoning: reasoningSchema.optional(),
    store: z.boolean().optional(),
  })
  .passthrough();

export type ResponsesRequest = z.infer<typeof responsesRequestSchema>;

export function parseResponsesRequest(payload: unknown): ResponsesRequest {
  const result = responsesRequestSchema.safeParse(payload);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw ApiError.badRequest(issue?.message ?? '请求体不合法', issue?.path.join('.') || undefined);
  }
  return result.data;
}

export interface ExtractedInput {
  /** 拼接后的用户文本 */
  text: string;
  /** instructions（系统指令），若有 */
  instructions: string | null;
  /** 是否包含工具输出（M5 才能真正处理） */
  hasFunctionCallOutput: boolean;
}

/**
 * 从 input 中提取纯文本。
 * M4 只支持文本；遇到图片/文件输入返回 unsupported_feature（M6），
 * 遇到工具输出返回 unsupported_feature（M5）——都明确报错，不静默丢弃。
 */
export function extractInputText(request: ResponsesRequest): ExtractedInput {
  const instructions = request.instructions ?? null;

  if (typeof request.input === 'string') {
    return { text: request.input, instructions, hasFunctionCallOutput: false };
  }

  const segments: string[] = [];
  for (const item of request.input) {
    if ('type' in item && item.type === 'function_call_output') {
      throw new ApiError({
        type: 'unsupported_feature',
        status: 422,
        message: '工具调用结果回传（function_call_output）将在 M5 支持',
        param: 'input',
      });
    }

    const message = item;
    if (typeof message.content === 'string') {
      if (message.role !== 'assistant') segments.push(message.content);
      continue;
    }
    for (const part of message.content) {
      if (part.type === 'input_text') {
        segments.push(part.text);
      } else if (part.type === 'input_image' || part.type === 'input_file') {
        throw new ApiError({
          type: 'unsupported_feature',
          status: 422,
          message: `内容类型 ${part.type} 将在 M6（文件/图片）支持`,
          param: 'input',
        });
      }
    }
  }

  return { text: segments.join('\n\n'), instructions, hasFunctionCallOutput: false };
}

/**
 * 组装透传给上游的参数。
 * model 与 reasoning 原样带上，绝不改写、不枚举、不造别名。
 */
export function buildPassthrough(request: ResponsesRequest): Record<string, unknown> {
  const passthrough: Record<string, unknown> = { model: request.model };
  if (request.reasoning !== undefined) passthrough.reasoning = request.reasoning;
  if (request.temperature !== undefined) passthrough.temperature = request.temperature;
  if (request.max_output_tokens !== undefined) passthrough.max_output_tokens = request.max_output_tokens;
  return passthrough;
}

/** 取出 reasoning.effort 用于记录（不改写、不校验取值）。 */
export function extractReasoningEffort(request: ResponsesRequest): string | null {
  const effort = request.reasoning?.effort;
  return typeof effort === 'string' ? effort : null;
}
