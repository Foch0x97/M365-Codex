/**
 * 单生产者 / 单消费者的异步队列。
 *
 * 用来把事件驱动的 WebSocket（'message' 回调）桥接成拉取式的 async 迭代：
 * 生产者 push 事件，消费者 await next()。支持正常结束与异常结束。
 */
export class AsyncQueue<T> {
  readonly #items: T[] = [];
  #waiting: { resolve: (result: IteratorResult<T>) => void; reject: (error: unknown) => void } | null =
    null;
  #ended = false;
  #error: unknown = null;

  push(item: T): void {
    if (this.#ended) return;
    if (this.#waiting !== null) {
      const waiter = this.#waiting;
      this.#waiting = null;
      waiter.resolve({ value: item, done: false });
      return;
    }
    this.#items.push(item);
  }

  /** 正常结束：消费者取完剩余项后收到 done。 */
  end(): void {
    if (this.#ended) return;
    this.#ended = true;
    if (this.#waiting !== null && this.#items.length === 0) {
      const waiter = this.#waiting;
      this.#waiting = null;
      waiter.resolve({ value: undefined, done: true });
    }
  }

  /** 异常结束：消费者取完剩余项后收到 reject。 */
  fail(error: unknown): void {
    if (this.#ended) return;
    this.#ended = true;
    this.#error = error;
    if (this.#waiting !== null && this.#items.length === 0) {
      const waiter = this.#waiting;
      this.#waiting = null;
      waiter.reject(error);
    }
  }

  next(): Promise<IteratorResult<T>> {
    if (this.#items.length > 0) {
      const value = this.#items.shift() as T;
      return Promise.resolve({ value, done: false });
    }
    if (this.#ended) {
      // this.#error 是任意上游错误（可能不是 Error 实例），用 async 包装如实透传
      if (this.#error !== null) return this.#rejected();
      return Promise.resolve({ value: undefined, done: true });
    }
    return new Promise((resolve, reject) => {
      this.#waiting = { resolve, reject };
    });
  }

  // 用 async 函数抛出而不是 Promise.reject，以透传非 Error 类型的上游失败原因
  async #rejected(): Promise<IteratorResult<T>> {
    throw this.#error;
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<T> {
    for (;;) {
      const result = await this.next();
      if (result.done === true) return;
      yield result.value;
    }
  }
}
