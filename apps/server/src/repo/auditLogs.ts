import { randomUUID } from 'node:crypto';
import { asRows, type Database } from '../db/index.js';

/**
 * 审计日志：记录「谁在什么时候做了什么」。
 * detail 只允许写入非敏感的结构化摘要，严禁写入 Token、密码、明文 API Key。
 */

export interface AuditLogRow {
  id: string;
  actor: string;
  action: string;
  target: string | null;
  detail: string | null;
  client_ip: string | null;
  created_at: number;
}

export interface AuditEvent {
  actor: string;
  action: string;
  target?: string | null;
  detail?: Record<string, unknown> | null;
  clientIp?: string | null;
}

export class AuditLogRepository {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  record(event: AuditEvent, now = Date.now()): void {
    this.#db
      .prepare(
        `INSERT INTO audit_logs (id, actor, action, target, detail, client_ip, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        event.actor,
        event.action,
        event.target ?? null,
        event.detail == null ? null : JSON.stringify(event.detail),
        event.clientIp ?? null,
        now,
      );
  }

  recent(limit = 100): AuditLogRow[] {
    return asRows<AuditLogRow>(
      this.#db.prepare('SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT ?').all(limit),
    );
  }

  /** 清理早于 cutoff 的审计日志（对应实施计划 §18 定时清理）。 */
  purgeOlderThan(cutoff: number): number {
    const result = this.#db.prepare('DELETE FROM audit_logs WHERE created_at < ?').run(cutoff);
    return Number(result.changes);
  }
}
