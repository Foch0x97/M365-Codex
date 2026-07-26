import type { Logger } from 'pino';
import type { ResponseRepository, ResponseRow } from '../repo/responses.js';
import type { ResponseObject } from '../responses/types.js';

/**
 * 服务重启后的恢复（对应实施计划 §18）。
 *
 * 处置原则：
 * - `queued`——还没有任何进程真正接手执行，天然可查询、可恢复，这里只是
 *   确认它仍然可见，不需要改写任何字段；
 * - `in_progress`——进程崩溃前可能已经向上游发出请求、甚至已经执行了带
 *   副作用的工具调用，重启后**无法确认**上次具体进行到哪一步。因此一律标记
 *   为 `incomplete`（带 `incomplete_details.reason`），而不是猜测性地继续
 *   或重放：继续执行等于对不确定状态强行下结论，重放则可能让已经执行过的
 *   副作用工具再执行一次；
 * - 已发出的工具调用（`tool_calls` 表中 `emitted`/`completed`）原样保留，
 *   仍可通过 `GET /v1/responses/:id` 关联查询，绝不自动重放任何有副作用的操作。
 */

export interface RecoveryDeps {
  responses: ResponseRepository;
  logger: Logger;
}

export interface RecoveryResult {
  /** 保持 queued、可继续被查询的记录数 */
  queuedKept: number;
  /** 被标记为 incomplete 的 in_progress 记录数 */
  inProgressMarkedIncomplete: number;
}

const RESTART_INCOMPLETE_REASON = 'server_restarted';

export function recoverOnStartup(deps: RecoveryDeps, now = Date.now()): RecoveryResult {
  const queued = deps.responses.listByStatus('queued');

  const inProgress = deps.responses.listByStatus('in_progress');
  for (const row of inProgress) {
    const body = buildIncompleteBody(row);
    deps.responses.complete(
      row.id,
      'incomplete',
      body,
      { reportedUpstreamModel: row.reported_upstream_model, errorMessage: null },
      now,
    );
  }

  if (inProgress.length > 0) {
    deps.logger.warn(
      { count: inProgress.length },
      '重启恢复：发现上次未正常结束的 in_progress Response，已标记为 incomplete（不自动重放）',
    );
  }
  if (queued.length > 0) {
    deps.logger.info({ count: queued.length }, '重启恢复：queued Response 保持原状，可继续被查询');
  }

  return { queuedKept: queued.length, inProgressMarkedIncomplete: inProgress.length };
}

/**
 * 补一份最简 Response 快照，供 `GET /v1/responses/:id` 在重启后仍能返回
 * 结构完整的对象（而不是退化成 `{id, object, status}` 的兜底形态）。
 * 字段只能尽力还原：`responses` 表没有持久化 metadata / max_output_tokens /
 * temperature 等请求参数（只在完成时随 body 落库），重启恢复时这些原样不可得，
 * 只能给出 null，属于已知的近似，不影响“状态可查、不猜测执行结果”这条硬约束。
 */
function buildIncompleteBody(row: ResponseRow): ResponseObject {
  return {
    id: row.id,
    object: 'response',
    created_at: Math.floor(row.created_at / 1000),
    status: 'incomplete',
    model: row.requested_model ?? '',
    output: [],
    usage: null,
    metadata: null,
    previous_response_id: row.previous_response_id,
    reasoning: row.requested_reasoning_effort === null ? null : { effort: row.requested_reasoning_effort },
    max_output_tokens: null,
    temperature: null,
    error: null,
    incomplete_details: { reason: RESTART_INCOMPLETE_REASON },
  };
}
