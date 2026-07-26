import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import type { AccountStatus } from '@m365-codex/shared';
import type { Cryptor, SealedValue } from '../crypto/index.js';
import { asRow, asRows, type Database } from '../db/index.js';
import type { Metrics } from '../observability/metrics.js';

/**
 * 账号与 Token 的数据访问层。
 *
 * 铁律：Token 明文只在内存中短暂存在，落库前必须经 Cryptor 加密；
 * 本文件不做任何日志输出，杜绝 Token 顺着日志泄漏。
 */

export interface AccountRow {
  id: string;
  tid: string;
  oid: string;
  email: string | null;
  display_name: string | null;
  status: AccountStatus;
  proxy_node_id: string | null;
  source: string;
  created_at: number;
  updated_at: number;
}

export interface AccountTokenRow {
  account_id: string;
  access_token_enc: Uint8Array | null;
  access_nonce: Uint8Array | null;
  refresh_token_enc: Uint8Array | null;
  refresh_nonce: Uint8Array | null;
  key_version: number;
  expires_at: number | null;
  rotated_at: number | null;
}

export interface AccountHealthRow {
  account_id: string;
  last_ok_at: number | null;
  last_error_at: number | null;
  last_error_type: string | null;
  consecutive_failures: number;
  cooldown_until: number | null;
  updated_at: number;
}

/** 对外展示的账号视图，绝不含 Token。 */
export interface AccountView {
  id: string;
  tid: string;
  oid: string;
  email: string | null;
  display_name: string | null;
  status: AccountStatus;
  source: string;
  /** 绑定的出口代理节点 ID（契约 §2.4），未绑定为 null */
  proxy_node_id: string | null;
  created_at: number;
  updated_at: number;
  token_expires_at: number | null;
  token_rotated_at: number | null;
  has_refresh_token: boolean;
  consecutive_failures: number;
  cooldown_until: number | null;
  last_ok_at: number | null;
  last_error_type: string | null;
}

/** 写入账号时携带的 Token 明文。调用方负责尽快丢弃这些字符串。 */
export interface TokenMaterial {
  accessToken: string;
  refreshToken: string | null;
  /** 毫秒 epoch */
  expiresAt: number | null;
}

export interface UpsertAccountInput {
  tid: string;
  oid: string;
  email: string | null;
  displayName: string | null;
  /** 来源标记：`oauth`（本机授权）或 `import:<名称>`（外部导入） */
  source: string;
  tokens: TokenMaterial;
}

/**
 * 允许的状态迁移。
 * 收敛在一处而不是散落在业务代码里，避免出现「谁都能把账号改成 online」。
 */
const ALLOWED_TRANSITIONS: Readonly<Record<AccountStatus, readonly AccountStatus[]>> = {
  probing: ['online', 'unsupported', 'reauth_required', 'error', 'disabled'],
  online: ['busy', 'cooldown', 'reauth_required', 'error', 'disabled', 'probing'],
  busy: ['online', 'cooldown', 'reauth_required', 'error', 'disabled'],
  cooldown: ['online', 'probing', 'reauth_required', 'error', 'disabled'],
  reauth_required: ['probing', 'online', 'disabled', 'error'],
  // 停用是人工动作，只能人工恢复到 probing 重新探测
  disabled: ['probing'],
  unsupported: ['probing', 'disabled'],
  error: ['probing', 'online', 'cooldown', 'reauth_required', 'disabled'],
};

