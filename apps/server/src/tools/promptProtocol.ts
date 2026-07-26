import { randomBytes } from 'node:crypto';
import type { UpstreamEvent } from '../adapter/protocol.js';
import type { ParsedTool } from './registry.js';

/**
 * 提示词模拟的工具协议（对应实施计划 §3.5、§7.2 第 3 步）。
 *
 * M0 探针尚未确认上游是否支持原生结构化工具调用，因此这里提供第二条路径：
 * 把工具目录与输出格式写进发给上游的文本，再从回流的正文里把
 * `<tool_call>{...}</tool_call>` 解析出来转成归一化事件。
 *
 * 关键约束（§7.3）：**工具 JSON 不得同时作为正文重复输出**——扫描器会把标记
 * 及其内容从文本流里剥离，客户端只会看到 function_call 项，不会再看到一份 JSON。
 */

export const TOOL_CALL_OPEN = '<tool_call>';
export const TOOL_CALL_CLOSE = '</tool_call>';

/** 构造交给上游的严格工具目录与输出约束。 */
export function buildToolInstruction(tools: readonly ParsedTool[]): string {
  if (tools.length === 0) return '';
  const catalog = tools
    .map((tool) => {
      const description = tool.description === null ? '' : `：${tool.description}`;
      const schema = tool.parameters === null ? '{}' : JSON.stringify(tool.parameters);
      return `- ${tool.name}${description}\n  参数 JSON Schema：${schema}`;
    })
    .join('\n');

  return [
    '你可以使用下列工具，且只能使用下列工具：',
    catalog,
    '',
    `需要调用工具时，严格输出：${TOOL_CALL_OPEN}{"name":"工具名","arguments":{…}}${TOOL_CALL_CLOSE}`,
    '要求：name 必须与上面列出的名字完全一致；arguments 必须是符合该工具 Schema 的 JSON 对象；',
    '同一次回答里每个工具调用只输出一次，不要在正文中复述工具调用的 JSON；',
    '不需要调用工具时正常回答，不要输出上述标记。',
  ].join('\n');
}

/** 生成一个 call_id。上游提示词模拟不会自带 id，由本网关分配（§7.3 唯一性）。 */
function makeCallId(): string {
  return `call_${randomBytes(12).toString('hex')}`;
}

export interface ScanResult {
  /** 剥离工具调用后剩下的、可以发给客户端的正文 */
  text: string;
  /** 从正文里解析出的工具调用事件 */
  events: UpstreamEvent[];
}

/**
 * 文本流扫描器：逐段吃进 text_delta，吐出「去掉工具调用后的正文」与工具事件。
 *
 * 流式下标记可能被切成两半（`<tool_` / `call>`），所以尾部要留住可能是开标记前缀的
 * 那几个字符，等下一段再判断，避免把半个标记当正文吐出去。
 */
export class PromptToolScanner {
  /** 尚未判定的文本（可能是开标记的前缀） */
  #pendingText = '';
  /** 已进入 <tool_call> 内部时累积的内容 */
  #inside: string | null = null;

  push(chunk: string): ScanResult {
    this.#pendingText += chunk;
    return this.#drain(false);
  }

  /** 流结束：把留住的尾巴放出来；未闭合的工具调用按普通文本处理（如实回吐）。 */
  flush(): ScanResult {
    const result = this.#drain(true);
    if (this.#inside !== null) {
      // 上游把标记开了没关：不猜测，原样交还正文
      result.text += TOOL_CALL_OPEN + this.#inside;
      this.#inside = null;
    }
    const tail = this.#pendingText;
    this.#pendingText = '';
    return { text: result.text + tail, events: result.events };
  }

  #drain(final: boolean): ScanResult {
    let text = '';
    const events: UpstreamEvent[] = [];

    for (;;) {
      if (this.#inside !== null) {
        const closeAt = this.#pendingText.indexOf(TOOL_CALL_CLOSE);
        if (closeAt < 0) {
          // 结束标记同样可能被切成两半，尾部留住可能的前缀再判
          const keep = final ? 0 : partialSuffixLength(this.#pendingText, TOOL_CALL_CLOSE);
          this.#inside += this.#pendingText.slice(0, this.#pendingText.length - keep);
          this.#pendingText = this.#pendingText.slice(this.#pendingText.length - keep);
          break;
        }
        const payload = this.#inside + this.#pendingText.slice(0, closeAt);
        this.#pendingText = this.#pendingText.slice(closeAt + TOOL_CALL_CLOSE.length);
        this.#inside = null;
        const parsed = parseToolCallPayload(payload);
        if (parsed === null) {
          // 解析不出来就不装作有工具调用，原样当正文返回（不静默丢内容）
          text += TOOL_CALL_OPEN + payload + TOOL_CALL_CLOSE;
        } else {
          events.push(...parsed);
        }
        continue;
      }

      const openAt = this.#pendingText.indexOf(TOOL_CALL_OPEN);
      if (openAt >= 0) {
        text += this.#pendingText.slice(0, openAt);
        this.#pendingText = this.#pendingText.slice(openAt + TOOL_CALL_OPEN.length);
        this.#inside = '';
        continue;
      }

      if (final) {
        break;
      }
      // 留住可能是开标记前缀的尾巴
      const keep = partialSuffixLength(this.#pendingText, TOOL_CALL_OPEN);
      text += this.#pendingText.slice(0, this.#pendingText.length - keep);
      this.#pendingText = this.#pendingText.slice(this.#pendingText.length - keep);
      break;
    }

    return { text, events };
  }
}

/** 文本尾部有多少个字符可能是 marker 的前缀（用于跨分片保留半个标记）。 */
function partialSuffixLength(text: string, marker: string): number {
  const max = Math.min(marker.length - 1, text.length);
  for (let len = max; len > 0; len -= 1) {
    if (text.endsWith(marker.slice(0, len))) return len;
  }
  return 0;
}

/** 把 `{"name":…,"arguments":…}` 转成 begin + args_delta + end 三个事件。 */
function parseToolCallPayload(payload: string): UpstreamEvent[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload.trim());
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;

  const record = parsed as Record<string, unknown>;
  const name = record.name;
  if (typeof name !== 'string' || name === '') return null;

  const rawArgs = record.arguments ?? record.parameters ?? {};
  const args = typeof rawArgs === 'string' ? rawArgs : JSON.stringify(rawArgs);
  // 上游自带 id 就沿用，便于同一调用在多帧间对齐；否则由本网关分配
  const callId = typeof record.call_id === 'string' && record.call_id !== '' ? record.call_id : makeCallId();

  return [
    { kind: 'tool_call_begin', callId, name },
    { kind: 'tool_call_args_delta', callId, delta: args },
    { kind: 'tool_call_end', callId },
  ];
}
