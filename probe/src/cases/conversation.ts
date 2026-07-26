import { buildEvidence, countEventKind, extractText, makeResult, runText } from '../caseHelpers.js';
import { TEXT_INSTRUCTIONS, TEXT_LONG, TEXT_SHORT, ownLiterals } from '../testInputs.js';
import type { CapabilityResult, ProbeContext } from '../types.js';

/** #2 普通文本对话：单轮问答能否稳定成功。 */
export async function caseBasicTextChat(ctx: ProbeContext): Promise<CapabilityResult> {
  const requestedAt = Date.now();
  const outcome = await runText(ctx, TEXT_SHORT);
  const text = extractText(outcome);
  const ok = outcome.errorCategory === null && text.trim() !== '';

  return makeResult({
    id: 'basic_text_chat',
    index: 2,
    name: '普通文本对话',
    status: ok ? 'native' : 'unsupported',
    summary: ok ? `收到非空文本回复（长度 ${text.length}）。` : `未收到有效文本回复：${outcome.errorMessage ?? '无内容'}。`,
    requestedAt,
    durationMs: outcome.durationMs,
    errorCategory: outcome.errorCategory,
    evidence: buildEvidence(outcome, ownLiterals(), { reply_length: text.length }),
  });
}

/** #3 流式文本响应：是否分多个增量帧到达，而不是一次性吐出整段文本。 */
export async function caseStreamingText(ctx: ProbeContext): Promise<CapabilityResult> {
  const requestedAt = Date.now();
  const outcome = await runText(ctx, TEXT_SHORT);
  const deltaCount = countEventKind(outcome, 'text_delta');

  let status: CapabilityResult['status'];
  if (outcome.errorCategory !== null) status = 'unknown';
  else if (deltaCount >= 2) status = 'native';
  else if (deltaCount === 1) status = 'partial';
  else status = 'unsupported';

  return makeResult({
    id: 'streaming_text',
    index: 3,
    name: '流式文本响应',
    status,
    summary: `本轮收到 ${deltaCount} 个 text_delta 增量帧。`,
    requestedAt,
    durationMs: outcome.durationMs,
    errorCategory: outcome.errorCategory,
    evidence: buildEvidence(outcome, ownLiterals(), { text_delta_count: deltaCount }),
  });
}

const REMEMBER_NAME = '探针小助手七号';
const REMEMBER_PROMPT = `从现在开始，请记住一个名字：「${REMEMBER_NAME}」。仅回复「好的，已记住」。`;
const RECALL_PROMPT = '我刚才让你记住的名字是什么？请只回复那个名字，不要说别的。';

/** #7 连续会话：同一 conversation 内的第二轮是否还带着第一轮的上下文。 */
export async function caseMultiTurnConversation(ctx: ProbeContext): Promise<CapabilityResult> {
  const requestedAt = Date.now();
  const first = await runText(ctx, REMEMBER_PROMPT);
  if (first.errorCategory !== null || first.conversationRef === null) {
    return makeResult({
      id: 'multi_turn_conversation',
      index: 7,
      name: '连续会话（同一 conversation 内多轮）',
      status: first.conversationRef === null ? 'unknown' : 'unsupported',
      summary:
        first.conversationRef === null
          ? '第一轮响应里没有识别出会话标识候选字段，无法判断续接能力（见校准建议）。'
          : `第一轮请求失败：${first.errorMessage ?? '未知错误'}。`,
      requestedAt,
      durationMs: first.durationMs,
      errorCategory: first.errorCategory,
      evidence: buildEvidence(first, ownLiterals(REMEMBER_PROMPT, RECALL_PROMPT)),
    });
  }

  const second = await runText(ctx, RECALL_PROMPT, { conversationRef: first.conversationRef });
  const secondText = extractText(second);
  const remembered = secondText.includes(REMEMBER_NAME);

  return makeResult({
    id: 'multi_turn_conversation',
    index: 7,
    name: '连续会话（同一 conversation 内多轮）',
    status: second.errorCategory !== null ? 'unknown' : remembered ? 'native' : 'partial',
    summary: remembered
      ? '带着第一轮的 conversationRef 续接后，第二轮回复中包含第一轮设定的名字。'
      : `续接请求${second.errorCategory !== null ? '失败' : '成功但回复未包含预期名字（可能上游未真正续接会话，或表达方式不同）'}。`,
    requestedAt,
    durationMs: first.durationMs + second.durationMs,
    errorCategory: second.errorCategory,
    evidence: {
      turn1: buildEvidence(first, ownLiterals(REMEMBER_PROMPT, RECALL_PROMPT)),
      turn2: buildEvidence(second, ownLiterals(REMEMBER_PROMPT, RECALL_PROMPT)),
      remembered,
    },
  });
}

