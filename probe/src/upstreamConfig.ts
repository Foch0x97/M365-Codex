import {
  DEFAULT_UPSTREAM_PATH_TEMPLATE,
  DEFAULT_UPSTREAM_PROTOCOL_VERSION,
  DEFAULT_UPSTREAM_WS_BASE,
} from '../../apps/server/dist/config/index.js';
import { buildUpstreamUrl, redactWsUrl } from '../../apps/server/dist/adapter/endpoint.js';
import { selectCodec } from '../../apps/server/dist/adapter/codecV1.js';
import type { ProbeUpstreamConfig } from './types.js';

/**
 * 探针自己的上游配置，字段与 `apps/server/src/config/index.ts` 的 `UpstreamConfig`
 * 一一对应。默认值直接取网关的默认值，`UPSTREAM_*` 环境变量与网关同名同义，
 * 方便把探针指向模拟上游（自测）或未来漂移后的真实上游端点，不需要另记一套变量名。
 */
export function loadProbeUpstreamConfig(env: NodeJS.ProcessEnv = process.env): ProbeUpstreamConfig {
  return {
    wsBase: env.UPSTREAM_WS_BASE ?? DEFAULT_UPSTREAM_WS_BASE,
    pathTemplate: env.UPSTREAM_PATH_TEMPLATE ?? DEFAULT_UPSTREAM_PATH_TEMPLATE,
    protocolVersion: env.UPSTREAM_PROTOCOL_VERSION ?? DEFAULT_UPSTREAM_PROTOCOL_VERSION,
    heartbeatIntervalMs: numberEnv(env.UPSTREAM_HEARTBEAT_INTERVAL_MS, 15_000),
    handshakeTimeoutMs: numberEnv(env.UPSTREAM_HANDSHAKE_TIMEOUT_MS, 15_000),
    idleTimeoutMs: numberEnv(env.UPSTREAM_IDLE_TIMEOUT_MS, 60_000),
  };
}

function numberEnv(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function buildProbeUrl(
  config: ProbeUpstreamConfig,
  account: { oid: string; tid: string },
  accessToken: string,
  extraParams?: Record<string, string>,
): string {
  return buildUpstreamUrl({
    config: {
      wsBase: config.wsBase,
      pathTemplate: config.pathTemplate,
      protocolVersion: config.protocolVersion,
      heartbeatIntervalMs: config.heartbeatIntervalMs,
      handshakeTimeoutMs: config.handshakeTimeoutMs,
      idleTimeoutMs: config.idleTimeoutMs,
      maxReconnects: 0,
    },
    oid: account.oid,
    tid: account.tid,
    accessToken,
    extraParams,
  });
}

export { redactWsUrl, selectCodec };
