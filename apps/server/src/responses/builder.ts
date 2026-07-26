import { randomBytes } from 'node:crypto';
import type { UpstreamEvent } from '../adapter/protocol.js';
import {
  SSE_EVENTS,
  type OutputItem,
  type ResponseObject,
  type SseEvent,
  type UrlCitationAnnotation,
} from './types.js';

/**
 * Responses 状态机：把上游归一化事件流翻译成 OpenAI Responses 的 SSE 事件。
 *
 * 保证（对应实施计划 §4.3 DoD）：
 * - 每个事件带单调递增的 `sequence_number`；
 * - 事件顺序正确：item added → content part added → deltas → part done → item done → completed；
 * - reasoning 摘要项在 message 项之前；
 * - `response_id` 全程稳定。
 *
 * M4 只处理文本 + reasoning 摘要 + 引用（annotation）。工具调用事件的词汇表已在
 * types 里定义，实际产生留给 M5。
 */

interface ReasoningState {
  id: string;
  index: number;
  text: string;
  done: boolean;
}

interface MessageState {
  id: string;
  index: number;
  text: string;
  annotations: UrlCitationAnnotation[];
  contentPartAdded: boolean;
  done: boolean;
}

interface FunctionCallState {
  id: string;
  callId: string;
  name: string;
  arguments: string;
  index: number;
}

export interface BuilderInit {
  responseId: string;
  model: string;
  previousResponseId: string | null;
  metadata: Record<string, string> | null;
  reasoningEffort: string | null;
  maxOutputTokens: number | null;
  temperature: number | null;
  createdAt: number;
}

export class ResponseStreamBuilder {
  readonly #response: ResponseObject;
  #seq = 0;
  #outputIndex = 0;
  #reasoning: ReasoningState | null = null;
  #message: MessageState | null = null;
  readonly #functionCalls: FunctionCallState[] = [];
  #failed = false;

