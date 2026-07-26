import { ApiError } from '@m365-codex/shared';
import { z } from 'zod';

/**
 * Responses 请求校验（对应实施计划 §4.2）。
 *
 * 护栏要点：
 * - `model` 与 `reasoning.effort` 只透传、不枚举取值、不改写；
 * - 影响语义又无法实现的内容必须返回清晰错误，不得静默伪装生效：
 *   `input_file` 按 file_id 取本网关已提取的文本；`input_image` 是否放行取决于
 *   `UPSTREAM_IMAGE_INPUT`（真实上游能力要等 M0 探针校准，默认不假装支持）。
 * - Codex 等 `store:false` 的客户端每轮会把**整段对话历史**塞进 `input`（见
 *   `extractInputText` 顶部的详细说明），因此 `input` 里除了 message /
 *   function_call_output，还会出现 function_call、reasoning 等历史回放项，
 *   以及未来版本可能新增的、我们还不认识的项类型——都不应该让整轮请求 400。
 */

const inputTextPart = z.object({
  type: z.literal('input_text'),
  text: z.string(),
});

// assistant 历史消息用 output_text 承载文本（区别于用户侧的 input_text）。
const outputTextPart = z.object({ type: z.literal('output_text'), text: z.string() }).passthrough();

const inputImagePart = z
  .object({
    type: z.literal('input_image'),
    image_url: z.string().optional(),
    file_id: z.string().optional(),
    detail: z.string().optional(),
  })
  .passthrough();

const inputFilePart = z
  .object({
    type: z.literal('input_file'),
    file_id: z.string({ required_error: 'input_file 必须提供 file_id' }),
  })
  .passthrough();

// 未识别的内容片段类型：客户端会演进出新的 part 形态，认不出就跳过该片段，
// 不能让整轮请求因为多了一个陌生的 content part 就失败。
const unknownContentPart = z.object({ type: z.string() }).passthrough();

const contentPart = z.union([inputTextPart, outputTextPart, inputImagePart, inputFilePart, unknownContentPart]);

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

/**
 * 模型上一轮工具调用的回放（`store:false` 时 Codex 会把整段历史随每轮重发）。
 * 真实抓包只带 type/call_id/name/arguments 四个键、没有 id/status；这里仍标成
 * 可选，避免未来版本增减字段就解析失败。
 */
const functionCallReplay = z
  .object({
    type: z.literal('function_call'),
    call_id: z.string().optional(),
    name: z.string().optional(),
    arguments: z.string().optional(),
  })
  .passthrough();

/** 思考摘要回放；summary/encrypted_content 对上游不透明，只识别，不进入重建的上下文文本。 */
const reasoningReplay = z.object({ type: z.literal('reasoning') }).passthrough();

/**
 * 真正认不出的历史项类型：Codex 等客户端会持续演进，不能因为多了一个没见过的
 * 类型就把整轮请求判 400。跳过并记录类型交给上层（持有 logger）记一条 warn；
 * 用户可见内容类型（input_text/input_image/input_file）不受影响，该报的错照样报。
 */
const unknownItem = z.object({ type: z.string() }).passthrough();

/** input 项：消息、工具输出、或历史回放/未知项。 */
const inputItem = z.union([inputMessage, functionCallOutput, functionCallReplay, reasoningReplay, unknownItem]);

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
  // include / prompt_cache_key / client_metadata 等 Codex 会发的字段没有专门建模，
  // 全靠这里的 passthrough 放行——只记录、不解释、不因为不认识就拒绝请求。
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

export interface ToolResult {
  callId: string;
  output: string;
}

/** input_image 收集到的图片，透传给上游前的中间形态（对应实施计划 §M6）。 */
export interface ExtractedImage {
  /** URL 或 data URL（file_id 引用会在这里解析成 data URL） */
  url: string;
  detail: string | null;
}

export interface ExtractedInput {
  /** 按对话顺序重建出的、带角色标注的完整上下文文本（见下方大段说明） */
  text: string;
  /** instructions（系统指令），若有；已经作为开头的系统段落合入 text */
  instructions: string | null;
  /** 工具执行结果回传（M5，续接时携带） */
  toolResults: ToolResult[];
  /** 图片输入（仅 UPSTREAM_IMAGE_INPUT=true 时才会非空，见 §M6） */
  images: ExtractedImage[];
  /** 因版本演进等原因被跳过的历史项类型（去重后），供调用方记一条 warn 日志 */
  skippedItemTypes: string[];
  /** 因超过上下文字符上限、从最旧历史截断掉的字符数；0 表示未截断 */
  truncatedChars: number;
}

/** `input_file` / `input_image` 里 `file_id` 引用的解析接口，由 Files 子系统实现。 */
export interface FilesLookup {
  /** 按 file-id 取已提取的文本；不存在/不属于当前 Key/未提取到文本一律返回 null。 */
  resolveText(fileId: string): { filename: string; text: string } | null;
  /** 按 file-id 取原始内容并转成 data URL；不存在/不属于当前 Key/非图片一律返回 null。 */
  resolveImageDataUrl(fileId: string): { dataUrl: string; filename: string } | null;
}

