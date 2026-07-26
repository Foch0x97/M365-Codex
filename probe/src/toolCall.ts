import {
  buildToolInstruction,
  PromptToolScanner,
} from '../../apps/server/dist/tools/promptProtocol.js';
import { ToolRegistry, type ParsedTool } from '../../apps/server/dist/tools/registry.js';
import type { ToolDeclaration, UpstreamEvent } from '../../apps/server/dist/adapter/protocol.js';
import { extractText, runText } from './caseHelpers.js';
import type { InvocationOutcome, ProbeContext } from './types.js';

/**
 * 工具调用探测的共用逻辑（§3.1 第 12-16 项 + §3.5 提示词模拟门槛）。
 *
 * 上游是否有原生结构化工具概念尚未确认，所以每次请求同时打开两条通道：
 * - 原生：`InvocationInput.tools` 带结构化声明，若上游真的支持，
 *   `codecV1.mapMessageToEvents` 会从 `msg.toolCalls` 产出 `tool_call_*` 事件；
 * - 提示词：把工具目录写进文本（复用 `tools/promptProtocol.ts` 的
 *   `buildToolInstruction`），回来的正文用同一个 `PromptToolScanner` 解析。
 *
 * 两条通道命中的判定完全独立，因此单次请求就能确定「上游走了哪条」，
 * 不需要靠猜测或额外请求去区分。
 */

export function toParsedTools(declarations: readonly ToolDeclaration[]): ParsedTool[] {
  return declarations.map((decl) => ({
    name: decl.name,
    description: decl.description ?? null,
    parameters: decl.parameters ?? null,
    sideEffect: true,
  }));
}

export function buildRegistry(declarations: readonly ToolDeclaration[]): ToolRegistry {
  return new ToolRegistry(toParsedTools(declarations));
}

/** 把提示语与工具目录拼成同时打开「原生 + 提示词」两条通道的最终文本。 */
export function buildDualChannelText(promptText: string, declarations: readonly ToolDeclaration[]): string {
  const instruction = buildToolInstruction(toParsedTools(declarations));
  return instruction === '' ? promptText : `${promptText}\n\n${instruction}`;
}

export type ToolCallChannel = 'native' | 'prompt' | 'none';

export interface ToolCallDetection {
  channel: ToolCallChannel;
  name: string | null;
  callId: string | null;
  argumentsJson: string | null;
  /** 是否调用了未在 registry 中声明的工具（大小写/空格不一致也算未声明） */
  undeclared: boolean;
  /** 解析工具调用后剩下的正文（native 通道下就是完整正文，因为工具调用本就不在文本里） */
  bodyText: string;
  /** 正文里是否仍然疑似把工具调用 JSON 当内容重复输出了一遍 */
  duplicateJsonInBody: boolean;
  /** 本轮命中的全部原生 tool_call_begin 数（用于并行工具调用判定） */
  nativeCallCount: number;
  /** 本轮命中的全部提示词 tool_call 数（用于并行工具调用判定） */
  promptCallCount: number;
}

function collectArgs(events: readonly UpstreamEvent[], callId: string): string {
  return events
    .filter(
      (event): event is Extract<UpstreamEvent, { kind: 'tool_call_args_delta' }> =>
        event.kind === 'tool_call_args_delta' && event.callId === callId,
    )
    .map((event) => event.delta)
    .join('');
}

/** 从一次 invocation 结果中检测工具调用，判定走了原生还是提示词通道。 */
export function detectToolCall(outcome: InvocationOutcome, registry: ToolRegistry): ToolCallDetection {
  const nativeBegins = outcome.events.filter(
    (event): event is Extract<UpstreamEvent, { kind: 'tool_call_begin' }> => event.kind === 'tool_call_begin',
  );

  if (nativeBegins.length > 0) {
    const first = nativeBegins[0] as Extract<UpstreamEvent, { kind: 'tool_call_begin' }>;
    const bodyText = extractText(outcome);
    return {
      channel: 'native',
      name: first.name,
      callId: first.callId,
      argumentsJson: collectArgs(outcome.events, first.callId),
      undeclared: !registry.has(first.name),
      bodyText,
      duplicateJsonInBody: looksLikeDuplicateToolJson(bodyText, first.name),
      nativeCallCount: nativeBegins.length,
      promptCallCount: 0,
    };
  }

  const rawText = extractText(outcome);
  const scanner = new PromptToolScanner();
  const pushed = scanner.push(rawText);
  const flushed = scanner.flush();
  const events = [...pushed.events, ...flushed.events];
  const bodyText = pushed.text + flushed.text;

  const promptBegins = events.filter(
    (event): event is Extract<UpstreamEvent, { kind: 'tool_call_begin' }> => event.kind === 'tool_call_begin',
  );

  if (promptBegins.length === 0) {
    return {
      channel: 'none',
      name: null,
      callId: null,
      argumentsJson: null,
      undeclared: false,
      bodyText,
      duplicateJsonInBody: false,
      nativeCallCount: 0,
      promptCallCount: 0,
    };
  }

  const first = promptBegins[0] as Extract<UpstreamEvent, { kind: 'tool_call_begin' }>;
  return {
    channel: 'prompt',
    name: first.name,
    callId: first.callId,
    argumentsJson: collectArgs(events, first.callId),
    undeclared: !registry.has(first.name),
    bodyText,
    duplicateJsonInBody: looksLikeDuplicateToolJson(bodyText, first.name),
    nativeCallCount: 0,
    promptCallCount: promptBegins.length,
  };
}