export function canTransition(from: AccountStatus, to: AccountStatus): boolean {
  if (from === to) return true;
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export class InvalidStateTransitionError extends Error {
  constructor(from: AccountStatus, to: AccountStatus) {
    super(`账号状态不允许从 ${from} 迁移到 ${to}`);
    this.name = 'InvalidStateTransitionError';
  }
}

function toBuffer(value: Uint8Array | null): Buffer | null {
  if (value === null) return null;
  return Buffer.isBuffer(value) ? value : Buffer.from(value);
}

export class AccountRepository {
  readonly #db: Database;
  readonly #cryptor: Cryptor;
  /** M8：账号状态迁移打点（§17），可选——不传时（多数单测直接构造本类）静默跳过。 */
  readonly #metrics: Metrics | undefined;

  constructor(db: Database, cryptor: Cryptor, metrics?: Metrics) {
    this.#db = db;
    this.#cryptor = cryptor;
    this.#metrics = metrics;
  }

  /**
   * 按 (tid, oid) 唯一键新增或更新账号，并原子地替换 Token。
   * 重复授权同一账号只会更新，不会在池里产生重复条目。
   */
  upsert(input: UpsertAccountInput, now = Date.now()): AccountView {
    const existing = this.findByTenantObject(input.tid, input.oid);
    const id = existing?.id ?? randomUUID();
    // 重新授权说明凭据刚刚更新，回到 probing 由后续探测决定是否 online；
    // 但人工停用的账号不因一次授权被悄悄启用
    const nextStatus: AccountStatus =
      existing === undefined ? 'probing' : existing.status === 'disabled' ? 'disabled' : 'probing';

    const sealedAccess = this.#cryptor.seal(input.tokens.accessToken, `account:${id}:access`);
    const sealedRefresh =
      input.tokens.refreshToken === null
        ? null
        : this.#cryptor.seal(input.tokens.refreshToken, `account:${id}:refresh`);

    this.#db.exec('BEGIN IMMEDIATE');
    try {
      if (existing === undefined) {
        this.#db
          .prepare(
            `INSERT INTO accounts (id, tid, oid, email, display_name, status, source, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(id, input.tid, input.oid, input.email, input.displayName, nextStatus, input.source, now, now);
        this.#db
          .prepare('INSERT INTO account_health (account_id, updated_at) VALUES (?, ?)')
          .run(id, now);
      } else {
        this.#db
          .prepare(
            `UPDATE accounts SET email = ?, display_name = ?, status = ?, source = ?, updated_at = ?
             WHERE id = ?`,
          )
          .run(input.email, input.displayName, nextStatus, input.source, now, id);
      }

      this.#db
        .prepare(
          `INSERT INTO account_tokens (
             account_id, access_token_enc, access_nonce, refresh_token_enc, refresh_nonce,
             key_version, expires_at, rotated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (account_id) DO UPDATE SET
             access_token_enc = excluded.access_token_enc,
             access_nonce = excluded.access_nonce,
             refresh_token_enc = excluded.refresh_token_enc,
             refresh_nonce = excluded.refresh_nonce,
             key_version = excluded.key_version,
             expires_at = excluded.expires_at,
             rotated_at = excluded.rotated_at`,
        )
        .run(
          id,
          sealedAccess.ciphertext,
          sealedAccess.nonce,
          sealedRefresh?.ciphertext ?? null,
          sealedRefresh?.nonce ?? null,
          sealedAccess.keyVersion,
          input.tokens.expiresAt,
          now,
        );
      this.#db.exec('COMMIT');
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }

    const view = this.getView(id);
    if (view === undefined) throw new Error('账号写入后立即读取失败');
    return view;
  }

  /** 只替换 Token，不动账号身份字段。用于刷新流程的原子写回。 */
  replaceTokens(accountId: string, tokens: TokenMaterial, now = Date.now()): void {
    const sealedAccess = this.#cryptor.seal(tokens.accessToken, `account:${accountId}:access`);
    const sealedRefresh =
      tokens.refreshToken === null
        ? null
        : this.#cryptor.seal(tokens.refreshToken, `account:${accountId}:refresh`);

    this.#db.exec('BEGIN IMMEDIATE');
    try {
      // refresh_token 为空时保留原值：Microsoft 并非每次刷新都下发新的 refresh_token
      this.#db
        .prepare(
          `UPDATE account_tokens SET
             access_token_enc = ?, access_nonce = ?,
             refresh_token_enc = COALESCE(?, refresh_token_enc),
             refresh_nonce = COALESCE(?, refresh_nonce),
             key_version = ?, expires_at = ?, rotated_at = ?
           WHERE account_id = ?`,
        )
        .run(
          sealedAccess.ciphertext,
          sealedAccess.nonce,
          sealedRefresh?.ciphertext ?? null,
          sealedRefresh?.nonce ?? null,
          sealedAccess.keyVersion,
          tokens.expiresAt,
          now,
          accountId,
        );
      this.#db.prepare('UPDATE accounts SET updated_at = ? WHERE id = ?').run(now, accountId);
      this.#db.exec('COMMIT');
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  /** 解密取出 access token。账号不存在或无 Token 时返回 null。 */
  readAccessToken(accountId: string): { token: string; expiresAt: number | null } | null {
    const row = this.#tokenRow(accountId);
    if (row?.access_token_enc == null || row.access_nonce == null) return null;
    const sealed: SealedValue = {
      ciphertext: toBuffer(row.access_token_enc) as Buffer,
      nonce: toBuffer(row.access_nonce) as Buffer,
      keyVersion: row.key_version,
    };
    return {
      token: this.#cryptor.open(sealed, `account:${accountId}:access`),
      expiresAt: row.expires_at,
    };
  }

  readRefreshToken(accountId: string): string | null {
    const row = this.#tokenRow(accountId);
    if (row?.refresh_token_enc == null || row.refresh_nonce == null) return null;
    const sealed: SealedValue = {
      ciphertext: toBuffer(row.refresh_token_enc) as Buffer,
      nonce: toBuffer(row.refresh_nonce) as Buffer,
      keyVersion: row.key_version,
    };
    return this.#cryptor.open(sealed, `account:${accountId}:refresh`);
  }

  findById(id: string): AccountRow | undefined {
    return asRow<AccountRow>(this.#db.prepare('SELECT * FROM accounts WHERE id = ?').get(id));
  }

  findByTenantObject(tid: string, oid: string): AccountRow | undefined {
    return asRow<AccountRow>(
      this.#db.prepare('SELECT * FROM accounts WHERE tid = ? AND oid = ?').get(tid, oid),
    );
  }

  getView(id: string): AccountView | undefined {
    const account = this.findById(id);
    if (account === undefined) return undefined;
    const tokens = this.#tokenRow(id);
    const health = asRow<AccountHealthRow>(
      this.#db.prepare('SELECT * FROM account_health WHERE account_id = ?').get(id),
    );
    return {
      id: account.id,
      tid: account.tid,
      oid: account.oid,
      email: account.email,
      display_name: account.display_name,
      status: account.status,
      source: account.source,
      proxy_node_id: account.proxy_node_id,
      created_at: account.created_at,
      updated_at: account.updated_at,
      token_expires_at: tokens?.expires_at ?? null,
      token_rotated_at: tokens?.rotated_at ?? null,
      has_refresh_token: tokens?.refresh_token_enc != null,
      consecutive_failures: health?.consecutive_failures ?? 0,
      cooldown_until: health?.cooldown_until ?? null,
      last_ok_at: health?.last_ok_at ?? null,
      last_error_type: health?.last_error_type ?? null,
    };
  }

  listViews(): AccountView[] {
    const rows = asRows<AccountRow>(
      this.#db.prepare('SELECT id FROM accounts ORDER BY created_at ASC').all(),
    );
    return rows
      .map((row) => this.getView(row.id))
      .filter((view): view is AccountView => view !== undefined);
  }

  /** 按状态机迁移账号状态；非法迁移抛错而不是悄悄写入。 */
  setStatus(accountId: string, next: AccountStatus, now = Date.now()): AccountView {
    const account = this.findById(accountId);
    if (account === undefined) throw new Error(`账号不存在：${accountId}`);
    if (!canTransition(account.status, next)) {
      throw new InvalidStateTransitionError(account.status, next);
    }
    this.#db.prepare('UPDATE accounts SET status = ?, updated_at = ? WHERE id = ?').run(next, now, accountId);
    this.#metrics?.accountStates.inc({ from: account.status, to: next });
    const view = this.getView(accountId);
    if (view === undefined) throw new Error('状态更新后读取失败');
    return view;
  }

  /** 强制设置状态，绕过状态机。仅用于管理员显式操作，会写审计。 */
  forceStatus(accountId: string, next: AccountStatus, now = Date.now()): AccountView | undefined {
    const before = this.findById(accountId);
    this.#db.prepare('UPDATE accounts SET status = ?, updated_at = ? WHERE id = ?').run(next, now, accountId);
    if (before !== undefined) this.#metrics?.accountStates.inc({ from: before.status, to: next });
    return this.getView(accountId);
  }

  recordSuccess(accountId: string, now = Date.now()): void {
    this.#db
      .prepare(
        `UPDATE account_health SET
           last_ok_at = ?, consecutive_failures = 0, cooldown_until = NULL,
           last_error_type = NULL, updated_at = ?
         WHERE account_id = ?`,
      )
      .run(now, now, accountId);
  }

  recordFailure(
    accountId: string,
    errorType: string,
    options: { cooldownUntil?: number | null } = {},
    now = Date.now(),
  ): void {
    this.#db
      .prepare(
        `UPDATE account_health SET
           last_error_at = ?, last_error_type = ?,
           consecutive_failures = consecutive_failures + 1,
           cooldown_until = ?, updated_at = ?
         WHERE account_id = ?`,
      )
      .run(now, errorType, options.cooldownUntil ?? null, now, accountId);
  }

  /** 绑定/解绑出口代理（契约 §2.4 `POST /admin/accounts/:id/proxy`）；传 null 解绑。 */
  setProxyNode(accountId: string, proxyNodeId: string | null, now = Date.now()): AccountView | undefined {
    this.#db
      .prepare('UPDATE accounts SET proxy_node_id = ?, updated_at = ? WHERE id = ?')
      .run(proxyNodeId, now, accountId);
    return this.getView(accountId);
  }

  /**
   * 删除账号。
   *
   * `account_tokens` 与 `account_health` 是 ON DELETE CASCADE，会自己跟着走；
   * 但 `responses.account_id` 与 `conversation_bindings.account_id` 只是普通外键，
   * 账号一旦服务过请求就会把它钉死在库里——直接 DELETE 会撞 FOREIGN KEY constraint。
   *
   * 两张表的处置不同，因为语义不同：
   * - `responses` 是历史记录，**留下来**，只把 account_id 置空（这条请求确实发生过，
   *   只是不再知道由哪个账号承担；列本来就可空）；
   * - `conversation_bindings` 是「Response ↔ 账号 ↔ 上游会话」的粘性绑定，
   *   账号没了绑定就没有意义，**直接删掉**，免得留下指向空账号的僵尸行。
   */
  remove(accountId: string): boolean {
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      this.#db.prepare('DELETE FROM conversation_bindings WHERE account_id = ?').run(accountId);
      this.#db.prepare('UPDATE responses SET account_id = NULL WHERE account_id = ?').run(accountId);
      const changes = Number(
        this.#db.prepare('DELETE FROM accounts WHERE id = ?').run(accountId).changes,
      );
      this.#db.exec('COMMIT');
      return changes > 0;
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  #tokenRow(accountId: string): AccountTokenRow | undefined {
    return asRow<AccountTokenRow>(
      this.#db.prepare('SELECT * FROM account_tokens WHERE account_id = ?').get(accountId),
    );
  }
}
