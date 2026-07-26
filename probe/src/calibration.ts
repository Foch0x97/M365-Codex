import type { CapabilityResult } from './types.js';
import { extractToolCallStats } from './verdict.js';

/**
 * 落地校准建议（对应实施计划 §3「给出可直接落地的校准建议」）。
 *
 * 做法：递归收集本轮所有证据里出现过的字段名（值早已被 `evidence.ts` 脱敏，
 * 字段名本身不敏感），与 `codecV1.ts` 建模时假设的字段名集合做差集，
 * 列出「观察到但未建模」与「建模了但从未观察到」两类，供人工去改
 * `apps/server/src/adapter/codecV1.ts` 时参考。这不是自动改代码，只是把
 * 差异摆出来——协议字段的最终取舍仍需人工判断（真实帧样本、多次运行的稳定性）。
 */

/** `codecV1.ts` 里已经写死会去读的字段名（保持与源码同步，改 codec 时记得回来更新这里）。 */
const MODELED_FIELDS = new Set([
  'type',
  'invocationId',
  'target',
  'arguments',
  'item',
  'result',
  'error',
  'messages',
  'requestId',
  'images',
  'conversationId',
  'text',
  'author',
  'messageType',
  'contentOrigin',
  'spokenText',
  'adaptiveCards',
  'sourceAttributions',
  'toolCalls',
  'seeMoreUrl',
  'providerDisplayName',
  'callId',
  'id',
  'name',
  'argumentsDelta',
  'phase',
  'value',
  'message',
]);

function collectKeys(value: unknown, into: Set<string>, depth = 0): void {
  if (depth > 10 || value === null || value === undefined) return;
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, into, depth + 1);
    return;
  }
  if (typeof value !== 'object') return;
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    into.add(key);
    collectKeys(val, into, depth + 1);
  }
}

/** 收集本轮所有 case 证据里、原始帧结构样本部分出现过的键名。 */
export function collectObservedFrameKeys(results: readonly CapabilityResult[]): Set<string> {
  const keys = new Set<string>();
  for (const result of results) {
    collectKeys(result.evidence, keys);
  }
  return keys;
}

export interface CalibrationNotes {
  observedButUnmodeled: string[];
  modeledButUnobserved: string[];
  suggestedToolsMode: 'native' | 'prompt' | 'auto';
  suggestedUpstreamImageInput: boolean;
  observedRetryAfterMs: number[];
}

const NON_PROTOCOL_KEYS = new Set([
  // 探针自己 evidence 结构里用的键名，不是上游协议字段，diff 时要排除
  'event_kinds',
  'frame_count',
  'raw_frame_structure_sample',
  'close_code',
  'close_reason',
  'error_category',
  'error_message',
  'retry_after_ms',
  'conversation_ref_present',
  'duration_ms',
  'reply_length',
  'input_length',
  'text_delta_count',
  'usage_like_fields',
  'model_field_hits',
  'requested_model',
  'request_accepted',
  'mentions_model_name_in_text',
  'has_citation',
  'channel',
  'detected_name',
  'undeclared',
  'call_count',
  'tool_call_stats',
  'image_field_convention',
  'color_matched',
  'attachments_field_convention',
  'note_attachment_field_ok',
  'parse_strategy',
  'account_id_prefix',
  'tid_prefix',
  'refresh_succeeded',
  'access_token_expiry_extended',
  'refresh_token_rotated',
  'remembered',
  'leaked_other_session_content',
  'no_repeat_call',
  'note',
  'via_passthrough',
  'via_text_prefix',
  'turn1',
  'turn2',
  'first_turn',
  'resumed_turn',
  'round1',
  'round2',
  'tool_call_round',
  'result_round',
  'established_turn',
  'fabricated_ref_turn',
  'inline_text',
  'via_attachments_field',
  'path',
]);

export function buildCalibrationNotes(results: readonly CapabilityResult[]): CalibrationNotes {
  const observed = collectObservedFrameKeys(results);
  const observedProtocolKeys = [...observed].filter((key) => !NON_PROTOCOL_KEYS.has(key));

  const observedButUnmodeled = observedProtocolKeys.filter((key) => !MODELED_FIELDS.has(key)).sort();
  const modeledButUnobserved = [...MODELED_FIELDS].filter((key) => !observed.has(key)).sort();

  const toolDefinition = results.find((r) => r.id === 'tool_definition_understanding');
  const stats = extractToolCallStats(results);
  let suggestedToolsMode: CalibrationNotes['suggestedToolsMode'] = 'auto';
  if (toolDefinition?.status === 'native' || (stats !== null && stats.nativeHits > stats.promptHits)) {
    suggestedToolsMode = 'native';
  } else if (toolDefinition?.status === 'adaptable' || (stats !== null && stats.promptHits > 0 && stats.nativeHits === 0)) {
    suggestedToolsMode = 'prompt';
  }

  const imageResult = results.find((r) => r.id === 'image_understanding');
  const suggestedUpstreamImageInput = imageResult?.status === 'native';

  const retryAfterValues: number[] = [];
  for (const result of results) {
    const value = result.evidence.retry_after_ms;
    if (typeof value === 'number') retryAfterValues.push(value);
  }

  return {
    observedButUnmodeled,
    modeledButUnobserved,
    suggestedToolsMode,
    suggestedUpstreamImageInput,
    observedRetryAfterMs: retryAfterValues,
  };
}
