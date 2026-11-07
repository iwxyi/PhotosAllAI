export type PreviewPriority = 'visible' | 'background';

type Work<T> = {
  key?: string;
  run: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};

/** Bounds expensive preview creation without tying callers to a decoder. */
export class PreviewWorkQueue {
  readonly #limit: number;
  readonly #maxBackgroundPending: number;
  readonly #maxVisiblePending: number;
  readonly #visible: Work<unknown>[] = [];
  readonly #background: Work<unknown>[] = [];
  #visibleHead = 0;
  #active = 0;
  #closed = false;
  readonly #idleWaiters: (() => void)[] = [];

  constructor(limit = 2, maxBackgroundPending = Number.POSITIVE_INFINITY, maxVisiblePending = Number.POSITIVE_INFINITY) {
    if (!Number.isInteger(limit) || limit < 1) throw new RangeError('Preview concurrency must be positive');
    if (maxBackgroundPending < 1 || (!Number.isSafeInteger(maxBackgroundPending) && maxBackgroundPending !== Number.POSITIVE_INFINITY)) throw new RangeError('Background queue limit must be positive');
    if (maxVisiblePending < 1 || (!Number.isSafeInteger(maxVisiblePending) && maxVisiblePending !== Number.POSITIVE_INFINITY)) throw new RangeError('Visible queue limit must be positive');
    this.#limit = limit;
    this.#maxBackgroundPending = maxBackgroundPending;
    this.#maxVisiblePending = maxVisiblePending;
  }

  get stats(): { active: number; pending: number } {
    return { active: this.#active, pending: this.#visible.length - this.#visibleHead + this.#background.length };
  }

  enqueue<T>(run: () => Promise<T>, priority: PreviewPriority, key?: string): Promise<T> {
    if (this.#closed) return Promise.reject(new Error('PREVIEW_QUEUE_CLOSED'));
    return new Promise<T>((resolve, reject) => {
      const work = { key, run, resolve, reject } as Work<unknown>;
      if (priority === 'visible') {
        this.#visible.push(work);
        this.#trimVisible();
      }
      else {
        this.#background.push(work);
        if (this.#background.length > this.#maxBackgroundPending) {
          this.#background.shift()!.reject(new Error('PREVIEW_QUEUE_STALE'));
        }
      }
      this.#pump();
    });
  }

  promote(key: string): boolean {
    const index = this.#background.findIndex((work) => work.key === key);
    if (index < 0) return false;
    this.#visible.push(this.#background.splice(index, 1)[0]!);
    this.#trimVisible();
    this.#pump();
    return true;
  }

  cancel(key: string): boolean {
    const visibleIndex = this.#visible.findIndex((work, index) => index >= this.#visibleHead && work.key === key);
    if (visibleIndex >= 0) {
      this.#visible.splice(visibleIndex, 1)[0]!.reject(new Error('PREVIEW_QUEUE_STALE'));
      return true;
    }
    const backgroundIndex = this.#background.findIndex((work) => work.key === key);
    if (backgroundIndex < 0) return false;
    this.#background.splice(backgroundIndex, 1)[0]!.reject(new Error('PREVIEW_QUEUE_STALE'));
    return true;
  }

  #trimVisible(): void {
    while (this.#visible.length - this.#visibleHead > this.#maxVisiblePending) {
      this.#visible[this.#visibleHead++]!.reject(new Error('PREVIEW_QUEUE_STALE'));
    }
    if (this.#visibleHead === this.#visible.length) {
      this.#visible.length = 0;
      this.#visibleHead = 0;
    }
  }

  /** Reject waiting work, then wait for native decoders already running. */
  close(): Promise<void> {
    this.#closed = true;
    for (let index = this.#visibleHead; index < this.#visible.length; index += 1) {
      this.#visible[index]!.reject(new Error('PREVIEW_QUEUE_CLOSED'));
    }
    for (const work of this.#background) work.reject(new Error('PREVIEW_QUEUE_CLOSED'));
    this.#visible.length = 0;
    this.#visibleHead = 0;
    this.#background.length = 0;
    if (this.#active === 0) return Promise.resolve();
    return new Promise((resolve) => this.#idleWaiters.push(resolve));
  }

  #pump(): void {
    while (this.#active < this.#limit && this.stats.pending > 0) {
      const work = this.#visibleHead < this.#visible.length
        ? this.#visible[this.#visibleHead++]!
        : this.#background.pop()!;
      if (this.#visibleHead === this.#visible.length) {
        this.#visible.length = 0;
        this.#visibleHead = 0;
      } else if (this.#visibleHead > 1024 && this.#visibleHead * 2 > this.#visible.length) {
        this.#visible.splice(0, this.#visibleHead);
        this.#visibleHead = 0;
      }
      this.#active += 1;
      void Promise.resolve().then(work.run).then(work.resolve, work.reject).finally(() => {
        this.#active -= 1;
        this.#pump();
        if (this.#active === 0) {
          for (const resolve of this.#idleWaiters.splice(0)) resolve();
        }
      });
    }
  }
}
