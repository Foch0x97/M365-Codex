import { randomUUID } from 'node:crypto';
import type { ApiKeyView } from '@m365-codex/shared';
import { generateApiKey, maskApiKey } from '../crypto/apiKey.js';
import { asRow, asRows, type Database } from '../db/index.js';

/** API Key 数据访问层。库中永不出现明文 Key。 */

export interface ApiKeyRow {
  id: string;
  name: string;
  prefix: string;
  salt: string;
  hash: string;
  enabled: number;
  revoked_at: number | null;
  starts_at: number | null;
  expires_at: number | null;
  rpm_limit: number | null;
  daily_limit: number | null;
  max_concurrency: number | null;
  allowed_endpoints: string | null;
  allowed_models: string | null;
  created_at: number;
  last_used_at: number | null;
  last_used_ip: string | null;
  /** 备注，纯展示用，不参与任何鉴权/限额判定 */
  note: string | null;
  /** 累计请求次数（管理界面用量展示），随 touch() 一起递增，不在热路径上单独多一次写 */
  request_count: number;
  /** 按 Key 收紧的工具调用次数上限（对话链累计），null 表示不额外收紧，只受全局天花板约束 */
  max_tool_calls: number | null;
  /** 按 Key 收紧的单文件/单个上传分片大小上限（字节），null 表示不额外收紧 */
  max_file_bytes: number | null;
}

/**
 * `ApiKeyView`/`ApiKeyCreated`（`@m365-codex/shared`）还没收进这四个字段——
 * 本次改动范围限定在 `apps/server/**`，不改共享包（避免和同时改 `apps/web`
 * 的另一处改动冲突）。这里在 server 内部扩展一层，字段值仍原样通过 JSON
 * 返回给管理界面；后续若要给 WebUI 提供静态类型，再把这几个字段合并进
 * `packages/shared` 的公共契约类型。
 */
export interface ApiKeyViewExt extends ApiKeyView {
  note: string | null;
  request_count: number;
  max_tool_calls: number | null;
  max_file_bytes: number | null;
}

export interface ApiKeyCreatedExt extends ApiKeyViewExt {
  /** 明文 API Key，仅创建时返回一次，服务端不保存 */
  key: string;
}

export interface CreateApiKeyInput {
  name: string;
  startsAt?: number | null;
  expiresAt?: number | null;
  rpmLimit?: number | null;
  dailyLimit?: number | null;
  maxConcurrency?: number | null;
  allowedEndpoints?: string[] | null;
  allowedModels?: string[] | null;
  note?: string | null;
  maxToolCalls?: number | null;
  maxFileBytes?: number | null;
}

export interface UpdateApiKeyInput {
  name?: string;
  enabled?: boolean;
  startsAt?: number | null;
  expiresAt?: number | null;
  rpmLimit?: number | null;
  dailyLimit?: number | null;
  maxConcurrency?: number | null;
  allowedEndpoints?: string[] | null;
  allowedModels?: string[] | null;
  note?: string | null;
  maxToolCalls?: number | null;
  maxFileBytes?: number | null;
}

/** 导出给 `gateway/rateLimit.ts` 复用，避免第二份 JSON 解析逻辑。 */
export function parseList(value: string | null): string[] | null {
  if (value === null || value === '') return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : null;
  } catch {
    return null;
  }
}

function serializeList(value: string[] | null | undefined): string | null {
  if (value === null || value === undefined || value.length === 0) return null;
  return JSON.stringify(value);
}

export function toApiKeyView(row: ApiKeyRow): ApiKeyViewExt {
  return {
    id: row.id,
    name: row.name,
    masked_key: maskApiKey(row.prefix),
    enabled: row.enabled === 1,
    created_at: row.created_at,
    starts_at: row.starts_at,
    expires_at: row.expires_at,
    revoked_at: row.revoked_at,
    last_used_at: row.last_used_at,
    rpm_limit: row.rpm_limit,
    daily_limit: row.daily_limit,
    max_concurrency: row.max_concurrency,
    allowed_endpoints: parseList(row.allowed_endpoints),
    allowed_models: parseList(row.allowed_models),
    note: row.note,
    request_count: row.request_count,
    max_tool_calls: row.max_tool_calls,
    max_file_bytes: row.max_file_bytes,
  };
}