/** 启发式判断：解析/剥离之后的正文里，是否仍疑似把工具调用当内容重复输出了一遍。 */
function looksLikeDuplicateToolJson(bodyText: string, toolName: string): boolean {
  if (bodyText.includes('<tool_call>')) return true;
  const nameHit = bodyText.includes(toolName);
  const jsonShapeHit = /"name"\s*:\s*"/.test(bodyText) || /"arguments"\s*:/.test(bodyText);
  return nameHit && jsonShapeHit;
}

/** 单次工具调用统计（§3.5 门槛用）。 */
export interface ToolCallStats {
  trials: number;
  toolNameRecognized: number;
  firstPassSchemaOk: number;
  passWithinTwoRepairs: number;
  undeclaredToolCalls: number;
  duplicateJsonInBody: number;
  /** 实际观察到的通道分布，供校准建议使用 */
  nativeHits: number;
  promptHits: number;
  noCallHits: number;
}

export function emptyStats(): ToolCallStats {
  return {
    trials: 0,
    toolNameRecognized: 0,
    firstPassSchemaOk: 0,
    passWithinTwoRepairs: 0,
    undeclaredToolCalls: 0,
    duplicateJsonInBody: 0,
    nativeHits: 0,
    promptHits: 0,
    noCallHits: 0,
  };
}

export function mergeStats(...stats: readonly ToolCallStats[]): ToolCallStats {
  const merged = emptyStats();
  for (const s of stats) {
    merged.trials += s.trials;
    merged.toolNameRecognized += s.toolNameRecognized;
    merged.firstPassSchemaOk += s.firstPassSchemaOk;
    merged.passWithinTwoRepairs += s.passWithinTwoRepairs;
    merged.undeclaredToolCalls += s.undeclaredToolCalls;
    merged.duplicateJsonInBody += s.duplicateJsonInBody;
    merged.nativeHits += s.nativeHits;
    merged.promptHits += s.promptHits;
    merged.noCallHits += s.noCallHits;
  }
  return merged;
}

/**
 * 单个试次：发起一次「触发 probe_get_time 调用」的请求，检测通道，
 * 若参数不满足 schema 则最多请求两次修复（§7.3 上限），返回本次试次的统计增量。
 */
export async function runSingleToolTrial(
  ctx: ProbeContext,
  promptText: string,
  declarations: readonly ToolDeclaration[],
): Promise<{ stats: ToolCallStats; lastDetection: ToolCallDetection; lastOutcome: InvocationOutcome }> {
  const registry = buildRegistry(declarations);
  const text = buildDualChannelText(promptText, declarations);
  let outcome = await runText(ctx, text, { tools: declarations });
  let detection = detectToolCall(outcome, registry);

  const stats = emptyStats();
  stats.trials = 1;
  tallyChannel(stats, detection);

  if (detection.channel === 'none') {
    return { stats, lastDetection: detection, lastOutcome: outcome };
  }

  stats.toolNameRecognized += detection.undeclared ? 0 : 1;
  if (detection.undeclared) stats.undeclaredToolCalls += 1;
  if (detection.duplicateJsonInBody) stats.duplicateJsonInBody += 1;

  let validation = registry.validateArguments(detection.name ?? '', detection.argumentsJson ?? '{}');
  if (validation.valid) {
    stats.firstPassSchemaOk += 1;
    stats.passWithinTwoRepairs += 1;
    return { stats, lastDetection: detection, lastOutcome: outcome };
  }

  // 最多两次修复（§7.3 上限），复用同一个会话标识续接（若上游返回过的话）
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const repairPrompt = `你上一次调用 ${detection.name ?? '该工具'} 的参数不满足要求：${validation.errors.join('；')}。请重新按 JSON Schema 输出一次正确的工具调用。`;
    outcome = await runText(ctx, repairPrompt, {
      tools: declarations,
      conversationRef: outcome.conversationRef ?? undefined,
    });
    detection = detectToolCall(outcome, registry);
    if (detection.channel === 'none') continue;
    if (detection.undeclared) stats.undeclaredToolCalls += 1;
    if (detection.duplicateJsonInBody) stats.duplicateJsonInBody += 1;
    validation = registry.validateArguments(detection.name ?? '', detection.argumentsJson ?? '{}');
    if (validation.valid) {
      stats.passWithinTwoRepairs += 1;
      break;
    }
  }

  return { stats, lastDetection: detection, lastOutcome: outcome };
}

function tallyChannel(stats: ToolCallStats, detection: ToolCallDetection): void {
  if (detection.channel === 'native') stats.nativeHits += 1;
  else if (detection.channel === 'prompt') stats.promptHits += 1;
  else stats.noCallHits += 1;
}
