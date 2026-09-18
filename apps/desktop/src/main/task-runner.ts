import {
  analysisTaskPayloadSchema,
  generationTaskPayloadSchema,
  type PersistedTask
} from '@photoallisai/contracts';
import type { TaskStatus } from '@photoallisai/domain';

interface TaskQueue {
  claimNext(kinds: readonly PersistedTask['kind'][]): PersistedTask | null;
  advance(taskId: string, status: TaskStatus, progress: number, errorCode?: string | null): PersistedTask;
  list(): PersistedTask[];
}

interface AnalysisProcessor {
  analyze(assetId: string, providerProfileId: string): Promise<unknown>;
}

interface GenerationProcessor {
  generate(assetId: string, payload: unknown): Promise<unknown>;
}

export class TaskRunner {
  #running = false;
  #stopped = false;
  readonly #tasks: TaskQueue;
  readonly #analysis: AnalysisProcessor;
  readonly #generation: GenerationProcessor;

  constructor(tasks: TaskQueue, analysis: AnalysisProcessor, generation: GenerationProcessor) {
    this.#tasks = tasks;
    this.#analysis = analysis;
    this.#generation = generation;
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
        const task = this.#tasks.claimNext(['analysis', 'generation']);
        if (!task) break;
        try {
          if (!task.assetId) throw new Error('TASK_ASSET_MISSING');
          this.#tasks.advance(task.id, 'processing', 0.1);
          if (task.kind === 'analysis') {
            const payload = analysisTaskPayloadSchema.parse(task.payload);
            await this.#analysis.analyze(task.assetId, payload.providerProfileId);
          } else {
            const payload = generationTaskPayloadSchema.parse(task.payload);
            await this.#generation.generate(task.assetId, payload);
          }
          this.#tasks.advance(task.id, 'downloading', 0.85);
          this.#tasks.advance(task.id, 'saving', 0.95);
          this.#tasks.advance(task.id, 'completed', 1);
        } catch (error) {
          const current = this.#tasks.list().find((item) => item.id === task.id);
          if (current && current.status !== 'canceled' && current.status !== 'failed') {
            const fallback = task.kind === 'generation' ? 'GENERATION_FAILED' : 'ANALYSIS_FAILED';
            const errorCode = error instanceof Error ? error.message.slice(0, 200) : fallback;
            this.#tasks.advance(task.id, 'failed', current.progress, errorCode);
          }
        }
      }
    } finally {
      this.#running = false;
      if (!this.#stopped && this.#tasks.list().some((task) =>
        (task.kind === 'analysis' || task.kind === 'generation') && task.status === 'queued'
      )) {
        this.wake();
      }
    }
  }
}
