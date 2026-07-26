import { pino, type Logger, type LoggerOptions } from 'pino';
import type { LogPrivacyMode } from '@m365-codex/shared';

/**
 * 日志与隐私模式（对应实施计划 §1.1、§3）。
 *
 * 三档隐私模式：
 * - `strict`（默认）：不记录请求体、提示词、上游内容；IP 只记录网段；
 * - `metadata`：额外记录模型名、长度、耗时等元数据，仍不记录正文；
 * - `debug`：记录更多结构化细节，仅供本地排障；凭据字段任何模式下都脱敏。
 */

const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'req.headers["proxy-authorization"]',
  'res.headers["set-cookie"]',
  'headers.authorization',
  'headers.cookie',
  'headers["x-api-key"]',
  'authorization',
  'password',
  'api_key',
  'apiKey',
  'access_token',
  'accessToken',
  'refresh_token',
  'refreshToken',
  'id_token',
  'client_secret',
  'code_verifier',
  'master_key',
  'masterKey',
  'token',
  '*.access_token',
  '*.refresh_token',
  '*.password',
  '*.token',
];

const REDACT_CENSOR = '[已脱敏]';

export interface CreateLoggerOptions {
  level: string;
  privacyMode: LogPrivacyMode;
  /** 开发环境启用彩色输出，容器内保持 JSON */
  pretty?: boolean;
  /** 测试中重定向输出 */
  destination?: NodeJS.WritableStream;
}

export function createLogger(options: CreateLoggerOptions): Logger {
  const base: LoggerOptions = {
    level: options.level,
    base: { privacy_mode: options.privacyMode },
    redact: { paths: REDACT_PATHS, censor: REDACT_CENSOR },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level: (label) => ({ level: label }),
    },
  };

  if (options.destination !== undefined) {
    return pino(base, options.destination);
  }

  if (options.pretty === true) {
    return pino({
      ...base,
      transport: {
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'SYS:HH:MM:ss.l', ignore: 'pid,hostname' },
      },
    });
  }

  return pino(base);
}

/**
 * 按隐私模式处理客户端 IP：
 * strict 只保留网段（IPv4 /24、IPv6 /48），其余模式保留完整地址。
 */
export function maskIp(ip: string | undefined, mode: LogPrivacyMode): string | null {
  if (ip === undefined || ip === '') return null;
  if (mode !== 'strict') return ip;

  if (ip.includes(':')) {
    const groups = ip.split(':').filter((part) => part !== '');
    return `${groups.slice(0, 3).join(':')}::/48`;
  }
  const octets = ip.split('.');
  if (octets.length !== 4) return null;
  return `${octets[0]}.${octets[1]}.${octets[2]}.0/24`;
}

/** strict 模式下只允许记录长度等派生信息，禁止原文。 */
export function describeText(text: string | undefined, mode: LogPrivacyMode): Record<string, unknown> {
  if (text === undefined) return { present: false };
  if (mode === 'debug') return { present: true, length: text.length, sample: text.slice(0, 200) };
  return { present: true, length: text.length };
}
