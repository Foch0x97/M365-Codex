import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, parseMasterKey, summarizeConfig } from '../src/config/index.js';

const validKey = randomBytes(32).toString('base64');
const baseEnv = {
  M365_CODEX_MASTER_KEY: validKey,
  M365_CODEX_ADMIN_PASSWORD: 'a-sufficiently-long-password',
};

describe('parseMasterKey', () => {
  it('接受 32 字节的 Base64 密钥', () => {
    expect(parseMasterKey(validKey).byteLength).toBe(32);
  });

  it('拒绝长度不足的密钥', () => {
    const short = randomBytes(16).toString('base64');
    expect(() => parseMasterKey(short)).toThrow(/16 字节/);
  });

  it('拒绝非 Base64 字符串', () => {
    expect(() => parseMasterKey('这不是 base64!!')).toThrow(/Base64/);
  });

  it('拒绝空字符串', () => {
    expect(() => parseMasterKey('   ')).toThrow(/为空/);
  });
});

describe('loadConfig', () => {
  it('缺少主密钥时拒绝启动', () => {
    expect(() => loadConfig({ M365_CODEX_ADMIN_PASSWORD: 'a-sufficiently-long-password' })).toThrow(
      ConfigError,
    );
  });

  it('主密钥长度错误时拒绝启动，且不回显密钥内容', () => {
    const badKey = randomBytes(8).toString('base64');
    try {
      loadConfig({ ...baseEnv, M365_CODEX_MASTER_KEY: badKey });
      throw new Error('本应抛出 ConfigError');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).message).not.toContain(badKey);
      expect((error as ConfigError).message).toContain('M365_CODEX_MASTER_KEY');
    }
  });

  it('管理密码过短时拒绝启动', () => {
    expect(() => loadConfig({ ...baseEnv, M365_CODEX_ADMIN_PASSWORD: 'short' })).toThrow(/至少 12 位/);
  });

  it('缺少管理密码时拒绝启动', () => {
    expect(() => loadConfig({ M365_CODEX_MASTER_KEY: validKey })).toThrow(ConfigError);
  });

  it('拒绝通过环境变量注入 Microsoft Token', () => {
    expect(() =>
      loadConfig({ ...baseEnv, MICROSOFT_ACCESS_TOKEN: 'eyJhbGciOi...' }),
    ).toThrow(/禁止通过环境变量注入 Microsoft 凭据/);
  });

  it('应用默认值', () => {
    const config = loadConfig(baseEnv);
    expect(config.port).toBe(8080);
    expect(config.dataDir).toBe('/data');
    expect(config.logPrivacyMode).toBe('strict');
    expect(config.trustProxy).toBe(false);
    expect(config.masterKeyVersion).toBe(1);
    expect(config.upstreamWsBase).toBeNull();
  });

  it('解析可选覆盖项', () => {
    const config = loadConfig({
      ...baseEnv,
      PORT: '9000',
      DATA_DIR: '/srv/data',
      TRUST_PROXY: 'true',
      LOG_PRIVACY_MODE: 'metadata',
      PUBLIC_API_BASE_URL: 'https://codex.example.com/v1',
      UPSTREAM_WS_BASE: 'wss://substrate.office.com',
      MASTER_KEY_VERSION: '3',
    });
    expect(config.port).toBe(9000);
    expect(config.dataDir).toBe('/srv/data');
    expect(config.trustProxy).toBe(true);
    expect(config.logPrivacyMode).toBe('metadata');
    expect(config.publicApiBaseUrl).toBe('https://codex.example.com/v1');
    expect(config.upstreamWsBase).toBe('wss://substrate.office.com');
    expect(config.masterKeyVersion).toBe(3);
  });

  it('拒绝非法端口', () => {
    expect(() => loadConfig({ ...baseEnv, PORT: '70000' })).toThrow(/1-65535/);
  });

  it('拒绝非 http(s) 的公开地址', () => {
    expect(() => loadConfig({ ...baseEnv, PUBLIC_API_BASE_URL: 'ftp://example.com' })).toThrow(
      /http\/https/,
    );
  });

  it('拒绝非 ws(s) 的上游地址', () => {
    expect(() => loadConfig({ ...baseEnv, UPSTREAM_WS_BASE: 'https://example.com' })).toThrow(/ws\/wss/);
  });
});

describe('summarizeConfig', () => {
  it('摘要中不含主密钥与管理密码', () => {
    const config = loadConfig(baseEnv);
    const summary = JSON.stringify(summarizeConfig(config));
    expect(summary).not.toContain(validKey);
    expect(summary).not.toContain('a-sufficiently-long-password');
    expect(summary).toContain('masterKeyConfigured');
  });
});
