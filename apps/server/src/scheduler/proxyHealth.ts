import { connect } from 'node:net';

/**
 * 出口代理健康检查（对应实施计划 §13.1、契约 §2.4 `POST /admin/proxies/:id/check`）。
 *
 * 只验证代理端点自身的 TCP 连通性，不验证经它转发到公网目标的完整链路——
 * 后者需要一个总能连通的公网目标做探测靶子，在离线/内网/CI 环境里并不现实，
 * 也不该让「健康检查」依赖一个外部服务的可用性。这是有意的取舍，写在这里
 * 避免以后有人误以为它验证了完整的代理转发能力。
 */

export interface ProxyCheckResult {
  ok: boolean;
  latencyMs: number | null;
  detail: string;
}

export type ProxyChecker = (url: string, timeoutMs: number) => Promise<ProxyCheckResult>;

export const defaultProxyChecker: ProxyChecker = async (rawUrl, timeoutMs) => {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { ok: false, latencyMs: null, detail: '代理地址不是合法 URL，无法解析主机与端口' };
  }
  const host = parsed.hostname;
  if (host === '') {
    return { ok: false, latencyMs: null, detail: '代理地址缺少主机名' };
  }
  const port = Number(parsed.port) || (parsed.protocol === 'https:' ? 443 : 80);
  const started = Date.now();

  return new Promise<ProxyCheckResult>((resolve) => {
    let settled = false;
    const socket = connect({ host, port, timeout: timeoutMs });

    const finish = (result: ProxyCheckResult): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };

    socket.once('connect', () => finish({ ok: true, latencyMs: Date.now() - started, detail: 'TCP 连接成功' }));
    socket.once('timeout', () => finish({ ok: false, latencyMs: null, detail: `连接超时（${timeoutMs}ms）` }));
    socket.once('error', (error) => finish({ ok: false, latencyMs: null, detail: `连接失败：${error.message}` }));
  });
};
