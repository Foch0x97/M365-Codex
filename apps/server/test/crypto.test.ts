import { Buffer } from 'node:buffer';
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Cryptor, CryptoError, generateMasterKeyBase64, safeEqual } from '../src/crypto/index.js';

const key = randomBytes(32);

describe('Cryptor', () => {
  it('加解密往返一致', () => {
    const cryptor = new Cryptor(key);
    const sealed = cryptor.seal('super-secret-refresh-token');
    expect(cryptor.open(sealed)).toBe('super-secret-refresh-token');
  });

  it('密文中不含明文', () => {
    const cryptor = new Cryptor(key);
    const plaintext = 'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9';
    const sealed = cryptor.seal(plaintext);
    expect(sealed.ciphertext.toString('utf8')).not.toContain(plaintext);
    expect(sealed.ciphertext.toString('base64')).not.toContain(plaintext);
  });

  it('每次加密使用不同 nonce', () => {
    const cryptor = new Cryptor(key);
    const nonces = new Set<string>();
    for (let i = 0; i < 200; i += 1) {
      nonces.add(cryptor.seal('same-plaintext').nonce.toString('hex'));
    }
    expect(nonces.size).toBe(200);
  });

  it('相同明文产生不同密文', () => {
    const cryptor = new Cryptor(key);
    const a = cryptor.seal('same-plaintext').ciphertext.toString('hex');
    const b = cryptor.seal('same-plaintext').ciphertext.toString('hex');
    expect(a).not.toBe(b);
  });

  it('密文被篡改时解密失败', () => {
    const cryptor = new Cryptor(key);
    const sealed = cryptor.seal('token');
    const tampered = Buffer.from(sealed.ciphertext);
    tampered[0] = (tampered[0] ?? 0) ^ 0xff;
    expect(() => cryptor.open({ ...sealed, ciphertext: tampered })).toThrow(CryptoError);
  });

  it('使用其他密钥无法解密', () => {
    const sealed = new Cryptor(key).seal('token');
    const other = new Cryptor(randomBytes(32));
    expect(() => other.open(sealed)).toThrow(CryptoError);
  });

  it('AAD 不匹配时解密失败', () => {
    const cryptor = new Cryptor(key);
    const sealed = cryptor.seal('token', 'account:aaa');
    expect(cryptor.open(sealed, 'account:aaa')).toBe('token');
    expect(() => cryptor.open(sealed, 'account:bbb')).toThrow(CryptoError);
  });

  it('拒绝长度错误的主密钥', () => {
    expect(() => new Cryptor(randomBytes(16))).toThrow(/32 字节/);
  });

  it('记录密钥版本并支持用历史密钥解密', () => {
    const oldKey = randomBytes(32);
    const oldCryptor = new Cryptor(oldKey, 1);
    const sealed = oldCryptor.seal('legacy-token');
    expect(sealed.keyVersion).toBe(1);

    const rotated = new Cryptor(key, 2, new Map([[1, oldKey]]));
    expect(rotated.keyVersion).toBe(2);
    expect(rotated.open(sealed)).toBe('legacy-token');
    expect(rotated.needsRotation(sealed)).toBe(true);
    expect(rotated.needsRotation(rotated.seal('new-token'))).toBe(false);
  });

  it('缺少对应版本密钥时给出明确错误', () => {
    const cryptor = new Cryptor(key, 2);
    const sealed = { ciphertext: randomBytes(32), nonce: randomBytes(12), keyVersion: 1 };
    expect(() => cryptor.open(sealed)).toThrow(/缺少密钥版本 v1/);
  });

  it('拒绝长度非法的 nonce 与过短的密文', () => {
    const cryptor = new Cryptor(key);
    expect(() => cryptor.open({ ciphertext: randomBytes(32), nonce: randomBytes(8), keyVersion: 1 })).toThrow(
      /nonce 长度非法/,
    );
    expect(() => cryptor.open({ ciphertext: randomBytes(8), nonce: randomBytes(12), keyVersion: 1 })).toThrow(
      /认证标签/,
    );
  });
});

describe('generateMasterKeyBase64', () => {
  it('生成解码后正好 32 字节的密钥', () => {
    expect(Buffer.from(generateMasterKeyBase64(), 'base64').byteLength).toBe(32);
  });
});

describe('safeEqual', () => {
  it('相同字符串返回 true', () => {
    expect(safeEqual('abcdef', 'abcdef')).toBe(true);
  });

  it('不同字符串或不同长度返回 false', () => {
    expect(safeEqual('abcdef', 'abcdeg')).toBe(false);
    expect(safeEqual('abc', 'abcdef')).toBe(false);
  });
});
