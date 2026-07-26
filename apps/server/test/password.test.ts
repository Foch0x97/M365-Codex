import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from '../src/crypto/password.js';

describe('password', () => {
  it('哈希结果不含明文，且每次加盐不同', () => {
    const a = hashPassword('correct horse battery staple');
    const b = hashPassword('correct horse battery staple');
    expect(a).not.toContain('correct horse battery staple');
    expect(a).not.toBe(b);
    expect(a.startsWith('scrypt$')).toBe(true);
  });

  it('正确密码校验通过，错误密码失败', () => {
    const encoded = hashPassword('correct horse battery staple');
    expect(verifyPassword('correct horse battery staple', encoded)).toBe(true);
    expect(verifyPassword('wrong password', encoded)).toBe(false);
  });

  it('编码格式异常时返回 false 而不抛异常', () => {
    expect(verifyPassword('x', 'not-a-hash')).toBe(false);
    expect(verifyPassword('x', 'bcrypt$1$2$3$aa$bb')).toBe(false);
    expect(verifyPassword('x', 'scrypt$x$8$1$aa$bb')).toBe(false);
  });
});
