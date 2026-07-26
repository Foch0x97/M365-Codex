import { randomUUID } from 'node:crypto';
import type {
  RawMessage,
  ToolDeclaration,
  ToolResultInput,
  UpstreamEvent,
} from '../../apps/server/dist/adapter/protocol.js';
import { buildProbeUrl } from './upstreamConfig.js';
import { runRawSession } from './rawSession.js';
import { buildStructureSample } from './evidence.js';
import type { CapabilityResult, CapabilityStatus, InvocationOutcome, ProbeContext } from './types.js';

/** 单次文本 invocation 的可选参数。 */
export interface RunTextOptions {
  conversationRef?: string | undefined;
  passthrough?: Record<string, unknown> | undefined;
  tools?: readonly ToolDeclaration[] | undefined;
  toolResults?: readonly ToolResultInput[] | undefined;
  signal?: AbortSignal | undefined;
  onEvent?: ((event: UpstreamEvent, raw: RawMessage) => void) | undefined;
  /** 覆盖默认的整体超时（毫秒），用于长上下文一类需要更久的用例 */
  totalTimeoutMs?: number | undefined;
  /** 取消时是否发送 stop 帧，见 `rawSession.ts` 的同名选项 */
  sendCancelOnAbort?: boolean | undefined;
}

/** 发起一次 invocation 并等待完成/失败/超时，返回聚合结果。每次调用独立开连接。 */
export async function runText(
  ctx: ProbeContext,
  text: string,
  options: RunTextOptions = {},
): Promise<InvocationOutcome> {
  const accessToken = await ctx.getAccessToken();
  const url = buildProbeUrl(ctx.upstream, ctx.account, accessToken);
  return runRawSession({
    url,
    codec: ctx.codec,
    invocationId: randomUUID(),
    text,
    conversationRef: options.conversationRef,
    passthrough: options.passthrough,
    tools: options.tools,
    toolResults: options.toolResults,
    handshakeTimeoutMs: ctx.upstream.handshakeTimeoutMs,
    idleTimeoutMs: ctx.upstream.idleTimeoutMs,
    totalTimeoutMs: options.totalTimeoutMs ?? ctx.invocationTimeoutMs,
    signal: options.signal,
    onEvent: options.onEvent,
    sendCancelOnAbort: options.sendCancelOnAbort,
  });
}

/** 拼出某次 invocation 里全部 `text_delta` 的正文。 */
export function extractText(outcome: InvocationOutcome): string {
  return outcome.events
    .filter((event): event is Extract<UpstreamEvent, { kind: 'text_delta' }> => event.kind === 'text_delta')
    .map((event) => event.text)
    .join('');
}

export function hasEventKind(outcome: InvocationOutcome, kind: UpstreamEvent['kind']): boolean {
  return outcome.events.some((event) => event.kind === kind);
}

export function countEventKind(outcome: InvocationOutcome, kind: UpstreamEvent['kind']): number {
  return outcome.events.filter((event) => event.kind === kind).length;
}

/** 把一次 invocation 的原始帧转成脱敏结构样本，最多保留前几条帧（够看结构即可）。 */
export function sampleRawFrames(
  outcome: InvocationOutcome,
  literals: ReadonlySet<string>,
  maxFrames = 5,
): unknown[] {
  return outcome.rawMessages.slice(0, maxFrames).map((message) => buildStructureSample(message, literals));
}

/** 组装标准化的证据对象：所有 case 共用同一套基础字段，便于报告横向比较。 */
export function buildEvidence(
  outcome: InvocationOutcome,
  literals: ReadonlySet<string>,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    event_kinds: outcome.events.map((event) => event.kind),
    frame_count: outcome.rawMessages.length,
    raw_frame_structure_sample: sampleRawFrames(outcome, literals),
    close_code: outcome.closeCode,
    close_reason: outcome.closeReason,
    error_category: outcome.errorCategory,
    error_message: outcome.errorMessage,
    retry_after_ms: outcome.retryAfterMs,
    conversation_ref_present: outcome.conversationRef !== null,
    duration_ms: outcome.durationMs,
    ...extra,
  };
}

/** 组装 `CapabilityResult`，统一各 case 的收尾逻辑。 */
export function makeResult(input: {
  id: string;
  index: number;
  name: string;
  status: CapabilityStatus;
  summary: string;
  requestedAt: number;
  durationMs: number;
  errorCategory?: string | null;
  evidence: Record<string, unknown>;
}): CapabilityResult {
  return {
    id: input.id,
    index: input.index,
    name: input.name,
    status: input.status,
    summary: input.summary,
    requestedAt: input.requestedAt,
    durationMs: input.durationMs,
    errorCategory: input.errorCategory ?? null,
    evidence: input.evidence,
  };
}

/** case 内部抛出异常时的兜底结果：不能让一个 case 的异常中断整轮探测（§6）。 */
export function makeErrorResult(
  id: string,
  index: number,
  name: string,
  requestedAt: number,
  error: unknown,
): CapabilityResult {
  const message = error instanceof Error ? error.message : String(error);
  return makeResult({
    id,
    index,
    name,
    status: 'unknown',
    summary: `用例执行时抛出异常，判定为 unknown：${message}`,
    requestedAt,
    durationMs: Date.now() - requestedAt,
    errorCategory: 'probe_internal_error',
    evidence: { exception_message: message },
  });
}

/** 统一包一层 try/catch，任何 case 内部异常都转成 `unknown` 状态而不是让整轮探测中断。 */
export async function runCaseSafely(
  id: string,
  index: number,
  name: string,
  fn: () => Promise<CapabilityResult>,
): Promise<CapabilityResult> {
  const requestedAt = Date.now();
  try {
    return await fn();
  } catch (error) {
    return makeErrorResult(id, index, name, requestedAt, error);
  }
}
