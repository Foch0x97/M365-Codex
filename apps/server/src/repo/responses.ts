import type { ResponseStatus } from '@m365-codex/shared';
import { asRow, asRows, type Database } from '../db/index.js';
import type { ResponseObject } from '../responses/types.js';

/** Responses 持久化：请求记录 + 会话粘性绑定。 */

export interface ResponseRow {
  id: string;
  api_key_id: string | null;
  account_id: string | null;
  status: ResponseStatus;
  requested_model: string | null;
  requested_reasoning_effort: string | null;
  upstream_model_parameter: string | null;
  reported_upstream_model: string | null;
  previous_response_id: string | null;
  idempotency_key: string | null;
  body: string | null;
  error_message: string | null;
  /** 本 Response 处在对话链的第几轮工具调用（§7.4 最大工具轮次） */
  tool_round: number;
  /** 本对话链累计发出的工具调用数（§7.4 最大累计工具调用数） */
  tool_calls_total: number;
  created_at: number;
  updated_at: number;
}

export interface ConversationBindingRow {
  response_id: string;
  account_id: string | null;
  upstream_conversation_ref: string | null;
  created_at: number;
}

export interface CreateResponseInput {
  id: string;
  apiKeyId: string | null;
  status: ResponseStatus;
  requestedModel: string;
  requestedReasoningEffort: string | null;
  upstreamModelParameter: string | null;
  previousResponseId: string | null;
  idempotencyKey: string | null;
  /** 继承自上一轮的计数；新对话为 0 */
  toolRound?: number;
  toolCallsTotal?: number;
}

export class ResponseRepository {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  create(input: CreateResponseInput, now = Date.now()): void {
    this.#db
      .prepare(
        `INSERT INTO responses (
           id, api_key_id, status, requested_model, requested_reasoning_effort,
           upstream_model_parameter, previous_response_id, idempotency_key,
           tool_round, tool_calls_total, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.apiKeyId,
        input.status,
        input.requestedModel,
        input.requestedReasoningEffort,
        input.upstreamModelParameter,
        input.previousResponseId,
        input.idempotencyKey,
        input.toolRound ?? 0,
        input.toolCallsTotal ?? 0,
        now,
        now,
      );
  }

  /** 记录本轮实际发出的工具调用数，供下一轮继承计数。 */
  setToolCounters(id: string, round: number, total: number, now = Date.now()): void {
    this.#db
      .prepare('UPDATE responses SET tool_round = ?, tool_calls_total = ?, updated_at = ? WHERE id = ?')
      .run(round, total, now, id);
  }

  findById(id: string): ResponseRow | undefined {
    return asRow<ResponseRow>(this.#db.prepare('SELECT * FROM responses WHERE id = ?').get(id));
  }

  /**
   * 找出某 API Key 下最近一次用过某幂等键的记录（仅供审计/回溯查看，
   * 唯一性保证已经收敛到 `idempotency_keys` 表，这里的 key 不再是唯一的，
   * 流式请求 release 后同一把键可能对应多个历史记录，取最近一条）。
   */
  findByIdempotencyKey(apiKeyId: string, key: string): ResponseRow | undefined {
    return asRow<ResponseRow>(
      this.#db
        .prepare(
          'SELECT * FROM responses WHERE api_key_id = ? AND idempotency_key = ? ORDER BY created_at DESC LIMIT 1',
        )
        .get(apiKeyId, key),
    );
  }

  setAccount(id: string, accountId: string, now = Date.now()): void {
    this.#db
      .prepare('UPDATE responses SET account_id = ?, updated_at = ? WHERE id = ?')
      .run(accountId, now, id);
  }

  updateStatus(id: string, status: ResponseStatus, now = Date.now()): void {
    this.#db.prepare('UPDATE responses SET status = ?, updated_at = ? WHERE id = ?').run(status, now, id);
  }

  /** 完成时落库最终 Response JSON 与上游自报模型。 */
  complete(
    id: string,
    status: ResponseStatus,
    body: ResponseObject,
    options: { reportedUpstreamModel?: string | null; errorMessage?: string | null } = {},
    now = Date.now(),
  ): void {
    this.#db
      .prepare(
        `UPDATE responses SET status = ?, body = ?, reported_upstream_model = ?, error_message = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        status,
        JSON.stringify(body),
        options.reportedUpstreamModel ?? null,
        options.errorMessage ?? null,
        now,
        id,
      );
  }

