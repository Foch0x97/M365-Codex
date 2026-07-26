import type { ResponseStatus } from '@m365-codex/shared';

/**
 * OpenAI Responses 协议的对象形态（M4 文本子集）。
 * 工具调用项（function_call）在 M5 补充；图片/文件在 M6。
 */

export interface UrlCitationAnnotation {
  type: 'url_citation';
  url: string;
  title: string | null;
  start_index: number;
  end_index: number;
}

export interface OutputTextContent {
  type: 'output_text';
  text: string;
  annotations: UrlCitationAnnotation[];
}

export interface MessageOutputItem {
  id: string;
  type: 'message';
  role: 'assistant';
  status: 'in_progress' | 'completed';
  content: OutputTextContent[];
}

export interface ReasoningSummaryText {
  type: 'summary_text';
  text: string;
}

export interface ReasoningOutputItem {
  id: string;
  type: 'reasoning';
  summary: ReasoningSummaryText[];
}

export type OutputItem = ReasoningOutputItem | MessageOutputItem;

export interface ResponseError {
  code: string;
  message: string;
}

export interface ResponseObject {
  id: string;
  object: 'response';
  /** 秒级 epoch，与 OpenAI 对齐 */
  created_at: number;
  status: ResponseStatus;
  /** 回显客户端请求的 model（容器不改写） */
  model: string;
  output: OutputItem[];
  /** M4 暂不提供精确用量（取决于 M0 探测），先给 null */
  usage: null;
  metadata: Record<string, string> | null;
  previous_response_id: string | null;
  reasoning: { effort: string | null } | null;
  max_output_tokens: number | null;
  temperature: number | null;
  error: ResponseError | null;
  incomplete_details: { reason: string } | null;
}

/** SSE 事件名（对应实施计划 §4.3，至少实现这些）。 */
export const SSE_EVENTS = {
  CREATED: 'response.created',
  QUEUED: 'response.queued',
  IN_PROGRESS: 'response.in_progress',
  OUTPUT_ITEM_ADDED: 'response.output_item.added',
  OUTPUT_ITEM_DONE: 'response.output_item.done',
  CONTENT_PART_ADDED: 'response.content_part.added',
  CONTENT_PART_DONE: 'response.content_part.done',
  OUTPUT_TEXT_DELTA: 'response.output_text.delta',
  OUTPUT_TEXT_DONE: 'response.output_text.done',
  OUTPUT_TEXT_ANNOTATION_ADDED: 'response.output_text.annotation.added',
  REASONING_SUMMARY_DELTA: 'response.reasoning_summary_text.delta',
  REASONING_SUMMARY_DONE: 'response.reasoning_summary_text.done',
  FUNCTION_CALL_ARGS_DELTA: 'response.function_call_arguments.delta',
  FUNCTION_CALL_ARGS_DONE: 'response.function_call_arguments.done',
  REFUSAL_DELTA: 'response.refusal.delta',
  REFUSAL_DONE: 'response.refusal.done',
  COMPLETED: 'response.completed',
  INCOMPLETE: 'response.incomplete',
  FAILED: 'response.failed',
  ERROR: 'error',
} as const;

export type SseEventName = (typeof SSE_EVENTS)[keyof typeof SSE_EVENTS];

/** 一条 SSE 事件：名称 + 数据对象。数据里均带单调 sequence_number。 */
export interface SseEvent {
  event: SseEventName;
  data: Record<string, unknown>;
}

/** 序列化为 SSE 线格式。 */
export function serializeSse(event: SseEvent): string {
  return `event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`;
}
