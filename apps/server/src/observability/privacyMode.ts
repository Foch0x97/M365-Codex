import type { LogPrivacyMode } from '@m365-codex/shared';

/**
 * 当前生效的日志隐私模式的可变容器（对应实施计划 §15.3 debug 自动过期）。
 *
 * `AppConfig` 是启动时锁定、`Object.freeze` 过的快照；`settings/service.ts`
 * 里除 `logging.log_level` 外的项都要等重启才生效，`pending_restart` 列表
 * 就是为此存在的。但 `log_privacy_mode` 的 debug 自动过期必须是个例外——
 * debug 档会记录更多请求信息，如果“过期”只是把 `settings` 表里的值改回
 * strict、真正生效要等到下次不知道什么时候的重启，这段窗口里服务仍在
 * 按 debug 记录，安全机制等于形同虚设。
 *
 * 因此 `log_privacy_mode` 和 `log_level` 一样做成热生效：各处读取“当前隐私
 * 模式”时改用这个可变容器（`context.privacyMode.current`），而不是
 * `config.logPrivacyMode`（那是启动时的初始值，仍用于 `/admin/settings`
 * 展示 default 来源与 `pending_restart` 判定的基准）。
 */
export class PrivacyModeHolder {
  #current: LogPrivacyMode;

  constructor(initial: LogPrivacyMode) {
    this.#current = initial;
  }

  get current(): LogPrivacyMode {
    return this.#current;
  }

  set(mode: LogPrivacyMode): void {
    this.#current = mode;
  }
}
