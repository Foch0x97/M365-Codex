import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import type { Cryptor, SealedValue } from '../crypto/index.js';
import { asRow, asRows, type Database } from '../db/index.js';

/**
 * 出口代理池的数据访问层（对应实施计划 §13.1、§M7）。
 *
 * `url` 里可能带用户名密码，属于凭据，与 Token 同规格 AES-256-GCM 加密存储，
 * 独立 nonce。对外展示一律走 `maskProxyUrl`，明文永不离开这个文件。
 */

export type ProxyStatus = 'unknown' | 'healthy' | 'unhealthy';
export type ProxyProtocol = 'http' | 'https' | 'socks5';

export interface ProxyNodeRow {
  id: string;
  name: string;
  url_enc: Uint8Array;
  url_nonce: Uint8Array;
  key_version: number;
  protocol: ProxyProtocol;
  weight: number;
  priority: number;
  enabled: number;
  status: ProxyStatus;
  latency_ms: number | null;
  last_check_at: number | null;
  failure_count: number;
  cooldown_until: number | null;
  created_at: number;
  updated_at: number;
}

export interface CreateProxyNodeInput {
  name: string;
  url: string;
  weight?: number;
  priority?: number;
  enabled?: boolean;
}

export interface UpdateProxyNodeInput {
  name?: string;
  url?: string;
  weight?: number;
  priority?: number;
  enabled?: boolean;
}

export interface ProxyCheckResult {
  status: ProxyStatus;
  latencyMs: number | null;
  failureCount: number;
  cooldownUntil: number | null;
}

/** 从 URL 推断协议；无法识别的一律归为 http（最常见的形态）。 */
export function protocolOf(url: string): ProxyProtocol {
  const scheme = url.split('://')[0]?.toLowerCase() ?? '';
  if (scheme === 'socks5' || scheme === 'socks5h') return 'socks5';
  if (scheme === 'https') return 'https';
  return 'http';
}

/**
 * 打码：只保留协议与主机:端口，用户名密码整体替换为 `***:***`。
 * 解析失败（形态非法）时整体打码，绝不把原串透出去。
 */
export function maskProxyUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const auth = parsed.username !== '' ? '***:***@' : '';
    return `${parsed.protocol}//${auth}${parsed.host}${parsed.pathname === '/' ? '' : parsed.pathname}`;
  } catch {
    return '***';
  }
}

export interface ProxyNodeView {
  id: string;
  name: string;
  url_masked: string;
  protocol: ProxyProtocol;
  weight: number;
  priority: number;
  enabled: boolean;
  status: ProxyStatus;
  latency_ms: number | null;
  last_check_at: number | null;
  failure_count: number;
  cooldown_until: number | null;
  bound_accounts: string[];
  created_at: number;
  updated_at: number;
}

export class ProxyNodeRepository {
  readonly #db: Database;
  readonly #cryptor: Cryptor;

  constructor(db: Database, cryptor: Cryptor) {
    this.#db = db;
    this.#cryptor = cryptor;
  }

  create(input: CreateProxyNodeInput, now = Date.now()): ProxyNodeRow {
    const id = randomUUID();
    const sealed = this.#cryptor.seal(input.url, `proxy:${id}`);
    this.#db
      .prepare(
        `INSERT INTO proxy_nodes (
           id, name, url_enc, url_nonce, key_version, protocol, weight, priority,
           enabled, status, failure_count, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'unknown', 0, ?, ?)`,
      )
      .run(
        id,
        input.name,
        sealed.ciphertext,
        sealed.nonce,
        sealed.keyVersion,
        protocolOf(input.url),
        input.weight ?? 1,
        input.priority ?? 0,
        input.enabled === false ? 0 : 1,
        now,
        now,
      );
    const row = this.findById(id);
    if (row === undefined) throw new Error('代理节点创建后立即读取失败');
    return row;
  }

