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

  get size(): number {
    return this.#controllers.size;
  }
}
