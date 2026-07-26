import { createHash, randomBytes } from 'node:crypto';

/**
 * PKCE（RFC 7636）参数生成。
 *
 * 只用 S256，不提供 plain 降级——plain 等于没有防护。
 */

/** Base64URL 编码，去掉填充符。 */
export function base64Url(data: Buffer): string {
  return data.toString('base64url');
}

/** code_verifier：48 字节随机数编码后 64 字符，落在 RFC 要求的 43-128 区间内。 */
export function generateCodeVerifier(): string {
  return base64Url(randomBytes(48));
}

/** code_challenge = BASE64URL(SHA256(code_verifier))。 */
export function deriveCodeChallenge(verifier: string): string {
  return base64Url(createHash('sha256').update(verifier, 'ascii').digest());
}

/** state：防 CSRF，同时作为授权会话的主键。 */
export function generateState(): string {
  return base64Url(randomBytes(24));
}

export interface PkcePair {
  verifier: string;
  challenge: string;
  state: string;
}

export function createPkcePair(): PkcePair {
  const verifier = generateCodeVerifier();
  return {
    verifier,
    challenge: deriveCodeChallenge(verifier),
    state: generateState(),
  };
}

/** RFC 7636 §4.1 对 code_verifier 的字符集与长度要求。 */
export function isValidCodeVerifier(verifier: string): boolean {
  return /^[A-Za-z0-9\-._~]{43,128}$/.test(verifier);
}
