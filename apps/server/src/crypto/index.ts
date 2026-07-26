import { Buffer } from 'node:buffer';
import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';
import { MASTER_KEY_BYTES } from '@m365-codex/shared';

/**
 * AES-256-GCM 字段级加密（对应实施计划 §1.2）。
 *
 * 设计要点：
 * - 每个敏感字段独立随机 nonce，绝不复用；
 * - 密文中附带认证标签，任何篡改都会在解密时失败；
 * - 记录密钥版本号，为后续主密钥轮换保留空间；
 * - 支持 AAD 绑定（例如账号 ID），防止把 A 账号的密文搬到 B 账号行上。
 */

export const NONCE_BYTES = 12;
export const TAG_BYTES = 16;
export const KEY_BYTES = MASTER_KEY_BYTES;

export class CryptoError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'CryptoError';
  }
}

/** 加密后的字段：三者需一起持久化。 */
export interface SealedValue {
  /** 密文 + 16 字节认证标签 */
  ciphertext: Buffer;
  nonce: Buffer;
  keyVersion: number;
}

export class Cryptor {
  readonly #keys: Map<number, Buffer>;
  readonly #currentVersion: number;

  /**
   * @param currentKey 当前主密钥（32 字节）
   * @param currentVersion 当前密钥版本号
   * @param previousKeys 历史密钥，仅用于解密旧数据
   */
  constructor(
    currentKey: Buffer,
    currentVersion = 1,
    previousKeys: ReadonlyMap<number, Buffer> = new Map(),
  ) {
    if (currentKey.byteLength !== KEY_BYTES) {
      throw new CryptoError(`主密钥必须为 ${KEY_BYTES} 字节，实际 ${currentKey.byteLength} 字节`);
    }
    if (!Number.isInteger(currentVersion) || currentVersion < 1) {
      throw new CryptoError('密钥版本号必须是 ≥1 的整数');
    }
    this.#keys = new Map(previousKeys);
    for (const [version, key] of this.#keys) {
      if (key.byteLength !== KEY_BYTES) {
        throw new CryptoError(`历史密钥 v${version} 长度非法`);
      }
    }
    this.#keys.set(currentVersion, currentKey);
    this.#currentVersion = currentVersion;
  }

  get keyVersion(): number {
    return this.#currentVersion;
  }

  /** 用当前密钥加密。`aad` 用于把密文绑定到特定记录。 */
  seal(plaintext: string, aad?: string): SealedValue {
    const key = this.#requireKey(this.#currentVersion);
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    if (aad !== undefined) {
      cipher.setAAD(Buffer.from(aad, 'utf8'));
    }
    const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return { ciphertext: Buffer.concat([body, tag]), nonce, keyVersion: this.#currentVersion };
  }

  /** 解密。密文被篡改、nonce 不匹配或 AAD 不一致都会抛 CryptoError。 */
  open(sealed: SealedValue, aad?: string): string {
    if (sealed.nonce.byteLength !== NONCE_BYTES) {
      throw new CryptoError('nonce 长度非法');
    }
    if (sealed.ciphertext.byteLength < TAG_BYTES) {
      throw new CryptoError('密文长度不足，缺少认证标签');
    }
    const key = this.#requireKey(sealed.keyVersion);
    const body = sealed.ciphertext.subarray(0, sealed.ciphertext.byteLength - TAG_BYTES);
    const tag = sealed.ciphertext.subarray(sealed.ciphertext.byteLength - TAG_BYTES);
    const decipher = createDecipheriv('aes-256-gcm', key, sealed.nonce);
    decipher.setAuthTag(tag);
    if (aad !== undefined) {
      decipher.setAAD(Buffer.from(aad, 'utf8'));
    }
    try {
      return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
    } catch (error) {
      throw new CryptoError('解密失败：密文已被篡改，或密钥/AAD 不匹配', { cause: error });
    }
  }

  /** 该密文是否使用当前密钥版本加密（用于判断是否需要重加密轮换）。 */
  needsRotation(sealed: SealedValue): boolean {
    return sealed.keyVersion !== this.#currentVersion;
  }

  #requireKey(version: number): Buffer {
    const key = this.#keys.get(version);
    if (key === undefined) {
      throw new CryptoError(`缺少密钥版本 v${version}，无法解密该字段`);
    }
    return key;
  }
}

/** 生成一个新的随机主密钥（Base64），供运维初始化使用。 */
export function generateMasterKeyBase64(): string {
  return randomBytes(KEY_BYTES).toString('base64');
}

/** 定长安全比较，避免字符串比较造成的时序侧信道。 */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.byteLength !== bufB.byteLength) {
    // 长度不同也走一次比较，减少长度信息泄露带来的时序差异
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}
