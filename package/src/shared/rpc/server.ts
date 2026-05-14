import type { Stream as StreamType } from "./schema";

type Setup<T> = (emit: (chunk: T) => void, signal: AbortSignal) => void | (() => void);

class ServerStream<T> implements AsyncIterable<T>, Disposable {
  private readonly buffer: T[] = [];
  private readonly waiters: Array<{ resolve: (r: IteratorResult<T>) => void; reject: (e: unknown) => void }> = [];
  private readonly ctrl = new AbortController();
  private cleanup?: () => void;
  private ended = false;
  private failure: unknown = null;

  constructor(setup: Setup<T>) {
    const emit = (chunk: T) => {
      if (this.ended || this.failure) return;
      const w = this.waiters.shift();
      if (w) {
        w.resolve({ value: chunk, done: false });
        return;
      }
      this.buffer.push(chunk);
    };
    try {
      const ret = setup(emit, this.ctrl.signal);
      if (typeof ret === "function") this.cleanup = ret;
    } catch (err) {
      this.failure = err;
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: async (): Promise<IteratorResult<T>> => {
        if (this.buffer.length > 0) {
          return { value: this.buffer.shift()!, done: false };
        }
        if (this.failure) throw this.failure;
        if (this.ended) return { value: undefined as unknown as T, done: true };
        return new Promise<IteratorResult<T>>((resolve, reject) => this.waiters.push({ resolve, reject }));
      },
      return: async (): Promise<IteratorResult<T>> => {
        this.dispose();
        return { value: undefined as unknown as T, done: true };
      },
    };
  }

  cancel(): void {
    this.dispose();
  }

  [Symbol.dispose](): void {
    this.dispose();
  }

  private dispose(): void {
    if (this.ended) return;
    this.ended = true;
    this.ctrl.abort();
    try { this.cleanup?.(); } catch { /* swallow */ }
    while (this.waiters.length > 0) {
      const w = this.waiters.shift()!;
      w.resolve({ value: undefined as unknown as T, done: true });
    }
  }
}

export const Stream = {
  from<T>(setup: Setup<T>): StreamType<T> {
    return new ServerStream(setup) as unknown as StreamType<T>;
  },
};
