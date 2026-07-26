/**
 * 优雅关闭时中止在途请求所用的 abort reason（对应实施计划 §19）。
 *
 * `responses/service.ts` 的 `#run` 靠这个哨兵值区分「用户/客户端主动取消」
 * （`/v1/responses/:id/cancel`、`DELETE`、客户端断开——这些要落库成
 * `cancelled`）与「进程正在优雅关闭」——后者由 `server.ts` 统一按
 * `maintenance/recovery.ts` 同一套「in_progress → incomplete」处置落库，
 * `#run` 自己不再重复写状态，避免两处并发写同一行互相竞争、产生两套语义。
 */
export const SHUTDOWN_ABORT_REASON = 'm365-codex:graceful-shutdown';

/**
 * 进行中 Response 的取消登记表。
 *
 * 把 responseId 映射到它的 AbortController，让 `POST /v1/responses/:id/cancel`
 * 与 `DELETE /v1/responses/:id` 能中止另一路请求正在进行的上游对话。
 * 只存活于内存——进行中的请求本就绑定在本进程的连接上。
 */
export class InFlightRegistry {
  readonly #controllers = new Map<string, AbortController>();

  register(responseId: string, controller: AbortController): void {
    this.#controllers.set(responseId, controller);
  }

  unregister(responseId: string): void {
    this.#controllers.delete(responseId);
  }

  /** 中止指定 response；返回是否确有进行中的请求被中止。 */
  cancel(responseId: string): boolean {
    const controller = this.#controllers.get(responseId);
    if (controller === undefined) return false;
    controller.abort();
    return true;
  }

  /**
   * 优雅关闭专用：中止全部在途请求的上游连接（关闭 WebSocket / 取消 dispatch），
   * 并清空登记表。返回被中止的 responseId 列表，供调用方把对应记录落库为
   * incomplete（见 `server.ts` 的 `gracefulShutdown`）。
   */
  cancelAll(): string[] {
    const ids = [...this.#controllers.keys()];
    for (const controller of this.#controllers.values()) {
      controller.abort(SHUTDOWN_ABORT_REASON);
    }
    this.#controllers.clear();
    return ids;
  }

  get size(): number {
    return this.#controllers.size;
  }
}
