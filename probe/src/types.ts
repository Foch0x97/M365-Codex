import type { Logger } from 'pino';
import type {
  ProtocolCodec,
  RawMessage,
  ToolDeclaration,
  ToolResultInput,
  UpstreamEvent,
} from '../../apps/server/dist/adapter/protocol.js';
import type { AccountRepository } from '../../apps/server/dist/repo/accounts.js';
import type { OAuthClient } from '../../apps/server/dist/oauth/client.js';
import type { TokenManager } from '../../apps/server/dist/oauth/tokenManager.js';

/**
 * 探针的公共类型（对应实施计划 §3.4、§3.3）。
 *
 * 探针工作在「适配器层」而不是完整 Responses 网关层：直接对着上游 WebSocket
 * 跑 §3.1 的 29 项用例，产出脱敏证据。业务层（Responses/工具循环/调度）已在
 * M3-M8 用建模值实现，探针的产出是拿去校准那些建模值，而不是重新实现一遍网关。
 */

/** 能力状态枚举（§3.4）。 */
export const CAPABILITY_STATUSES = [
  'native',
  'adaptable',
  'partial',
  'unsupported',
  'unstable',
  'unknown',
] as const;
export type CapabilityStatus = (typeof CAPABILITY_STATUSES)[number];

/** 单项能力探测的产出（§3.3 要求的字段全部覆盖）。 */
export interface CapabilityResult {
  /** 稳定 id，如 `basic_text_chat`，报告与代码里一致，便于回溯 */
  id: string;
  /** §3.1 的序号（1-29） */
  index: number;
  /** 中文名称 */
  name: string;
  status: CapabilityStatus;
  /** 脱敏后的证据摘要（中文，供人读） */
  summary: string;
  /** 请求发起时间（epoch ms） */
  requestedAt: number;
  /** 耗时（毫秒) */
  durationMs: number;
  /** 上游错误分类（无错误为 null），对应 `UpstreamDisposition` 或本探针自定义分类 */
  errorCategory: string | null;
  /** 结构化的脱敏证据；只经 `evidence.ts` 输出，绝不含 Token/真实对话原文 */
  evidence: Record<string, unknown>;
}

/** 单次 invocation 的原始采集结果，供各 case 与 evidence 采样使用。 */
export interface InvocationOutcome {
  /** 归一化事件（供能力判定使用） */
  events: UpstreamEvent[];
  /** 原始帧（供结构采样/校准差异使用，务必只经脱敏输出） */
  rawMessages: RawMessage[];
  /** WebSocket 关闭码（正常关闭为 1000，未关闭为 null） */
  closeCode: number | null;
  closeReason: string | null;
  /** 分类失败原因；成功为 null */
  errorCategory: string | null;
  errorMessage: string | null;
  /** 429 场景下解析出的冷却毫秒数（§3.1 第 25 项），无相关信息为 null */
  retryAfterMs: number | null;
  durationMs: number;
  /** 服务端下发的会话标识（若上游返回），用于「连续会话」「会话恢复」用例 */
  conversationRef: string | null;
}

/** 上游连接相关配置（对应 `apps/server/src/config/index.ts` 的 `UpstreamConfig`）。 */
export interface ProbeUpstreamConfig {
  readonly wsBase: string;
  /** 握手必须带的 X-Scenario 头，见服务端 UpstreamConfig.scenario */
  readonly scenario: string;
  readonly pathTemplate: string;
  readonly protocolVersion: string;
  readonly heartbeatIntervalMs: number;
  readonly handshakeTimeoutMs: number;
  readonly idleTimeoutMs: number;
}

/** 单个 case 运行所需的上下文。每个 case 自行开连接，互不共享可变状态。 */
export interface ProbeContext {
  account: { id: string; oid: string; tid: string; email: string | null };
  /** 取一个当前可用的 access token；调用方用完即弃，绝不缓存到 ctx 以外 */
  getAccessToken: () => Promise<string>;
  upstream: ProbeUpstreamConfig;
  codec: ProtocolCodec;
  logger: Logger;
  /** 每个 case 之间的间隔（§6 安全与礼貌） */
  delayMs: number;
  /** 统计类用例的采样次数（§3.5 门槛的四项指标) */
  repeat: number;
  /** 单次 invocation 的整体超时（毫秒） */
  invocationTimeoutMs: number;
  /** 账号仓库：仅用于 Token 刷新类用例读取“是否变化”，绝不读出内容后落盘 */
  accounts: AccountRepository;
  oauthClient: OAuthClient;
  tokenManager: TokenManager;
}

export interface CaseDefinition {
  id: string;
  index: number;
  name: string;
  run: (ctx: ProbeContext) => Promise<CapabilityResult>;
}

export type { ToolDeclaration, ToolResultInput, UpstreamEvent, RawMessage };