  findById(id: string): ProxyNodeRow | undefined {
    return asRow<ProxyNodeRow>(this.#db.prepare('SELECT * FROM proxy_nodes WHERE id = ?').get(id));
  }

  list(): ProxyNodeRow[] {
    return asRows<ProxyNodeRow>(
      this.#db.prepare('SELECT * FROM proxy_nodes ORDER BY priority DESC, created_at ASC').all(),
    );
  }

  /** 解密出明文 URL。仅供内部转发用（拨号、健康检查），绝不对外返回。 */
  decryptUrl(row: ProxyNodeRow): string {
    const sealed: SealedValue = {
      ciphertext: Buffer.isBuffer(row.url_enc) ? row.url_enc : Buffer.from(row.url_enc),
      nonce: Buffer.isBuffer(row.url_nonce) ? row.url_nonce : Buffer.from(row.url_nonce),
      keyVersion: row.key_version,
    };
    return this.#cryptor.open(sealed, `proxy:${row.id}`);
  }

  /** 供调度器/OAuth 客户端解析账号绑定的出口：节点不存在或已停用一律视为不可用。 */
  resolveActiveUrl(id: string): string | null {
    const row = this.findById(id);
    if (row === undefined || row.enabled !== 1) return null;
    return this.decryptUrl(row);
  }

  update(id: string, input: UpdateProxyNodeInput, now = Date.now()): ProxyNodeRow | undefined {
    const existing = this.findById(id);
    if (existing === undefined) return undefined;

    let urlEnc = existing.url_enc;
    let urlNonce = existing.url_nonce;
    let keyVersion = existing.key_version;
    let protocol = existing.protocol;
    if (input.url !== undefined) {
      const sealed = this.#cryptor.seal(input.url, `proxy:${id}`);
      urlEnc = sealed.ciphertext;
      urlNonce = sealed.nonce;
      keyVersion = sealed.keyVersion;
      protocol = protocolOf(input.url);
    }

    this.#db
      .prepare(
        `UPDATE proxy_nodes SET
           name = ?, url_enc = ?, url_nonce = ?, key_version = ?, protocol = ?,
           weight = ?, priority = ?, enabled = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        input.name ?? existing.name,
        urlEnc,
        urlNonce,
        keyVersion,
        protocol,
        input.weight ?? existing.weight,
        input.priority ?? existing.priority,
        input.enabled === undefined ? existing.enabled : input.enabled ? 1 : 0,
        now,
        id,
      );
    return this.findById(id);
  }

  remove(id: string): boolean {
    return Number(this.#db.prepare('DELETE FROM proxy_nodes WHERE id = ?').run(id).changes) > 0;
  }

  /** 健康检查结果写回：延迟、失败计数、冷却窗口（对应实施计划 §13.1）。 */
  recordCheck(id: string, result: ProxyCheckResult, now = Date.now()): void {
    this.#db
      .prepare(
        `UPDATE proxy_nodes SET
           status = ?, latency_ms = ?, last_check_at = ?, failure_count = ?, cooldown_until = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(result.status, result.latencyMs, now, result.failureCount, result.cooldownUntil, now, id);
  }

  /** 该节点当前绑定的账号 ID 列表。 */
  boundAccountIds(id: string): string[] {
    const rows = asRows<{ id: string }>(
      this.#db.prepare('SELECT id FROM accounts WHERE proxy_node_id = ?').all(id),
    );
    return rows.map((r) => r.id);
  }
}

/** 组装对外视图。`urlMasked` 必须由调用方用 `maskProxyUrl(repo.decryptUrl(row))` 算好传入。 */
export function toProxyNodeView(row: ProxyNodeRow, urlMasked: string, boundAccounts: string[]): ProxyNodeView {
  return {
    id: row.id,
    name: row.name,
    url_masked: urlMasked,
    protocol: row.protocol,
    weight: row.weight,
    priority: row.priority,
    enabled: row.enabled === 1,
    status: row.status,
    latency_ms: row.latency_ms,
    last_check_at: row.last_check_at,
    failure_count: row.failure_count,
    cooldown_until: row.cooldown_until,
    bound_accounts: boundAccounts,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}