  /** 读取完成后的 Response 对象；未完成或无 body 时返回 null。 */
  readBody(id: string): ResponseObject | null {
    const row = this.findById(id);
    if (row?.body == null) return null;
    try {
      return JSON.parse(row.body) as ResponseObject;
    } catch {
      return null;
    }
  }

  upsertBinding(binding: ConversationBindingRow): void {
    this.#db
      .prepare(
        `INSERT INTO conversation_bindings (response_id, account_id, upstream_conversation_ref, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (response_id) DO UPDATE SET
           account_id = excluded.account_id,
           upstream_conversation_ref = excluded.upstream_conversation_ref`,
      )
      .run(binding.response_id, binding.account_id, binding.upstream_conversation_ref, binding.created_at);
  }

  findBinding(responseId: string): ConversationBindingRow | undefined {
    return asRow<ConversationBindingRow>(
      this.#db.prepare('SELECT * FROM conversation_bindings WHERE response_id = ?').get(responseId),
    );
  }

  /** 按状态找出全部记录（重启恢复用，§18）。 */
  listByStatus(status: ResponseStatus): ResponseRow[] {
    return asRows<ResponseRow>(this.#db.prepare('SELECT * FROM responses WHERE status = ?').all(status));
  }

  /** 管理端请求记录列表（契约 §2.2），按创建时间倒序，可选按状态/API Key 过滤。 */
  listForAdmin(filters: { limit: number; status?: string; apiKeyId?: string }): { items: ResponseRow[]; total: number } {
    const conditions: string[] = [];
    const params: (string | number)[] = [];
    if (filters.status !== undefined) {
      conditions.push('status = ?');
      params.push(filters.status);
    }
    if (filters.apiKeyId !== undefined) {
      conditions.push('api_key_id = ?');
      params.push(filters.apiKeyId);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const totalRow = asRow<{ count: number }>(
      this.#db.prepare(`SELECT COUNT(*) AS count FROM responses ${where}`).get(...params),
    );
    const items = asRows<ResponseRow>(
      this.#db
        .prepare(`SELECT * FROM responses ${where} ORDER BY created_at DESC LIMIT ?`)
        .all(...params, filters.limit),
    );
    return { items, total: totalRow?.count ?? 0 };
  }

  /** 某时间点之后创建的请求数（供 /admin/overview 的 requests.last_hour）。 */
  countCreatedSince(sinceMs: number): number {
    const row = asRow<{ count: number }>(
      this.#db.prepare('SELECT COUNT(*) AS count FROM responses WHERE created_at >= ?').get(sinceMs),
    );
    return row?.count ?? 0;
  }

  /** 某时间点之后失败的请求数（供 /admin/overview 的 requests.failed_last_hour）。 */
  countFailedSince(sinceMs: number): number {
    const row = asRow<{ count: number }>(
      this.#db
        .prepare("SELECT COUNT(*) AS count FROM responses WHERE status = 'failed' AND updated_at >= ?")
        .get(sinceMs),
    );
    return row?.count ?? 0;
  }

  /**
   * 清理已结束（completed/failed/cancelled/incomplete）且早于 cutoff 的记录
   * （对应实施计划 §18 定时清理）。级联删除 `tool_calls`（`ON DELETE CASCADE`）
   * 与 `conversation_bindings`（同上），因此不需要单独再清一次。
   */
  purgeFinishedOlderThan(cutoff: number): number {
    const result = this.#db
      .prepare(
        `DELETE FROM responses
         WHERE status IN ('completed', 'failed', 'cancelled', 'incomplete') AND updated_at < ?`,
      )
      .run(cutoff);
    return Number(result.changes);
  }

  /**
   * 清理指向已被删除账号的会话绑定（失效会话绑定，§18）。
   * `account_id` 没有 `ON DELETE` 动作，账号被删后绑定会变成悬空引用。
   */
  purgeStaleBindings(): number {
    const result = this.#db
      .prepare(
        `DELETE FROM conversation_bindings
         WHERE account_id IS NOT NULL
           AND account_id NOT IN (SELECT id FROM accounts)`,
      )
      .run();
    return Number(result.changes);
  }
}
