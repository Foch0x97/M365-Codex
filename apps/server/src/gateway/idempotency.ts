import { createHash } from 'node:crypto';
import { ApiError } from '@m365-codex/shared';
import type { Database } from '../db/index.js';
import { asRow } from '../db/index.js';

/**
 * 请求幂等（对应实施计划 §18）。
 *
 * 规则：同一 API Key + 端点 + `Idempotency-Key` 返回同一个创建结果。
 * 关键约束是**不重复提交可能产生工具调用的上游请求**——重放一次
 * `POST /v1/responses` 意味着模型可能再决定执行一次有副作用的工具。
 *
 * 请求体指纹一并入库：同一把幂等键配不同的请求体属于客户端用错了键，
 * 必须报错而不是返回上一次的结果（否则会静默把两个不同请求当成一个）。
 *
 * 并发同键：靠唯一索引让第二个请求插入失败，转而等待/复用第一个的结果，
 * 而不是两个都打上游。
 */

export type IdempotencyState = 'in_progress' | 'completed';

export interface IdempotencyRow {
  key: string;
  api_key_id: string;
  endpoint: string;
  request_fingerprint: string;
  state: IdempotencyState;
  response_id: string | null;
  status_code: number | null;
  body: string | null;
  created_at: number;
  updated_at: number;
}

/** 对请求体做稳定指纹：键排序后哈希，避免字段顺序不同被误判成不同请求。 */
export function fingerprintRequest(body: unknown): string {
  return createHash('sha256').update(stableStringify(body)).digest('hex');
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

export interface BeginResult {
  /** 已有完成结果，直接回放 */
  replay?: { statusCode: number; body: unknown; responseId: string | null };
  /** 同键请求仍在处理中 */
  inProgress?: boolean;
  /** 本次是首次，调用方继续正常处理，完成后调用 complete() */
  fresh?: boolean;
}

export class IdempotencyStore {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  /**
   * 登记一次幂等请求。
   * 返回该回放、该等待，还是首次执行。
   */
  begin(input: {
    key: string;
    apiKeyId: string;
    endpoint: string;
    fingerprint: string;
    now?: number;
  }): BeginResult {
    const now = input.now ?? Date.now();
    const existing = this.#find(input.key, input.apiKeyId, input.endpoint);

    if (existing !== undefined) {
      if (existing.request_fingerprint !== input.fingerprint) {
        throw new ApiError({
          type: 'idempotency_error',
          status: 409,
          message: '同一个 Idempotency-Key 被用于内容不同的请求',
        });
      }
      if (existing.state === 'completed' && existing.body !== null) {
        return {
          replay: {
            statusCode: existing.status_code ?? 200,
            body: JSON.parse(existing.body) as unknown,
            responseId: existing.response_id,
          },
        };
      }
      return { inProgress: true };
    }

    try {
      this.#db
        .prepare(
          `INSERT INTO idempotency_keys
             (key, api_key_id, endpoint, request_fingerprint, state, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'in_progress', ?, ?)`,
        )
        .run(input.key, input.apiKeyId, input.endpoint, input.fingerprint, now, now);
      return { fresh: true };
    } catch {
      // 并发下另一个请求刚插进去：让本次走「处理中」，不重复打上游
      return { inProgress: true };
    }
  }

  /** 处理成功后落库最终结果，供后续同键请求回放。 */
  complete(input: {
    key: string;
    apiKeyId: string;
    endpoint: string;
    statusCode: number;
    body: unknown;
    responseId?: string | null;
    now?: number;
  }): void {
    this.#db
      .prepare(
        `UPDATE idempotency_keys
            SET state = 'completed', status_code = ?, body = ?, response_id = ?, updated_at = ?
          WHERE key = ? AND api_key_id = ? AND endpoint = ?`,
      )
      .run(
        input.statusCode,
        JSON.stringify(input.body),
        input.responseId ?? null,
        input.now ?? Date.now(),
        input.key,
        input.apiKeyId,
        input.endpoint,
      );
  }

  /**
   * 处理失败时释放这把键。
   * 失败的请求不该把幂等键永久占住——客户端重试同一把键应当能重新执行。
   */
  release(key: string, apiKeyId: string, endpoint: string): void {
    this.#db
      .prepare("DELETE FROM idempotency_keys WHERE key = ? AND api_key_id = ? AND endpoint = ? AND state = 'in_progress'")
      .run(key, apiKeyId, endpoint);
  }

  /** 清理过期记录（§18 定时清理）。 */
  purgeOlderThan(cutoff: number): number {
    const result = this.#db.prepare('DELETE FROM idempotency_keys WHERE created_at < ?').run(cutoff);
    return Number(result.changes);
  }

  #find(key: string, apiKeyId: string, endpoint: string): IdempotencyRow | undefined {
    return asRow<IdempotencyRow>(
      this.#db
        .prepare('SELECT * FROM idempotency_keys WHERE key = ? AND api_key_id = ? AND endpoint = ?')
        .get(key, apiKeyId, endpoint),
    );
  }
}
