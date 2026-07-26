import { randomUUID } from 'node:crypto';
import { asRow, asRows, type Database } from '../db/index.js';

/**
 * 工具调用持久化（§M5）。
 *
 * 关键约束：`UNIQUE (response_id, call_id)` + status，保证同一工具调用不会因
 * SSE 重连或重复提交被重复「发出」或重复「执行」。副作用工具带 side_effect=1。
 *
 * 状态流转：
 *   emitted   —— 已把 function_call 发给客户端，等待其回传结果
 *   completed —— 已收到 function_call_output，结果回传上游续推理
 */

export type ToolCallStatus = 'emitted' | 'completed';

export interface ToolCallRow {
  id: string;
  response_id: string;
  call_id: string;
  name: string;
  arguments: string | null;
  status: ToolCallStatus;
  side_effect: number;
  output: string | null;
  created_at: number;
  updated_at: number;
}

export interface RecordToolCallInput {
  responseId: string;
  callId: string;
  name: string;
  arguments: string;
  sideEffect: boolean;
}

export class ToolCallRepository {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  /**
   * 记录一次发出的工具调用。若 (response_id, call_id) 已存在则不重复插入，
   * 返回 false（幂等：重连不会重复发出）。
   */
  recordEmitted(input: RecordToolCallInput, now = Date.now()): boolean {
    const result = this.#db
      .prepare(
        `INSERT INTO tool_calls (id, response_id, call_id, name, arguments, status, side_effect, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'emitted', ?, ?, ?)
         ON CONFLICT (response_id, call_id) DO NOTHING`,
      )
      .run(
        randomUUID(),
        input.responseId,
        input.callId,
        input.name,
        input.arguments,
        input.sideEffect ? 1 : 0,
        now,
        now,
      );
    return Number(result.changes) > 0;
  }

  findByCallId(responseId: string, callId: string): ToolCallRow | undefined {
    return asRow<ToolCallRow>(
      this.#db
        .prepare('SELECT * FROM tool_calls WHERE response_id = ? AND call_id = ?')
        .get(responseId, callId),
    );
  }

  /** 跨所有 response 找某 call_id 的记录（客户端回传结果时可能只带 call_id）。 */
  findAnyByCallId(callId: string): ToolCallRow | undefined {
    return asRow<ToolCallRow>(
      this.#db
        .prepare('SELECT * FROM tool_calls WHERE call_id = ? ORDER BY created_at DESC LIMIT 1')
        .get(callId),
    );
  }

  listByResponse(responseId: string): ToolCallRow[] {
    return asRows<ToolCallRow>(
      this.#db
        .prepare('SELECT * FROM tool_calls WHERE response_id = ? ORDER BY created_at ASC')
        .all(responseId),
    );
  }

  /**
   * 标记工具调用已完成（收到结果）。
   * 只有从 emitted → completed 才会写入，重复回传同一结果不再二次执行，返回 false。
   */
  markCompleted(responseId: string, callId: string, output: string, now = Date.now()): boolean {
    const result = this.#db
      .prepare(
        `UPDATE tool_calls SET status = 'completed', output = ?, updated_at = ?
         WHERE response_id = ? AND call_id = ? AND status = 'emitted'`,
      )
      .run(output, now, responseId, callId);
    return Number(result.changes) > 0;
  }

  /** 是否存在未完成（emitted）的工具调用。 */
  hasPending(responseId: string): boolean {
    const row = asRow<{ count: number }>(
      this.#db
        .prepare("SELECT COUNT(*) AS count FROM tool_calls WHERE response_id = ? AND status = 'emitted'")
        .get(responseId),
    );
    return (row?.count ?? 0) > 0;
  }
}
