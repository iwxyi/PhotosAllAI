import { analysisTaskPayloadSchema, type PersistedTask } from '@photoallisai/contracts';
import type { TaskStatus } from '@photoallisai/domain';

interface TaskQueue {
  claimNext(kinds: readonly PersistedTask['kind'][]): PersistedTask | null;
  advance(taskId: string, status: TaskStatus, progress: number, errorCode?: string | null): PersistedTask;
  list(): PersistedTask[];
}

interface AnalysisProcessor {
  analyze(assetId: string, providerProfileId: string): Promise<unknown>;
}

export class TaskRunner {
  #running = false;
  #stopped = false;
  readonly #tasks: TaskQueue;
  readonly #analysis: AnalysisProcessor;

  constructor(tasks: TaskQueue, analysis: AnalysisProcessor) {
    this.#tasks = tasks;
    this.#analysis = analysis;
  }

  start(): void {
    this.#stopped = false;
    this.wake();
  }

  stop(): void {
    this.#stopped = true;
  }

  wake(): void {
    if (this.#running || this.#stopped) return;
    this.#running = true;
    queueMicrotask(() => void this.#drain());
  }

  async #drain(): Promise<void> {
    try {
      while (!this.#stopped) {
        const task = this.#tasks.claimNext(['analysis']);
        if (!task) break;
        try {
          const payload = analysisTaskPayloadSchema.parse(task.payload);
          if (!task.assetId) throw new Error('TASK_ASSET_MISSING');
          this.#tasks.advance(task.id, 'processing', 0.1);
          await this.#analysis.analyze(task.assetId, payload.providerProfileId);
          this.#tasks.advance(task.id, 'downloading', 0.85);
          this.#tasks.advance(task.id, 'saving', 0.95);
          this.#tasks.advance(task.id, 'completed', 1);
        } catch (error) {
          const current = this.#tasks.list().find((item) => item.id === task.id);
          if (current && current.status !== 'canceled' && current.status !== 'failed') {
            const errorCode = error instanceof Error ? error.message.slice(0, 200) : 'ANALYSIS_FAILED';
            this.#tasks.advance(task.id, 'failed', current.progress, errorCode);
          }
        }
      }
    } finally {
      this.#running = false;
      if (!this.#stopped && this.#tasks.list().some((task) => task.kind === 'analysis' && task.status === 'queued')) {
        this.wake();
      }
    }
  }
}
