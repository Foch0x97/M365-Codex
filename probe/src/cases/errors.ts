import { randomUUID } from 'node:crypto';
import { buildEvidence, extractText, makeResult, runText } from '../caseHelpers.js';
import { ownLiterals } from '../testInputs.js';
import type { CapabilityResult, ProbeContext } from '../types.js';

const PING_TEXT = '请回复「收到」二字即可，用于连通性与错误分类基线测试。';

/**
 * #24 401/403/429/5xx 与 WebSocket 关闭码的错误分类。
 *
 * 分类函数本身（`classifyHttpStatus` / `classifyCloseCode`）在 M3 已用模拟上游
 * 做了穷举式单测（`connection.test.ts`），这里只做一次真实请求，如实记录
 * 本次命中的分类；完整的错误矩阵覆盖依赖多次运行里自然出现的各种状态码，
 * 由 `report.ts` 汇总全轮所有 case 的 `errorCategory` 分布来呈现，不在这里
 * 主动构造 401/403/429（构造会消耗真实配额，且有触发风控之虞，见 README 风险声明）。
 */
export async function caseErrorClassification(ctx: ProbeContext): Promise<CapabilityResult> {
  const requestedAt = Date.now();
  const outcome = await runText(ctx, PING_TEXT);

  const status: CapabilityResult['status'] = outcome.errorCategory === null ? 'adaptable' : 'native';

  return makeResult({
    id: 'error_classification',
    index: 24,
    name: '错误分类（401/403/429/5xx/WS 关闭码）',
    status,
    summary:
      outcome.errorCategory === null
        ? '本次请求成功，只验证了「无错误」这一路径；分类函数已在 M3 用模拟上游穷举覆盖，完整真实错误矩阵见本轮报告的错误分布汇总。'
        : `本次请求命中真实错误分类：${outcome.errorCategory}（${outcome.errorMessage ?? ''}）。`,
    requestedAt,
    durationMs: outcome.durationMs,
    errorCategory: outcome.errorCategory,
    evidence: buildEvidence(outcome, ownLiterals(PING_TEXT)),
  });
}

/**
 * #25 Retry-After 与限流行为：同样采用被动观察——本探针默认串行 + 间隔，
 * 不主动打爆账号触发限流；若本轮自然遇到 429，这里会如实记录解析出的冷却时间。
 */
export async function caseRetryAfterBehavior(ctx: ProbeContext): Promise<CapabilityResult> {
  const requestedAt = Date.now();
  const outcome = await runText(ctx, PING_TEXT);
  const rateLimited = outcome.errorCategory === 'rate_limited';

  return makeResult({
    id: 'retry_after_behavior',
    index: 25,
    name: 'Retry-After 与限流行为',
    status: rateLimited ? 'native' : 'unknown',
    summary: rateLimited
      ? `本次请求自然触发限流，解析出的冷却时间：${outcome.retryAfterMs ?? '无法解析'} 毫秒。`
      : '本次请求未触发限流（这是预期的正常情况——探针刻意不主动构造 429，避免影响账号）。如需专门验证 Retry-After 解析，需要在人工监督下另行安排小流量压测，不在默认安全跑法范围内。',
    requestedAt,
    durationMs: outcome.durationMs,
    errorCategory: outcome.errorCategory,
    evidence: buildEvidence(outcome, ownLiterals(PING_TEXT)),
  });
}

/**
 * #26 账号 / 租户能力差异：单个账号自身无法体现「差异」，这里只产出本账号的
 * 能力指纹供 `report.ts` 在 `--all` 多账号场景下做横向比较；不发起额外请求。
 */
export function caseAccountTenantVariance(ctx: ProbeContext): Promise<CapabilityResult> {
  const requestedAt = Date.now();
  return Promise.resolve(
    makeResult({
      id: 'account_tenant_variance',
      index: 26,
      name: '账号 / 租户能力差异',
      status: 'unknown',
      summary:
        '单个账号的探测结果本身无法体现「差异」；请用 `--all` 对多个账号跑一遍，报告会在「账号间差异」章节按 case 状态做横向对比。本项不发起额外上游请求。',
      requestedAt,
      durationMs: 0,
      errorCategory: null,
      evidence: { account_id_prefix: ctx.account.id.slice(0, 8), tid_prefix: ctx.account.tid.slice(0, 8) },
    }),
  );
}

const BINDING_MARK = `绑定测试标记-${randomUUID().slice(0, 8)}`;
const BINDING_REMEMBER_PROMPT = `请记住一个标记词：「${BINDING_MARK}」，仅回复「已记住」。`;
const BINDING_RECALL_PROMPT = '我刚才让你记住的标记词是什么？只回复那个词，不知道就说不知道。';

/**
 * #27 会话与账号绑定关系：用一个「凭空捏造、从未由上游签发」的 conversationRef
 * 去续接，检查是否会意外读到本账号其他真实会话的内容（绑定完整性的安全相关检查）。
 */
export async function caseSessionAccountBinding(ctx: ProbeContext): Promise<CapabilityResult> {
  const requestedAt = Date.now();
  const established = await runText(ctx, BINDING_REMEMBER_PROMPT);

  const fabricatedRef = `probe-fabricated-${randomUUID()}`;
  const probed = await runText(ctx, BINDING_RECALL_PROMPT, { conversationRef: fabricatedRef });
  const leaked = extractText(probed).includes(BINDING_MARK);

  return makeResult({
    id: 'session_account_binding',
    index: 27,
    name: '会话与账号绑定关系',
    status: probed.errorCategory !== null ? 'unknown' : leaked ? 'unstable' : 'native',
    summary: leaked
      ? '警告：用一个凭空捏造的 conversationRef 续接后，回复中出现了另一次真实会话设置的标记词，说明上游可能没有严格按会话标识隔离上下文，需要人工进一步确认。'
      : '用凭空捏造的 conversationRef 续接没有读到其他会话的内容，会话与账号/会话标识的绑定看起来是隔离的。',
    requestedAt,
    durationMs: established.durationMs + probed.durationMs,
    errorCategory: probed.errorCategory,
    evidence: {
      established_turn: buildEvidence(established, ownLiterals(BINDING_REMEMBER_PROMPT)),
      fabricated_ref_turn: buildEvidence(probed, ownLiterals(BINDING_RECALL_PROMPT)),
      leaked_other_session_content: leaked,
    },
  });
}
