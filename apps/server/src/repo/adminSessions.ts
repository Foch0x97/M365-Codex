import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { ADMIN_SESSION_TTL_MS } from '@m365-codex/shared';
import { asRow, type Database } from '../db/index.js';

/** 管理端会话：库中只存令牌哈希，明文令牌只在登录响应里出现一次。 */

export interface AdminSessionRow {
  id: string;
  token_hash: string;
  created_at: number;
  expires_at: number;
  last_seen_at: number | null;
  client_ip: string | null;
}

export interface IssuedAdminSession {
  token: string;
  expiresAt: number;
}

function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export class AdminSessionRepository {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  issue(clientIp: string | null, now = Date.now(), ttlMs = ADMIN_SESSION_TTL_MS): IssuedAdminSession {
    const token = randomBytes(32).toString('base64url');
    const expiresAt = now + ttlMs;
    this.#db
      .prepare(
        `INSERT INTO admin_sessions (id, token_hash, created_at, expires_at, last_seen_at, client_ip)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(randomUUID(), hashToken(token), now, expiresAt, now, clientIp);
    return { token, expiresAt };
  }

  /** 校验令牌；有效则顺带刷新 last_seen_at。过期会话即时删除。 */
  verify(token: string, now = Date.now()): AdminSessionRow | undefined {
    const row = asRow<AdminSessionRow>(
      this.#db.prepare('SELECT * FROM admin_sessions WHERE token_hash = ?').get(hashToken(token)),
    );
    if (row === undefined) return undefined;
    if (row.expires_at <= now) {
      this.#db.prepare('DELETE FROM admin_sessions WHERE id = ?').run(row.id);
      return undefined;
    }
    this.#db.prepare('UPDATE admin_sessions SET last_seen_at = ? WHERE id = ?').run(now, row.id);
    return row;
  }

  revoke(token: string): boolean {
    const result = this.#db
      .prepare('DELETE FROM admin_sessions WHERE token_hash = ?')
      .run(hashToken(token));
    return Number(result.changes) > 0;
  }

  revokeAll(): number {
    return Number(this.#db.prepare('DELETE FROM admin_sessions').run().changes);
  }

  purgeExpired(now = Date.now()): number {
    return Number(this.#db.prepare('DELETE FROM admin_sessions WHERE expires_at <= ?').run(now).changes);
  }
}
