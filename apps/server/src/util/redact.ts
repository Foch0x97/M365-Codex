/** 脱敏工具：写日志/审计时对敏感字段打码。 */

/** 邮箱脱敏：保留前 2 位与域名，其余打码，例如 `fo***@example.com`。 */
export function maskEmail(email: string | null | undefined): string {
  if (email == null || email === '') return '(无邮箱)';
  const at = email.indexOf('@');
  if (at <= 0) return '***';
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const head = local.slice(0, Math.min(2, local.length));
  return `${head}***@${domain}`;
}