export class ApiKeyRepository {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  create(input: CreateApiKeyInput, now = Date.now()): ApiKeyCreatedExt {
    const generated = generateApiKey();
    const id = randomUUID();
    this.#db
      .prepare(
        `INSERT INTO api_keys (
           id, name, prefix, salt, hash, enabled, starts_at, expires_at,
           rpm_limit, daily_limit, max_concurrency, allowed_endpoints, allowed_models, created_at,
           note, max_tool_calls, max_file_bytes
         ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.name,
        generated.prefix,
        generated.salt,
        generated.hash,
        input.startsAt ?? null,
        input.expiresAt ?? null,
        input.rpmLimit ?? null,
        input.dailyLimit ?? null,
        input.maxConcurrency ?? null,
        serializeList(input.allowedEndpoints),
        serializeList(input.allowedModels),
        now,
        input.note ?? null,
        input.maxToolCalls ?? null,
        input.maxFileBytes ?? null,
      );

    const row = this.getRowById(id);
    if (row === undefined) {
      throw new Error('API Key 创建后立即读取失败');
    }
    return { ...toApiKeyView(row), key: generated.key };
  }

  getRowById(id: string): ApiKeyRow | undefined {
    return asRow<ApiKeyRow>(this.#db.prepare('SELECT * FROM api_keys WHERE id = ?').get(id));
  }

  /** 前缀可能重复（概率极低），返回全部候选交由调用方逐一做恒定时间校验。 */
  findByPrefix(prefix: string): ApiKeyRow[] {
    return asRows<ApiKeyRow>(this.#db.prepare('SELECT * FROM api_keys WHERE prefix = ?').all(prefix));
  }

  list(): ApiKeyViewExt[] {
    const rows = asRows<ApiKeyRow>(
      this.#db.prepare('SELECT * FROM api_keys ORDER BY created_at DESC').all(),
    );
    return rows.map(toApiKeyView);
  }

  update(id: string, input: UpdateApiKeyInput): ApiKeyViewExt | undefined {
    const existing = this.getRowById(id);
    if (existing === undefined) return undefined;

    const next = {
      name: input.name ?? existing.name,
      enabled: input.enabled === undefined ? existing.enabled : input.enabled ? 1 : 0,
      starts_at: input.startsAt === undefined ? existing.starts_at : input.startsAt,
      expires_at: input.expiresAt === undefined ? existing.expires_at : input.expiresAt,
      rpm_limit: input.rpmLimit === undefined ? existing.rpm_limit : input.rpmLimit,
      daily_limit: input.dailyLimit === undefined ? existing.daily_limit : input.dailyLimit,
      max_concurrency:
        input.maxConcurrency === undefined ? existing.max_concurrency : input.maxConcurrency,
      allowed_endpoints:
        input.allowedEndpoints === undefined
          ? existing.allowed_endpoints
          : serializeList(input.allowedEndpoints),
      allowed_models:
        input.allowedModels === undefined ? existing.allowed_models : serializeList(input.allowedModels),
      note: input.note === undefined ? existing.note : input.note,
      max_tool_calls: input.maxToolCalls === undefined ? existing.max_tool_calls : input.maxToolCalls,
      max_file_bytes: input.maxFileBytes === undefined ? existing.max_file_bytes : input.maxFileBytes,
    };

    this.#db
      .prepare(
        `UPDATE api_keys SET
           name = ?, enabled = ?, starts_at = ?, expires_at = ?,
           rpm_limit = ?, daily_limit = ?, max_concurrency = ?,
           allowed_endpoints = ?, allowed_models = ?,
           note = ?, max_tool_calls = ?, max_file_bytes = ?
         WHERE id = ?`,
      )
      .run(
        next.name,
        next.enabled,
        next.starts_at,
        next.expires_at,
        next.rpm_limit,
        next.daily_limit,
        next.max_concurrency,
        next.allowed_endpoints,
        next.allowed_models,
        next.note,
        next.max_tool_calls,
        next.max_file_bytes,
        id,
      );

    const row = this.getRowById(id);
    return row === undefined ? undefined : toApiKeyView(row);
  }

  /** 撤销：保留记录用于审计，但立即失效。 */
  revoke(id: string, now = Date.now()): ApiKeyViewExt | undefined {
    const existing = this.getRowById(id);
    if (existing === undefined) return undefined;
    this.#db
      .prepare('UPDATE api_keys SET enabled = 0, revoked_at = ? WHERE id = ?')
      .run(existing.revoked_at ?? now, id);
    const row = this.getRowById(id);
    return row === undefined ? undefined : toApiKeyView(row);
  }

  /**
   * 更新最近使用时间/IP，并把累计请求次数 +1（§10.1）。跟 last_used_at
   * 用同一条 UPDATE 语句一起写，不在鉴权热路径上为计数单独多一次落库。
   */
  touch(id: string, ip: string | null, now = Date.now()): void {
    this.#db
      .prepare(
        'UPDATE api_keys SET last_used_at = ?, last_used_ip = ?, request_count = request_count + 1 WHERE id = ?',
      )
      .run(now, ip, id);
  }
}

/** Key 是否处于可用状态；返回不可用原因便于给出清晰错误。 */
export function evaluateApiKeyUsability(
  row: ApiKeyRow,
  now = Date.now(),
): { usable: true } | { usable: false; reason: string } {
  if (row.revoked_at !== null) return { usable: false, reason: 'API Key 已被撤销' };
  if (row.enabled !== 1) return { usable: false, reason: 'API Key 已被停用' };
  if (row.starts_at !== null && now < row.starts_at) return { usable: false, reason: 'API Key 尚未生效' };
  if (row.expires_at !== null && now >= row.expires_at) return { usable: false, reason: 'API Key 已过期' };
  return { usable: true };
}
