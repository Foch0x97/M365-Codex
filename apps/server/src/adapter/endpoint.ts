import type { UpstreamConfig } from '../config/index.js';

/**
 * 构造上游 WebSocket 连接地址。
 *
 * 上游端点会漂移，所以基址与路径模板都来自配置。这里做两件事：
 * 1. 用账号的 oid / tid 填充路径模板；
 * 2. 把 access_token 作为查询参数附加。
 *
 * access_token 不写进模板、也不出现在任何返回给外部的结构里；
 * 需要打印地址时一律用 `redactWsUrl` 脱敏。
 */

export interface BuildEndpointInput {
  config: UpstreamConfig;
  oid: string;
  tid: string;
  accessToken: string;
  /** 额外查询参数（例如会话特性开关），默认空 */
  extraParams?: Record<string, string>;
}

export function buildUpstreamUrl(input: BuildEndpointInput): string {
  const path = input.config.pathTemplate
    .replaceAll('{oid}', encodeURIComponent(input.oid))
    .replaceAll('{tid}', encodeURIComponent(input.tid));

  const base = input.config.wsBase.replace(/\/+$/, '');
  const url = new URL(base + (path.startsWith('/') ? path : `/${path}`));

  for (const [key, value] of Object.entries(input.extraParams ?? {})) {
    url.searchParams.set(key, value);
  }
  // access_token 放最后，减少它在被截断日志里完整出现的概率
  url.searchParams.set('access_token', input.accessToken);
  return url.toString();
}

/** 把 URL 中的 access_token 值替换为掩码，供日志使用。 */
export function redactWsUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    if (url.searchParams.has('access_token')) {
      url.searchParams.set('access_token', '[已脱敏]');
    }
    return url.toString();
  } catch {
    // 不是合法 URL 时兜底用正则抹掉
    return rawUrl.replace(/(access_token=)[^&]*/gi, '$1[已脱敏]');
  }
}
