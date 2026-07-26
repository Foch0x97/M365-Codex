import { buildEvidence, makeResult, runText } from '../caseHelpers.js';
import { TEXT_SHORT, ownLiterals } from '../testInputs.js';
import type { CapabilityResult, ProbeContext } from '../types.js';

/** #1 WebSocket 握手与鉴权：access_token 放在查询参数里，能否建立连接并完成一次握手。 */
export async function caseHandshakeAuth(ctx: ProbeContext): Promise<CapabilityResult> {
  const requestedAt = Date.now();
  const outcome = await runText(ctx, TEXT_SHORT);
  const literals = ownLiterals();

  const handshakeOk = outcome.errorCategory === null || outcome.events.length > 0;
  const status = handshakeOk ? 'native' : classifyHandshakeFailure(outcome.errorCategory);

  return makeResult({
    id: 'ws_handshake_auth',
    index: 1,
    name: 'WebSocket 握手与鉴权',
    status,
    summary: handshakeOk
      ? '连接建立、握手完成并收到至少一帧上游响应。'
      : `握手/连接失败，错误分类：${outcome.errorCategory ?? '未知'}。`,
    requestedAt,
    durationMs: outcome.durationMs,
    errorCategory: outcome.errorCategory,
    evidence: buildEvidence(outcome, literals),
  });
}

function classifyHandshakeFailure(category: string | null): CapabilityResult['status'] {
  if (category === 'account_forbidden') return 'unsupported';
  if (category === 'refresh_and_retry') return 'unstable';
  return 'unknown';
}
