import {
  analysisTaskPayloadSchema,
  exportTaskPayloadSchema,
  exportReportSchema,
  generationTaskPayloadSchema,
  type PersistedTask
} from '@photoallisai/contracts';
import type { TaskStatus } from '@photoallisai/domain';

import { normalizeTaskErrorCode } from './task-error-code';

interface TaskQueue {
  claimNext(kinds: readonly PersistedTask['kind'][]): PersistedTask | null;
  advance(taskId: string, status: TaskStatus, progress: number, errorCode?: string | null): PersistedTask;
  finish(taskId: string, status: 'completed' | 'failed', result: Record<string, unknown> | null, errorCode?: string | null): PersistedTask;
  list(): PersistedTask[];
}

interface AnalysisProcessor {
  analyze(assetId: string, providerProfileId: string, signal?: AbortSignal): Promise<unknown>;
}

interface GenerationProcessor {
  generate(assetId: string, payload: unknown, signal?: AbortSignal): Promise<unknown>;
}

interface ExportProcessor {
  export(payload: unknown, signal: AbortSignal, taskId: string): Promise<unknown>;
}

export class TaskRunner {
  #running = false;
  #stopped = false;
  readonly #controllers = new Map<string, AbortController>();
  readonly #tasks: TaskQueue;
  readonly #analysis: AnalysisProcessor;
  readonly #generation: GenerationProcessor;
  readonly #export: ExportProcessor;

  constructor(tasks: TaskQueue, analysis: AnalysisProcessor, generation: GenerationProcessor, exportProcessor: ExportProcessor = { export: async () => undefined }) {
    this.#tasks = tasks;
    this.#analysis = analysis;
    this.#generation = generation;
    this.#export = exportProcessor;
  }

  start(): void {
    this.#stopped = false;
    this.wake();
  }

  stop(): void {
    this.#stopped = true;
    for (const controller of this.#controllers.values()) controller.abort();
  }

  cancel(taskId: string): void {
    this.#controllers.get(taskId)?.abort();
  }

  wake(): void {
    if (this.#running || this.#stopped) return;
    this.#running = true;
    queueMicrotask(() => void this.#drain());
  }

  async #drain(): Promise<void> {
    try {
      while (!this.#stopped) {
        const task = this.#tasks.claimNext(['analysis', 'generation', 'export']);
        if (!task) break;
        const controller = new AbortController();
        this.#controllers.set(task.id, controller);
        try {
          if (task.kind !== 'export' && !task.assetId) throw new Error('TASK_ASSET_MISSING');
          this.#tasks.advance(task.id, 'processing', 0.1);
          let taskResult: Record<string, unknown> | null = null;
          if (task.kind === 'analysis') {
            const payload = analysisTaskPayloadSchema.parse(task.payload);
            await this.#analysis.analyze(task.assetId!, payload.providerProfileId, controller.signal);
          } else if (task.kind === 'generation') {
            const payload = generationTaskPayloadSchema.parse(task.payload);
            await this.#generation.generate(task.assetId!, payload, controller.signal);
          } else {
            const payload = exportTaskPayloadSchema.parse(task.payload);
            taskResult = exportReportSchema.parse(await this.#export.export(payload, controller.signal, task.id));
          }
          this.#tasks.advance(task.id, 'downloading', 0.85);
          this.#tasks.advance(task.id, 'saving', 0.95);
          if (task.kind === 'export' && taskResult && Number(taskResult.failed) > 0) {
            this.#tasks.finish(task.id, 'failed', taskResult, 'EXPORT_PARTIAL_FAILURE');
          } else {
            this.#tasks.finish(task.id, 'completed', taskResult);
          }
        } catch (error) {
          const current = this.#tasks.list().find((item) => item.id === task.id);
          if (current && current.status !== 'canceled' && current.status !== 'failed') {
            const fallback = task.kind === 'generation' ? 'GENERATION_FAILED' : task.kind === 'export' ? 'EXPORT_FAILED' : 'ANALYSIS_FAILED';
            const errorCode = normalizeTaskErrorCode(error, fallback);
            this.#tasks.advance(task.id, 'failed', current.progress, errorCode);
          }
        } finally {
          this.#controllers.delete(task.id);
        }
      }
    } finally {
      this.#running = false;
      if (!this.#stopped && this.#tasks.list().some((task) =>
        (task.kind === 'analysis' || task.kind === 'generation' || task.kind === 'export') && task.status === 'queued'
      )) {
        this.wake();
      }
    }
  }
}
