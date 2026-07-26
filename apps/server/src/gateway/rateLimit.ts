import { ApiError } from '@m365-codex/shared';
import type { RateLimitConfig } from '../config/index.js';
import type { ApiKeyRow } from '../repo/apiKeys.js';

/**
 * API Key 级限额（对应实施计划 §10、契约 §2.3）。
 *
 * 铁律（§10 末句）：**API Key 级限制不得突破全局上限**。落地方式很直接——
 * 有效限额永远是 `min(Key 自身设置, 全局天花板)`；Key 没设（null＝不限）时
 * 直接用全局天花板兜底，而不是真的不限。
 *
 * 并发计数只在进程内维护（`#concurrent` 计数器），注释先说清楚这个前提：
 * 单容器部署下这就是全局真实并发；一旦跑多副本，各副本各算各的，
 * 会出现"总并发看似超限"的情况——多副本水平扩展不在当前架构范围内。
 */

export interface EffectiveLimits {
  rpmLimit: number;
  dailyLimit: number;
  maxConcurrency: number;
}

export type ConsumeResult =
  | { ok: true; release: () => void }
  | { ok: false; reason: 'rpm' | 'daily' | 'concurrency'; retryAfterSeconds: number };

interface KeyState {
  minuteWindowStart: number;
  minuteCount: number;
  dayWindowStart: number;
  dayCount: number;
  concurrent: number;
}

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * 60 * 1000;

export class RateLimiter {
  readonly #global: RateLimitConfig;
  readonly #states = new Map<string, KeyState>();

  constructor(global: RateLimitConfig) {
    this.#global = global;
  }

  /** 把 Key 自身设置与全局天花板结合，永远不超过全局上限。 */
  effectiveLimits(key: ApiKeyRow): EffectiveLimits {
    return {
      rpmLimit: clampToCeiling(key.rpm_limit, this.#global.globalRpmLimit),
      dailyLimit: clampToCeiling(key.daily_limit, this.#global.globalDailyLimit),
      maxConcurrency: clampToCeiling(key.max_concurrency, this.#global.globalMaxConcurrency),
    };
  }

  /**
   * 校验接口与模型范围（§10）。不匹配时返回清晰原因，调用方转成 403。
   * `allowed_endpoints` / `allowed_models` 为 `null` 表示不限制；一旦设置（哪怕是空数组）
   * 就变成白名单，不在名单内一律拒绝。
   */
  checkEndpointAndModel(
    parsed: { endpoints: string[] | null; models: string[] | null },
    endpoint: string,
    model: string | null,
  ): void {
    if (parsed.endpoints !== null && !parsed.endpoints.includes(endpoint)) {
      throw ApiError.forbidden(`该 API Key 未被授权访问接口 ${endpoint}`);
    }
    if (model !== null && parsed.models !== null && !parsed.models.includes(model)) {
      throw ApiError.forbidden(`该 API Key 未被授权使用模型 ${model}`);
    }
  }

  /** 尝试消费一次配额；超限返回带 `retryAfterSeconds` 的失败结果，调用方转成 429。 */
  consume(keyId: string, limits: EffectiveLimits, now = Date.now()): ConsumeResult {
    const state = this.#stateFor(keyId, now);

    if (state.concurrent >= limits.maxConcurrency) {
      return { ok: false, reason: 'concurrency', retryAfterSeconds: 1 };
    }
    if (state.minuteCount >= limits.rpmLimit) {
      return {
        ok: false,
        reason: 'rpm',
        retryAfterSeconds: Math.max(1, Math.ceil((state.minuteWindowStart + MINUTE_MS - now) / 1000)),
      };
    }
    if (state.dayCount >= limits.dailyLimit) {
      return {
        ok: false,
        reason: 'daily',
        retryAfterSeconds: Math.max(1, Math.ceil((state.dayWindowStart + DAY_MS - now) / 1000)),
      };
    }

    state.minuteCount += 1;
    state.dayCount += 1;
    state.concurrent += 1;
    let released = false;
    return {
      ok: true,
      release: () => {
        if (released) return; // 防止调用方重复 release 把计数减穿
        released = true;
        state.concurrent = Math.max(0, state.concurrent - 1);
      },
    };
  }

  /** 供测试与可观测性查看当前进程内状态。 */
  snapshot(keyId: string): Readonly<KeyState> | undefined {
    return this.#states.get(keyId);
  }

  #stateFor(keyId: string, now: number): KeyState {
    let state = this.#states.get(keyId);
    if (state === undefined) {
      state = { minuteWindowStart: now, minuteCount: 0, dayWindowStart: now, dayCount: 0, concurrent: 0 };
      this.#states.set(keyId, state);
      return state;
    }
    if (now - state.minuteWindowStart >= MINUTE_MS) {
      state.minuteWindowStart = now;
      state.minuteCount = 0;
    }
    if (now - state.dayWindowStart >= DAY_MS) {
      state.dayWindowStart = now;
      state.dayCount = 0;
    }
    return state;
  }
}

/**
 * 有效限额永远是 `min(Key 自身设置, 全局天花板)`；Key 没设（null）时直接用
 * 全局天花板兜底。除了 rpm/daily/concurrency，`max_tool_calls`/`max_file_bytes`
 * （§10.1）也复用这同一条裁剪规则，导出给 `gateway/auth.ts` 用。
 */
export function clampToCeiling(keyLimit: number | null, globalCeiling: number): number {
  if (keyLimit === null) return globalCeiling;
  return Math.min(keyLimit, globalCeiling);
}