export interface ExtractInputDeps {
  files?: FilesLookup;
  /** 上游是否真支持图片输入，来自 UPSTREAM_IMAGE_INPUT（默认 false，见 §M6） */
  imageInputEnabled?: boolean;
  /** 重建出的上下文文本超过多少字符就从最旧历史开始截断；默认给一个宽松值 */
  contextMaxChars?: number;
}

/** 宽松默认值：留足空间给 Codex 这类会发几万字符系统指令的客户端。 */
export const DEFAULT_CONTEXT_MAX_CHARS = 400_000;

/** 一段重建出的对话轮次：角色/工具标签 + 该轮文本。 */
export interface ConversationTurn {
  label: string;
  text: string;
}

export interface BuildConversationTextResult {
  text: string;
  /** 因超限被丢弃的字符数；0 表示未截断 */
  truncatedChars: number;
}

const TURN_SEPARATOR = '\n\n';

/**
 * 把「系统指令 + 若干对话轮次」拼成一段文本，超出 `maxChars` 时从最旧的历史
 * （数组靠前的轮次）开始丢弃，直到放得下为止；系统段永远保留，且至少保留
 * 最后一轮（否则本轮真正要处理的内容会被截没）。
 *
 * 单独成一个纯函数是为了方便直接单测截断边界，不用每次都拼一个完整请求。
 */
export function buildConversationText(
  instructionsText: string | null,
  turns: readonly ConversationTurn[],
  maxChars: number,
): BuildConversationTextResult {
  const head = instructionsText !== null && instructionsText !== '' ? [`【系统指令】\n${instructionsText}`] : [];
  const turnSegments = turns.map((turn) => `${turn.label}\n${turn.text}`);

  const assemble = (segments: readonly string[]): string => segments.join(TURN_SEPARATOR);

  let kept = turnSegments;
  let full = assemble([...head, ...kept]);
  const originalLength = full.length;

  while (full.length > maxChars && kept.length > 1) {
    kept = kept.slice(1); // 丢最旧的一轮（数组靠前 = 更早发生）
    full = assemble([...head, ...kept]);
  }

  return { text: full, truncatedChars: originalLength - full.length };
}

function roleLabel(role: 'user' | 'assistant' | 'system' | 'developer'): string {
  switch (role) {
    case 'user':
      return '【用户】';
    case 'assistant':
      return '【助手】';
    case 'developer':
      return '【开发者指令】';
    case 'system':
      return '【系统消息】';
  }
}

interface MessageLike {
  role: 'user' | 'assistant' | 'system' | 'developer';
  content: string | { type: string; [key: string]: unknown }[];
}

/** 从一条消息里抽出纯文本（多个 content part 用换行拼接）与图片。 */
function extractMessageContent(
  message: MessageLike,
  deps: ExtractInputDeps,
): { text: string; images: ExtractedImage[] } {
  if (typeof message.content === 'string') {
    return { text: message.content, images: [] };
  }

  const images: ExtractedImage[] = [];
  const fragments: string[] = [];
  for (const part of message.content) {
    if (part.type === 'input_text' || part.type === 'output_text') {
      fragments.push(typeof part.text === 'string' ? part.text : '');
    } else if (part.type === 'input_file') {
      fragments.push(resolveInputFile(part.file_id as string, deps));
    } else if (part.type === 'input_image') {
      const image = resolveInputImage(
        part as { image_url?: string; file_id?: string; detail?: string },
        deps,
      );
      if (image !== null) images.push(image);
    }
    // 其余未识别的 part 类型：跳过，不参与文本拼装，不整轮报错
  }
  return { text: fragments.join('\n'), images };
}

/**
 * 从 input 重建完整对话上下文（对应实施计划 §M3「切账号用本地内容重建上下文」
 * 的自然延伸，见 §M6 补充需求）。
 *
 * **为什么要重建整段历史，而不是只取本轮新增文本**：Codex 等客户端在
 * `store:false` 时不带 `previous_response_id`，每轮都把整段对话历史随
 * `input` 重发；本网关这一侧若只挑出"新增的用户文本"发给上游，等于每轮都是
 * 一次全新、失忆的对话——多轮完全不可用。因此这里按 input 数组顺序，把
 * developer/system 指令、user 发言、assistant 回复、工具调用与工具结果全部
 * 转成带角色标注的文本轮次，`instructions` 作为开头的系统段落，一并拼成发给
 * 上游的正文。
 *
 * **各类 item 的处理**：
 * - `function_call_output`：既计入 `toolResults`（供 M5 工具循环走结构化通道），
 *   也作为一轮"【工具结果】"文本进上下文，保证上游即使不认那条结构化通道也能
 *   从文本里看到结果；
 * - `function_call`：模型上一轮的工具调用意图回放，转成"【工具 X 的调用】"；
 * - `reasoning`：思考摘要回放，内容对上游不透明或无意义，不进入上下文文本
 *   （静默跳过，不是"静默伪装"——伪装指假装做了某事但其实没做，这里只是准确
 *   地判定它不代表可用文本）；
 * - 无法识别的 item 类型：不整轮 400，跳过并记录类型，交给调用方（持有
 *   logger）记一条 warn；用户可见内容类型该报错的仍然报错。
 *
 * 超过 `contextMaxChars` 时从最旧历史开始截断，见 `buildConversationText`。
 */