/** #8 上游会话恢复：第一轮连接完全断开（本探针每轮本就是独立连接）后，新连接能否续接同一 conversationRef。 */
export async function caseSessionResumeAfterDisconnect(ctx: ProbeContext): Promise<CapabilityResult> {
  const requestedAt = Date.now();
  const first = await runText(ctx, REMEMBER_PROMPT);
  if (first.errorCategory !== null || first.conversationRef === null) {
    return makeResult({
      id: 'session_resume_after_disconnect',
      index: 8,
      name: '上游会话恢复（断线后续接同一 conversation）',
      status: 'unknown',
      summary: '未能拿到可用的会话标识，无法验证断线续接（本探针每轮 invocation 本就是独立 WebSocket 连接）。',
      requestedAt,
      durationMs: first.durationMs,
      errorCategory: first.errorCategory,
      evidence: buildEvidence(first, ownLiterals(REMEMBER_PROMPT, RECALL_PROMPT)),
    });
  }

  // 显式等待，模拟「断线一段时间后再续接」，而不是背靠背立刻重连
  await sleep(Math.min(ctx.delayMs * 2, 5000));

  const resumed = await runText(ctx, RECALL_PROMPT, { conversationRef: first.conversationRef });
  const resumedText = extractText(resumed);
  const remembered = resumedText.includes(REMEMBER_NAME);

  return makeResult({
    id: 'session_resume_after_disconnect',
    index: 8,
    name: '上游会话恢复（断线后续接同一 conversation）',
    status: resumed.errorCategory !== null ? 'unstable' : remembered ? 'native' : 'partial',
    summary: remembered
      ? '全新 WebSocket 连接、延迟重连后仍能续接原 conversationRef 的上下文。'
      : '全新连接续接后未观察到上下文延续，M3 已实现「本地重建上下文」兜底，不影响整体可用性。',
    requestedAt,
    durationMs: first.durationMs + resumed.durationMs,
    errorCategory: resumed.errorCategory,
    evidence: {
      first_turn: buildEvidence(first, ownLiterals(REMEMBER_PROMPT, RECALL_PROMPT)),
      resumed_turn: buildEvidence(resumed, ownLiterals(REMEMBER_PROMPT, RECALL_PROMPT)),
      remembered,
    },
  });
}

/** #9 长上下文承载能力：约 2 万字符的单轮输入是否被正常接受。 */
export async function caseLongContext(ctx: ProbeContext): Promise<CapabilityResult> {
  const requestedAt = Date.now();
  const outcome = await runText(ctx, TEXT_LONG, { totalTimeoutMs: ctx.invocationTimeoutMs * 2 });
  const text = extractText(outcome);
  const ok = outcome.errorCategory === null && text.trim() !== '';

  return makeResult({
    id: 'long_context',
    index: 9,
    name: '长上下文承载能力',
    status: ok ? 'native' : outcome.errorCategory === 'fatal_client' ? 'unsupported' : 'unknown',
    summary: ok
      ? `约 ${TEXT_LONG.length} 字符的单轮输入被正常接受并回复。`
      : `长文本请求未成功：${outcome.errorMessage ?? '无内容'}。`,
    requestedAt,
    durationMs: outcome.durationMs,
    errorCategory: outcome.errorCategory,
    evidence: buildEvidence(outcome, ownLiterals(), { input_length: TEXT_LONG.length }),
  });
}

const INSTRUCTIONS_QUESTION = '请介绍一下你自己能做什么。';

/** #10 Instructions / 系统级指令注入方式：passthrough 字段与文本前缀两种方式是否有效。 */
export async function caseInstructionsInjection(ctx: ProbeContext): Promise<CapabilityResult> {
  const requestedAt = Date.now();

  const viaPassthrough = await runText(ctx, INSTRUCTIONS_QUESTION, {
    passthrough: { instructions: TEXT_INSTRUCTIONS },
  });
  const viaPrefix = await runText(ctx, `${TEXT_INSTRUCTIONS}\n\n${INSTRUCTIONS_QUESTION}`);

  const passthroughText = extractText(viaPassthrough);
  const prefixText = extractText(viaPrefix);
  // 启发式：指令要求「不超过两句话」，用长度做粗略代理指标，不追求语义精确判定
  const passthroughShort = passthroughText.length > 0 && passthroughText.length <= 150;
  const prefixShort = prefixText.length > 0 && prefixText.length <= 150;

  let status: CapabilityResult['status'] = 'unknown';
  if (prefixShort) status = 'adaptable'; // 文本前缀本就是「M365-Codex 状态机可靠转换」的既有做法
  if (passthroughShort) status = 'native'; // 若上游真的认识 passthrough.instructions 字段，判为原生支持

  return makeResult({
    id: 'instructions_injection',
    index: 10,
    name: 'Instructions / 系统级指令注入方式',
    status,
    summary: `passthrough.instructions 字段：${passthroughShort ? '疑似生效' : '未观察到明显效果'}；文本前缀：${prefixShort ? '疑似生效' : '未观察到明显效果'}（启发式判定，仅供参考，需人工复核实际回复内容）。`,
    requestedAt,
    durationMs: viaPassthrough.durationMs + viaPrefix.durationMs,
    errorCategory: viaPassthrough.errorCategory ?? viaPrefix.errorCategory,
    evidence: {
      via_passthrough: buildEvidence(viaPassthrough, ownLiterals(INSTRUCTIONS_QUESTION), {
        reply_length: passthroughText.length,
      }),
      via_text_prefix: buildEvidence(viaPrefix, ownLiterals(INSTRUCTIONS_QUESTION), {
        reply_length: prefixText.length,
      }),
    },
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