  constructor(init: BuilderInit) {
    this.#response = {
      id: init.responseId,
      object: 'response',
      created_at: Math.floor(init.createdAt / 1000),
      status: 'queued',
      model: init.model,
      output: [],
      usage: null,
      metadata: init.metadata,
      previous_response_id: init.previousResponseId,
      reasoning: init.reasoningEffort === null ? null : { effort: init.reasoningEffort },
      max_output_tokens: init.maxOutputTokens,
      temperature: init.temperature,
      error: null,
      incomplete_details: null,
    };
  }

  get responseId(): string {
    return this.#response.id;
  }

  /** 当前累积的助手文本（供非流式响应与持久化）。 */
  get accumulatedText(): string {
    return this.#message?.text ?? '';
  }

  /** 返回当前 Response 对象快照（深拷贝，避免外部改动内部状态）。 */
  snapshot(): ResponseObject {
    return structuredClone({ ...this.#response, output: this.#buildOutput() });
  }

  /** 开始：response.created + response.in_progress。 */
  begin(): SseEvent[] {
    this.#response.status = 'in_progress';
    return [this.#event(SSE_EVENTS.CREATED, {}), this.#event(SSE_EVENTS.IN_PROGRESS, {})];
  }

  /** 消费一个上游事件，产出零或多个 SSE 事件。 */
  consume(event: UpstreamEvent): SseEvent[] {
    switch (event.kind) {
      case 'reasoning_delta':
        return this.#onReasoningDelta(event.text);
      case 'text_delta':
        return this.#onTextDelta(event.text);
      case 'citation':
        return this.#onCitation(event.url, event.title);
      case 'upstream_error':
        // 流内的不可重试错误：记录，最终以 failed 收尾
        if (!event.retryable) {
          this.#failed = true;
          this.#response.error = { code: 'upstream_error', message: event.message };
        }
        return [];
      case 'tool_call_begin':
      case 'tool_call_args_delta':
      case 'tool_call_end':
        // 工具调用由服务层缓冲、校验/修复后再经 emitFunctionCall 发出，
        // 不直接经 consume（这样才能在发给客户端前做参数校验）
        return [];
      case 'completed':
      case 'raw':
        return [];
    }
  }

  /**
   * 发出一次已校验的工具调用（function_call）。
   * 在 message 之后作为独立 output 项，带完整参数的 delta + done。
   * 由服务层在参数校验/修复通过后调用。
   */
  emitFunctionCall(callId: string, name: string, argumentsJson: string): SseEvent[] {
    const events: SseEvent[] = [];
    // 先收尾可能开着的 reasoning / message
    events.push(...this.#closeReasoning());
    events.push(...this.#closeMessage());

    const state: FunctionCallState = {
      id: makeId('fc'),
      callId,
      name,
      arguments: argumentsJson,
      index: this.#outputIndex++,
    };
    this.#functionCalls.push(state);

    events.push(
      this.#event(SSE_EVENTS.OUTPUT_ITEM_ADDED, {
        output_index: state.index,
        item: {
          id: state.id,
          type: 'function_call',
          call_id: state.callId,
          name: state.name,
          arguments: '',
          status: 'in_progress',
        },
      }),
    );
    events.push(
      this.#event(SSE_EVENTS.FUNCTION_CALL_ARGS_DELTA, {
        item_id: state.id,
        output_index: state.index,
        call_id: state.callId,
        delta: argumentsJson,
      }),
    );
    events.push(
      this.#event(SSE_EVENTS.FUNCTION_CALL_ARGS_DONE, {
        item_id: state.id,
        output_index: state.index,
        call_id: state.callId,
        arguments: argumentsJson,
      }),
    );
    events.push(
      this.#event(SSE_EVENTS.OUTPUT_ITEM_DONE, {
        output_index: state.index,
        item: this.#functionCallItem(state),
      }),
    );
    return events;
  }

  /** 正常收尾：关闭已开项 + response.completed。 */
  finish(): SseEvent[] {
    if (this.#failed) {
      return this.fail(this.#response.error?.message ?? '上游返回错误');
    }
    const events: SseEvent[] = [];
    events.push(...this.#closeReasoning());
    // 没有文本、也没有工具调用时，才补一个空 message 保持 output 非空；
    // 有工具调用时 output 已非空，不强塞空 message
    if (this.#message === null && this.#functionCalls.length === 0) {
      events.push(...this.#openMessage());
    }
    events.push(...this.#closeMessage());
    this.#response.status = 'completed';
    events.push(this.#event(SSE_EVENTS.COMPLETED, {}));
    return events;
  }

  /** 失败收尾：response.failed。 */
  fail(message: string, code = 'upstream_error'): SseEvent[] {
    this.#response.status = 'failed';
    this.#response.error = { code, message };
    return [this.#event(SSE_EVENTS.FAILED, {})];
  }

  /** 客户端取消收尾。 */
  cancel(): SseEvent[] {
    this.#response.status = 'cancelled';
    this.#response.incomplete_details = { reason: 'cancelled' };
    return [this.#event(SSE_EVENTS.INCOMPLETE, {})];
  }

  // ---- 内部 ----

  #onReasoningDelta(text: string): SseEvent[] {
    const events: SseEvent[] = [];
    if (this.#reasoning === null) {
      this.#reasoning = { id: makeId('rs'), index: this.#outputIndex++, text: '', done: false };
      events.push(
        this.#event(SSE_EVENTS.OUTPUT_ITEM_ADDED, {
          output_index: this.#reasoning.index,
          item: { id: this.#reasoning.id, type: 'reasoning', summary: [] },
        }),
      );
    }
    this.#reasoning.text += text;
    events.push(
      this.#event(SSE_EVENTS.REASONING_SUMMARY_DELTA, {
        item_id: this.#reasoning.id,
        output_index: this.#reasoning.index,
        summary_index: 0,
        delta: text,
      }),
    );
    return events;
  }

  #onTextDelta(text: string): SseEvent[] {
    const events: SseEvent[] = [];
    events.push(...this.#closeReasoning());
    if (this.#message === null) {
      events.push(...this.#openMessage());
    }
    const message = this.#message as MessageState;
    message.text += text;
    events.push(
      this.#event(SSE_EVENTS.OUTPUT_TEXT_DELTA, {
        item_id: message.id,
        output_index: message.index,
        content_index: 0,
        delta: text,
      }),
    );
    return events;
  }

  #onCitation(url: string, title: string | null): SseEvent[] {
    const events: SseEvent[] = [];
    if (this.#message === null) {
      events.push(...this.#openMessage());
    }
    const message = this.#message as MessageState;
    const annotation: UrlCitationAnnotation = {
      type: 'url_citation',
      url,
      title,
      // M4 暂以当前文本长度作为锚点；精确区间待上游能力校准
      start_index: message.text.length,
      end_index: message.text.length,
    };
    message.annotations.push(annotation);
    events.push(
      this.#event(SSE_EVENTS.OUTPUT_TEXT_ANNOTATION_ADDED, {
        item_id: message.id,
        output_index: message.index,
        content_index: 0,
        annotation_index: message.annotations.length - 1,
        annotation,
      }),
    );
    return events;
  }

  #openMessage(): SseEvent[] {
    this.#message = {
      id: makeId('msg'),
      index: this.#outputIndex++,
      text: '',
      annotations: [],
      contentPartAdded: false,
      done: false,
    };
    const events: SseEvent[] = [
      this.#event(SSE_EVENTS.OUTPUT_ITEM_ADDED, {
        output_index: this.#message.index,
        item: {
          id: this.#message.id,
          type: 'message',
          role: 'assistant',
          status: 'in_progress',
          content: [],
        },
      }),
      this.#event(SSE_EVENTS.CONTENT_PART_ADDED, {
        item_id: this.#message.id,
        output_index: this.#message.index,
        content_index: 0,
        part: { type: 'output_text', text: '', annotations: [] },
      }),
    ];
    this.#message.contentPartAdded = true;
    return events;
  }

  #closeMessage(): SseEvent[] {
    if (this.#message === null || this.#message.done) return [];
    const message = this.#message;
    message.done = true;
    return [
      this.#event(SSE_EVENTS.OUTPUT_TEXT_DONE, {
        item_id: message.id,
        output_index: message.index,
        content_index: 0,
        text: message.text,
      }),
      this.#event(SSE_EVENTS.CONTENT_PART_DONE, {
        item_id: message.id,
        output_index: message.index,
        content_index: 0,
        part: { type: 'output_text', text: message.text, annotations: message.annotations },
      }),
      this.#event(SSE_EVENTS.OUTPUT_ITEM_DONE, {
        output_index: message.index,
        item: this.#messageItem(message, 'completed'),
      }),
    ];
  }

  #closeReasoning(): SseEvent[] {
    if (this.#reasoning === null || this.#reasoning.done) return [];
    const reasoning = this.#reasoning;
    reasoning.done = true;
    return [
      this.#event(SSE_EVENTS.REASONING_SUMMARY_DONE, {
        item_id: reasoning.id,
        output_index: reasoning.index,
        summary_index: 0,
        text: reasoning.text,
      }),
      this.#event(SSE_EVENTS.OUTPUT_ITEM_DONE, {
        output_index: reasoning.index,
        item: { id: reasoning.id, type: 'reasoning', summary: [{ type: 'summary_text', text: reasoning.text }] },
      }),
    ];
  }

  #messageItem(message: MessageState, status: 'in_progress' | 'completed'): OutputItem {
    return {
      id: message.id,
      type: 'message',
      role: 'assistant',
      status,
      content: [{ type: 'output_text', text: message.text, annotations: message.annotations }],
    };
  }

  #functionCallItem(state: FunctionCallState): OutputItem {
    return {
      id: state.id,
      type: 'function_call',
      call_id: state.callId,
      name: state.name,
      arguments: state.arguments,
      status: 'completed',
    };
  }

  #buildOutput(): OutputItem[] {
    const output: OutputItem[] = [];
    if (this.#reasoning !== null) {
      output.push({
        id: this.#reasoning.id,
        type: 'reasoning',
        summary: this.#reasoning.text === '' ? [] : [{ type: 'summary_text', text: this.#reasoning.text }],
      });
    }
    if (this.#message !== null) {
      output.push(this.#messageItem(this.#message, this.#message.done ? 'completed' : 'in_progress'));
    }
    for (const call of this.#functionCalls) {
      output.push(this.#functionCallItem(call));
    }
    return output;
  }

  /** 组装一个带单调 sequence_number 与 response_id 的 SSE 事件。 */
  #event(name: SseEvent['event'], data: Record<string, unknown>): SseEvent {
    const payload: Record<string, unknown> = {
      ...data,
      sequence_number: this.#seq++,
      response_id: this.#response.id,
    };
    // created / in_progress / completed / failed / incomplete 携带完整 response 快照
    if (
      name === SSE_EVENTS.CREATED ||
      name === SSE_EVENTS.IN_PROGRESS ||
      name === SSE_EVENTS.QUEUED ||
      name === SSE_EVENTS.COMPLETED ||
      name === SSE_EVENTS.FAILED ||
      name === SSE_EVENTS.INCOMPLETE
    ) {
      payload.response = { ...this.#response, output: this.#buildOutput() };
    }
    return { event: name, data: payload };
  }
}

function makeId(prefix: string): string {
  return `${prefix}_${randomBytes(12).toString('hex')}`;
}
