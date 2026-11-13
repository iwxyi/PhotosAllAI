import { randomUUID } from 'node:crypto';

export type BackgroundFileTask = {
  id: string;
  label: string;
  status: 'running' | 'completed' | 'failed';
  processed: number;
  total: number | null;
  startedAt: number;
  updatedAt: number;
  error: string | null;
};

export class BackgroundFileTasks {
  readonly #items: BackgroundFileTask[] = [];

  start(label: string, total: number | null = null): string {
    const id = randomUUID();
    const now = Date.now();
    this.#items.unshift({ id, label, status: 'running', processed: 0, total, startedAt: now, updatedAt: now, error: null });
    this.#trim();
    return id;
  }

  update(id: string, processed: number, total: number | null = null): void {
    const task = this.#items.find((item) => item.id === id);
    if (!task || task.status !== 'running') return;
    task.processed = processed;
    task.total = total;
    task.updatedAt = Date.now();
  }

  finish(id: string, error?: unknown): void {
    const task = this.#items.find((item) => item.id === id);
    if (!task || task.status !== 'running') return;
    task.status = error === undefined ? 'completed' : 'failed';
    task.error = error === undefined ? null : error instanceof Error ? error.message : String(error);
    task.updatedAt = Date.now();
    this.#trim();
  }

  list(): BackgroundFileTask[] {
    return this.#items.map((item) => ({ ...item }));
  }

  #trim(): void {
    for (let index = this.#items.length - 1; index >= 0 && this.#items.length > 30; index -= 1) {
      if (this.#items[index]!.status !== 'running') this.#items.splice(index, 1);
    }
  }
}