export function extractInputText(request: ResponsesRequest, deps: ExtractInputDeps = {}): ExtractedInput {
  const instructions = request.instructions ?? null;
  const maxChars = deps.contextMaxChars ?? DEFAULT_CONTEXT_MAX_CHARS;

  if (typeof request.input === 'string') {
    const turns: ConversationTurn[] = request.input === '' ? [] : [{ label: '【用户】', text: request.input }];
    const { text, truncatedChars } = buildConversationText(instructions, turns, maxChars);
    return { text, instructions, toolResults: [], images: [], skippedItemTypes: [], truncatedChars };
  }

  const toolResults: ToolResult[] = [];
  const images: ExtractedImage[] = [];
  const skippedItemTypes: string[] = [];
  const turns: ConversationTurn[] = [];

  for (const item of request.input) {
    // 注：`unknownItem` 分支的 `type` 字段类型是通用 `string`（不是字面量），
    // 会让 TS 没法仅凭 `item.type === '字面量'` 排除掉它，导致同名字段被推断成
    // `unknown`。运行时判断已经足够可靠（zod 已校验过整体形状），这里按确认过
    // 的具体形状显式转换，而不是放宽字段类型让错误悄悄溜过去。
    if ('type' in item && item.type === 'function_call_output') {
      const output = item as z.infer<typeof functionCallOutput>;
      toolResults.push({ callId: output.call_id, output: output.output });
      turns.push({ label: '【工具结果】', text: output.output });
      continue;
    }

    if ('type' in item && item.type === 'function_call') {
      const call = item as z.infer<typeof functionCallReplay>;
      const name = call.name ?? '(未知工具)';
      turns.push({ label: `【工具 ${name} 的调用】`, text: call.arguments ?? '{}' });
      continue;
    }

    if ('type' in item && item.type === 'reasoning') {
      continue; // 思考摘要回放：不进入重建的上下文文本
    }

    if ('type' in item && item.type !== 'message') {
      // 走到这里必是未识别的历史项类型：不是我们认识的任何一种，也不是隐式 message
      skippedItemTypes.push(String(item.type));
      continue;
    }

    const message = item as MessageLike;
    const extracted = extractMessageContent(message, deps);
    images.push(...extracted.images);
    if (extracted.text !== '') {
      turns.push({ label: roleLabel(message.role), text: extracted.text });
    }
  }

  const { text, truncatedChars } = buildConversationText(instructions, turns, maxChars);
  return {
    text,
    instructions,
    toolResults,
    images,
    skippedItemTypes: [...new Set(skippedItemTypes)],
    truncatedChars,
  };
}

function resolveInputFile(fileId: string, deps: ExtractInputDeps): string {
  const resolved = deps.files?.resolveText(fileId) ?? null;
  if (resolved === null) {
    throw new ApiError({
      type: 'invalid_request_error',
      status: 404,
      message: `input_file 引用的文件 ${fileId} 不存在、不属于当前 API Key，或未提取到可用文本`,
      param: 'input',
    });
  }
  return `[文件: ${resolved.filename}]\n${resolved.text}`;
}

function resolveInputImage(
  part: { image_url?: string; file_id?: string; detail?: string },
  deps: ExtractInputDeps,
): ExtractedImage | null {
  if (deps.imageInputEnabled !== true) {
    throw new ApiError({
      type: 'unsupported_feature',
      status: 422,
      message:
        '图片输入当前未启用（UPSTREAM_IMAGE_INPUT=false）：上游是否真支持图片输入待 M0 探针校准，默认不假装支持',
      param: 'input',
    });
  }

  const detail = typeof part.detail === 'string' ? part.detail : null;
  if (typeof part.image_url === 'string' && part.image_url !== '') {
    return { url: part.image_url, detail };
  }
  if (typeof part.file_id === 'string' && part.file_id !== '') {
    const resolved = deps.files?.resolveImageDataUrl(part.file_id) ?? null;
    if (resolved === null) {
      throw new ApiError({
        type: 'invalid_request_error',
        status: 404,
        message: `input_image 引用的文件 ${part.file_id} 不存在、不属于当前 API Key，或不是图片类型`,
        param: 'input',
      });
    }
    return { url: resolved.dataUrl, detail };
  }
  throw ApiError.badRequest('input_image 必须提供 image_url 或 file_id', 'input');
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
