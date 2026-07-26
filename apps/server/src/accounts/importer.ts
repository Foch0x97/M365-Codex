import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import type { AccountRepository } from '../repo/accounts.js';
import { decodeJwtClaims } from '../oauth/client.js';

/**
 * 导入 M365 Native 本地授权助手写出的 `accounts.json`。
 *
 * 该文件由用户的 PKCE 助手（或其容器版本）维护，格式见下方 schema。
 * 本模块的纪律：
 * - **只读源文件**，绝不写回、绝不修改；
 * - 按 `tid + oid` 去重，重复账号走更新而非新增；
 * - 返回值与日志里**只有计数与脱敏邮箱**，不含任何 Token；
 * - 单条账号损坏不影响其余账号导入。
 */

const externalAccountSchema = z.object({
  id: z.string().optional(),
  email: z.string().optional(),
  displayName: z.string().optional(),
  status: z.string().optional(),
  accessToken: z.string().optional(),
  refreshToken: z.string().optional(),
  idToken: z.string().optional(),
  expiresAt: z.string().optional(),
  updatedAt: z.string().optional(),
  tid: z.string().optional(),
  oid: z.string().optional(),
});

const externalFileSchema = z.object({
  source: z.string().optional(),
  clientId: z.string().optional(),
  updatedAt: z.string().optional(),
  accounts: z.array(externalAccountSchema).default([]),
});

export type ExternalAccount = z.infer<typeof externalAccountSchema>;

export interface ImportSkip {
  /** 脱敏后的邮箱，形如 `fo***@example.com` */
  email: string;
  reason: string;
}

export interface ImportSummary {
  /** 源文件中的账号条目总数 */
  total: number;
  created: number;
  updated: number;
  /** 因缺字段、Token 缺失、重复等原因跳过的条目 */
  skipped: ImportSkip[];
  /** 源文件自身的 updatedAt（若有） */
  source_updated_at: string | null;
}

/** 邮箱脱敏：保留前 2 位与域名，其余打码。 */
export function maskEmail(email: string | null | undefined): string {
  if (email == null || email === '') return '(无邮箱)';
  const at = email.indexOf('@');
  if (at <= 0) return '***';
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const head = local.slice(0, Math.min(2, local.length));
  return `${head}***@${domain}`;
}

/**
 * 去掉开头的 UTF-8 BOM（U+FEFF）。
 * Windows 上不少工具写 JSON 会带 BOM，而 JSON.parse 不接受它。
 */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** ISO 时间串转毫秒 epoch；无法解析时返回 null。 */
export function parseIsoTimestamp(value: string | undefined): number | null {
  if (value === undefined || value === '') return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * 补齐 tid / oid：源文件里理应有这两个字段，
 * 缺失时退而从 access_token 的声明里解析，尽量不丢账号。
 */
function resolveIdentity(account: ExternalAccount): { tid: string; oid: string } | null {
  let tid = account.tid ?? '';
  let oid = account.oid ?? '';

  if (tid === '' || oid === '') {
    const claims = {
      ...(account.accessToken === undefined ? {} : decodeJwtClaims(account.accessToken)),
      ...(account.idToken === undefined ? {} : decodeJwtClaims(account.idToken)),
    };
    if (tid === '' && typeof claims.tid === 'string') tid = claims.tid;
    if (oid === '') {
      if (typeof claims.oid === 'string') oid = claims.oid;
      else if (typeof claims.sub === 'string') oid = claims.sub;
    }
  }

  if (tid === '' || oid === '') return null;
  return { tid, oid };
}

export interface ImportOptions {
  /** 来源标记，写进 accounts.source，便于区分人工授权与外部同步 */
  sourceLabel?: string;
  /**
   * 是否跳过 access token 已过期的条目。
   * 同步场景下设 false：过期条目仍可能带着有效的 refresh_token。
   */
  skipExpired?: boolean;
}

/** 从已解析的 JSON 对象导入。文件读取与解析分离，便于测试。 */
export function importAccountsFromObject(
  raw: unknown,
  accounts: AccountRepository,
  options: ImportOptions = {},
  now = Date.now(),
): ImportSummary {
  const parsed = externalFileSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`账号文件格式不正确：${parsed.error.issues[0]?.message ?? '未知原因'}`);
  }

  const sourceLabel = options.sourceLabel ?? 'import:m365-native';
  const summary: ImportSummary = {
    total: parsed.data.accounts.length,
    created: 0,
    updated: 0,
    skipped: [],
    source_updated_at: parsed.data.updatedAt ?? null,
  };

  // 同一份文件里若出现重复 (tid, oid)，只取最后一条——它通常是最新的
  const seen = new Map<string, ExternalAccount>();
  const order: string[] = [];
  for (const account of parsed.data.accounts) {
    const identity = resolveIdentity(account);
    if (identity === null) {
      summary.skipped.push({ email: maskEmail(account.email), reason: '缺少 tid 或 oid，无法识别账号' });
      continue;
    }
    if (account.accessToken === undefined || account.accessToken === '') {
      summary.skipped.push({ email: maskEmail(account.email), reason: '缺少 accessToken' });
      continue;
    }
    const key = `${identity.tid}:${identity.oid}`;
    if (!seen.has(key)) order.push(key);
    seen.set(key, account);
  }

  for (const key of order) {
    const account = seen.get(key);
    if (account === undefined) continue;
    const identity = resolveIdentity(account);
    if (identity === null) continue;

    const expiresAt = parseIsoTimestamp(account.expiresAt);
    if (options.skipExpired === true && expiresAt !== null && expiresAt <= now) {
      summary.skipped.push({ email: maskEmail(account.email), reason: 'accessToken 已过期' });
      continue;
    }

    const existed = accounts.findByTenantObject(identity.tid, identity.oid) !== undefined;
    accounts.upsert(
      {
        tid: identity.tid,
        oid: identity.oid,
        email: account.email ?? null,
        displayName: account.displayName ?? null,
        source: sourceLabel,
        tokens: {
          // 上面已保证 accessToken 存在
          accessToken: account.accessToken as string,
          refreshToken: account.refreshToken ?? null,
          expiresAt,
        },
      },
      now,
    );
    if (existed) summary.updated += 1;
    else summary.created += 1;
  }

  return summary;
}

/** 从文件路径导入。文件不存在或不可读时抛出可读错误。 */
export async function importAccountsFromFile(
  filePath: string,
  accounts: AccountRepository,
  options: ImportOptions = {},
  now = Date.now(),
): Promise<ImportSummary> {
  let text: string;
  try {
    text = await readFile(filePath, 'utf8');
  } catch (error) {
    throw new Error(`无法读取账号文件 ${filePath}：${(error as Error).message}`, { cause: error });
  }

  let raw: unknown;
  try {
    raw = JSON.parse(stripBom(text));
  } catch (error) {
    throw new Error(`账号文件不是合法 JSON：${(error as Error).message}`, { cause: error });
  }

  return importAccountsFromObject(raw, accounts, options, now);
}
