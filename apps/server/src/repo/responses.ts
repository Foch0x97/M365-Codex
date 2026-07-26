import type { ResponseStatus } from '@m365-codex/shared';
import { asRow, type Database } from '../db/index.js';
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

  /** 找出某 API Key 下用过某幂等键的记录（M7 幂等的基础，M4 先建接口）。 */
  findByIdempotencyKey(apiKeyId: string, key: string): ResponseRow | undefined {
    return asRow<ResponseRow>(
      this.#db
        .prepare('SELECT * FROM responses WHERE api_key_id = ? AND idempotency_key = ?')
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
}
