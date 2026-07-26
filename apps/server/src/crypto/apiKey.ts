import { Buffer } from 'node:buffer';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  API_KEY_BODY_LENGTH,
  API_KEY_LOOKUP_PREFIX_LENGTH,
  API_KEY_PREFIX,
} from '@m365-codex/shared';

/**
 * 对外 API Key 的生成与校验（对应实施计划 §1.3）。
 *
 * - 形如 `sk-` + 52 位 Base62（CSPRNG，拒绝采样保证均匀分布）；
 * - 库中只存 SHA-256(salt || key) 与用于索引的前缀，不存明文；
 * - 明文只在创建接口的响应里出现一次。
 */

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
/** 256 % 62 = 8，落在 [248, 255] 的字节会造成偏置，直接丢弃重抽。 */
const REJECT_THRESHOLD = 248;
const SALT_BYTES = 16;

export interface GeneratedApiKey {
  /** 明文 Key，只返回给创建者一次 */
  key: string;
  /** 用于数据库索引的前缀（`sk-` + 8 位） */
  prefix: string;
  /** 十六进制随机盐 */
  salt: string;
  /** 十六进制 SHA-256(salt || key) */
  hash: string;
}

/** 生成均匀分布的 Base62 随机串。 */
function randomBase62(length: number): string {
  let out = '';
  while (out.length < length) {
    const need = length - out.length;
    const buf = randomBytes(need * 2);
    for (const byte of buf) {
      if (byte >= REJECT_THRESHOLD) continue;
      out += BASE62[byte % 62];
      if (out.length === length) break;
    }
  }
  return out;
}

export function hashApiKey(key: string, salt: string): string {
  return createHash('sha256').update(salt, 'utf8').update(key, 'utf8').digest('hex');
}

export function generateApiKey(): GeneratedApiKey {
  const key = API_KEY_PREFIX + randomBase62(API_KEY_BODY_LENGTH);
  const salt = randomBytes(SALT_BYTES).toString('hex');
  return {
    key,
    prefix: key.slice(0, API_KEY_LOOKUP_PREFIX_LENGTH),
    salt,
    hash: hashApiKey(key, salt),
  };
}

/** 形态校验：只判断格式，不查库。 */
export function isWellFormedApiKey(key: string): boolean {
  if (!key.startsWith(API_KEY_PREFIX)) return false;
  const body = key.slice(API_KEY_PREFIX.length);
  if (body.length < 48) return false;
  for (const ch of body) {
    if (!BASE62.includes(ch)) return false;
  }
  return true;
}

/** 从明文 Key 推导数据库索引前缀。 */
export function apiKeyLookupPrefix(key: string): string {
  return key.slice(0, API_KEY_LOOKUP_PREFIX_LENGTH);
}

/** 恒定时间校验明文 Key 与库中哈希是否匹配。 */
export function verifyApiKey(key: string, salt: string, expectedHash: string): boolean {
  const actual = Buffer.from(hashApiKey(key, salt), 'hex');
  let expected: Buffer;
  try {
    expected = Buffer.from(expectedHash, 'hex');
  } catch {
    return false;
  }
  if (expected.byteLength !== actual.byteLength) return false;
  return timingSafeEqual(actual, expected);
}

/** 生成用于界面展示的掩码，例如 `sk-Ab12Cd34……`。 */
export function maskApiKey(prefix: string): string {
  return `${prefix}${'•'.repeat(8)}`;
}
