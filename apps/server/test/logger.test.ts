import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createLogger, describeText, maskIp } from '../src/observability/logger.js';

function captureLogs(): { stream: Writable; lines: () => unknown[] } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(String(chunk));
      callback();
    },
  });
  return {
    stream,
    lines: () =>
      chunks
        .join('')
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map((line) => JSON.parse(line) as unknown),
  };
}

describe('createLogger 脱敏', () => {
  it('凭据类字段一律脱敏', () => {
    const capture = captureLogs();
    const logger = createLogger({
      level: 'info',
      privacyMode: 'strict',
      destination: capture.stream,
    });

    logger.info(
      {
        access_token: 'eyJhbGciOi.super.secret',
        refresh_token: '0.AXoA-refresh',
        password: 'admin-password',
        api_key: 'sk-abcdefg',
        headers: { authorization: 'Bearer sk-abcdefg', cookie: 'session=1' },
      },
      '包含敏感字段的日志',
    );

    const output = JSON.stringify(capture.lines());
    expect(output).not.toContain('eyJhbGciOi.super.secret');
    expect(output).not.toContain('0.AXoA-refresh');
    expect(output).not.toContain('admin-password');
    expect(output).not.toContain('sk-abcdefg');
    expect(output).toContain('[已脱敏]');
  });

  it('日志中带上隐私模式标记', () => {
    const capture = captureLogs();
    const logger = createLogger({ level: 'info', privacyMode: 'metadata', destination: capture.stream });
    logger.info('hello');
    expect(JSON.stringify(capture.lines())).toContain('"privacy_mode":"metadata"');
  });
});

describe('maskIp', () => {
  it('strict 模式只保留 IPv4 网段', () => {
    expect(maskIp('203.0.113.45', 'strict')).toBe('203.0.113.0/24');
  });

  it('strict 模式收敛 IPv6 到 /48', () => {
    expect(maskIp('2001:db8:1234:5678::1', 'strict')).toBe('2001:db8:1234::/48');
  });

  it('非 strict 模式保留完整地址', () => {
    expect(maskIp('203.0.113.45', 'debug')).toBe('203.0.113.45');
    expect(maskIp('203.0.113.45', 'metadata')).toBe('203.0.113.45');
  });

  it('空值返回 null', () => {
    expect(maskIp(undefined, 'strict')).toBeNull();
    expect(maskIp('', 'strict')).toBeNull();
  });
});

describe('describeText', () => {
  it('strict 模式只暴露长度', () => {
    const result = describeText('这是一段用户提示词', 'strict');
    expect(result).toEqual({ present: true, length: 9 });
  });

  it('debug 模式允许截断样本', () => {
    const result = describeText('hello world', 'debug') as Record<string, unknown>;
    expect(result.sample).toBe('hello world');
  });

  it('未提供文本时标记 present=false', () => {
    expect(describeText(undefined, 'strict')).toEqual({ present: false });
  });
});
