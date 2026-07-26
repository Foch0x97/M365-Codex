import { maskEmail } from '../../apps/server/dist/util/redact.js';
import { redactWsUrl } from '../../apps/server/dist/adapter/endpoint.js';

/**
 * 强制脱敏层（对应实施计划 §3.3 的硬红线）。
 *
 * 铁律：报告只能经本文件的函数输出；任何 case 都不得把原始 access/refresh
 * token、Cookie、完整认证 Header、用户真实文件内容或真实对话直接塞进
 * `CapabilityResult.evidence`。
 *
 * 这里刻意保守：默认把所有字符串值都当作敏感内容处理，只有调用方明确
 * 提供的「我们自己发出去的固定测试文本」字面量才原样保留，其余一律
 * 替换成 `<string:长度>`（保留字段名与类型，不保留内容）。
 */

export { maskEmail, redactWsUrl };

/** 租户 / 对象 ID 只保留前 8 位（§3.3）。 */
export function maskId(id: string | null | undefined): string | null {
  if (id === null || id === undefined || id === '') return null;
  return id.length <= 8 ? id : `${id.slice(0, 8)}…`;
}

/** 明确禁止出现在证据里的键名（大小写不敏感），命中时整体丢弃该字段。 */
const FORBIDDEN_KEYS = new Set(
  [
    'access_token',
    'accesstoken',
    'refresh_token',
    'refreshtoken',
    'id_token',
    'idtoken',
    'code',
    'code_verifier',
    'codeverifier',
    'pkce',
    'cookie',
    'set-cookie',
    'authorization',
    'auth',
    'password',
    'secret',
    'client_secret',
    'clientsecret',
    'master_key',
    'masterkey',
  ].map((key) => key.toLowerCase()),
);

const MAX_ARRAY_ITEMS = 20;
const MAX_DEPTH = 8;

/**
 * 把任意值（通常是上游原始帧）转成「只留结构不留内容」的样本：
 * - 对象：保留键名，命中 `FORBIDDEN_KEYS` 的键整体替换为占位符；
 * - 字符串：命中 allowlist 原样保留，否则替换为 `<string:长度>`；
 * - 数字 / 布尔 / null：原样保留（它们是结构化元数据，不是「内容」）；
 * - 数组：逐项转换，超过上限截断并记录被截断的数量。
 */
export function buildStructureSample(
  value: unknown,
  allowlist: ReadonlySet<string> = new Set(),
  depth = 0,
): unknown {
  if (depth > MAX_DEPTH) return '<truncated:max-depth>';

  if (value === null || value === undefined) return value ?? null;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') return sampleString(value, allowlist);

  if (Array.isArray(value)) {
    const items = value
      .slice(0, MAX_ARRAY_ITEMS)
      .map((item) => buildStructureSample(item, allowlist, depth + 1));
    if (value.length > MAX_ARRAY_ITEMS) {
      items.push(`<truncated:${value.length - MAX_ARRAY_ITEMS}-more-items>`);
    }
    return items;
  }

  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      if (FORBIDDEN_KEYS.has(key.toLowerCase())) {
        out[key] = '<redacted:forbidden-key>';
        continue;
      }
      out[key] = buildStructureSample(val, allowlist, depth + 1);
    }
    return out;
  }

  // function / symbol / bigint 等不应出现在上游 JSON 帧里，兜底丢弃
  return `<redacted:unsupported-type:${typeof value}>`;
}

function sampleString(text: string, allowlist: ReadonlySet<string>): string {
  if (allowlist.has(text)) return text;
  if (looksLikeSecret(text)) return '<redacted:looks-like-secret>';
  return `<string:${text.length}>`;
}

/** JWT 形态、access_token query、Bearer 头等的启发式识别，兜底防线。 */
const JWT_PATTERN = /^eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}$/;
const ACCESS_TOKEN_QUERY_PATTERN = /[?&]access_token=[^&\s"']+/i;
const BEARER_PATTERN = /^Bearer\s+\S+$/i;

function looksLikeSecret(text: string): boolean {
  return (
    JWT_PATTERN.test(text) || ACCESS_TOKEN_QUERY_PATTERN.test(text) || BEARER_PATTERN.test(text)
  );
}

/**
 * 最终防线：在报告写盘前对整段渲染文本做一次扫描。
 * 命中任何一种敏感形态都视为「本不该到这一步」的实现 bug，直接抛错而不是
 * 静默再脱敏一次——不能带着「曾经差点泄露」的侥幸心理发布报告。
 */
export function assertReportClean(renderedText: string): void {
  const findings: string[] = [];
  if (JWT_PATTERN_GLOBAL.test(renderedText)) findings.push('疑似 JWT');
  if (/[?&]access_token=[^&\s"']+/i.test(renderedText)) findings.push('URL 中的 access_token 查询参数');
  if (/Bearer\s+[A-Za-z0-9._-]{10,}/i.test(renderedText)) findings.push('Bearer 认证头');
  if (/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(renderedText) && !onlyMaskedEmails(renderedText)) {
    findings.push('疑似未脱敏的邮箱地址');
  }
  if (findings.length > 0) {
    throw new Error(`报告脱敏检查失败，检测到：${findings.join('、')}`);
  }
}

const JWT_PATTERN_GLOBAL = /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/;

/** 邮箱正则会命中我们自己的掩码形态（如 `fo***@example.com`），排除这种形态后如果还有命中才算真的泄露。 */
function onlyMaskedEmails(text: string): boolean {
  const emails = text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) ?? [];
  return emails.every((email) => /^[A-Za-z0-9._%+-]{0,2}\*{3}@/.test(email));
}
