import {
  analysisTaskPayloadSchema,
  agentTaskPayloadSchema,
  agentTaskResultSchema,
  collectionAnalysisReportSchema,
  collectionAnalysisTaskPayloadSchema,
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
  reportProgress(taskId: string, progress: number, result?: Record<string, unknown>): PersistedTask;
  finish(taskId: string, status: 'completed' | 'failed', result: Record<string, unknown> | null, errorCode?: string | null): PersistedTask;
  find(taskId: string): PersistedTask | null;
  hasQueued(kinds: readonly PersistedTask['kind'][]): boolean;
}

interface AnalysisProcessor {
  analyze(assetId: string, providerProfileId: string, signal?: AbortSignal, locale?: 'zh-CN' | 'en-US'): Promise<unknown>;
  analyzeCollection?(assetIds: string[], providerProfileId: string, signal?: AbortSignal, locale?: 'zh-CN' | 'en-US'): Promise<unknown>;
}

interface GenerationProcessor {
  generate(assetId: string, payload: unknown, signal?: AbortSignal): Promise<unknown>;
}

interface ExportProcessor {
  export(payload: unknown, signal: AbortSignal, taskId: string): Promise<unknown>;
}

interface AgentProcessor {
  run(payload: unknown, signal?: AbortSignal, onProgress?: (progress: number) => void): Promise<unknown>;
}

export class TaskRunner {
  #running = false;
  #stopped = false;
  #drainPromise: Promise<void> | null = null;
  readonly #controllers = new Map<string, AbortController>();
  readonly #tasks: TaskQueue;
  readonly #analysis: AnalysisProcessor;
  readonly #generation: GenerationProcessor;
  readonly #export: ExportProcessor;
  readonly #agent: AgentProcessor;

  constructor(
    tasks: TaskQueue,
    analysis: AnalysisProcessor,
    generation: GenerationProcessor,
    exportProcessor: ExportProcessor = { export: async () => undefined },
    agentProcessor: AgentProcessor = { run: async () => { throw new Error('AGENT_PROCESSOR_UNAVAILABLE'); } }
  ) {
    this.#tasks = tasks;
    this.#analysis = analysis;
    this.#generation = generation;
    this.#export = exportProcessor;
    this.#agent = agentProcessor;
  }

  start(): void {
    this.#stopped = false;
    this.wake();
  }

  stop(): Promise<void> {
    this.#stopped = true;
    for (const controller of this.#controllers.values()) controller.abort();
    return this.#drainPromise ?? Promise.resolve();
  }

  cancel(taskId: string): void {
    this.#controllers.get(taskId)?.abort();
  }

  wake(): void {
    if (this.#running || this.#stopped) return;
    this.#running = true;
    this.#drainPromise = Promise.resolve().then(() => this.#drain());
  }

  async #drain(): Promise<void> {
    try {
      while (!this.#stopped) {
        const task = this.#tasks.claimNext(['analysis', 'collection-analysis', 'generation', 'agent', 'export']);
        if (!task) break;
        const controller = new AbortController();
        this.#controllers.set(task.id, controller);
        try {
          if ((task.kind === 'analysis' || task.kind === 'generation') && !task.assetId) throw new Error('TASK_ASSET_MISSING');
          this.#tasks.advance(task.id, 'processing', 0.1);
          let taskResult: Record<string, unknown> | null = null;
          if (task.kind === 'analysis') {
            const payload = analysisTaskPayloadSchema.parse(task.payload);
            const revision = await this.#analysis.analyze(task.assetId!, payload.providerProfileId, controller.signal, payload.locale);
            if (revision && typeof revision === 'object' && 'id' in revision && 'result' in revision) {
              taskResult = { analysisRevisionId: revision.id, analysis: revision.result };
            }
          } else if (task.kind === 'collection-analysis') {
            const payload = collectionAnalysisTaskPayloadSchema.parse(task.payload);
            if (!this.#analysis.analyzeCollection) throw new Error('COLLECTION_ANALYSIS_UNAVAILABLE');
            taskResult = collectionAnalysisReportSchema.parse(await this.#analysis.analyzeCollection(payload.assetIds, payload.providerProfileId, controller.signal, payload.locale));
          } else if (task.kind === 'generation') {
            const payload = generationTaskPayloadSchema.parse(task.payload);
            const generated = await this.#generation.generate(task.assetId!, payload, controller.signal);
            if (generated && typeof generated === 'object') taskResult = { generation: generated };
          } else if (task.kind === 'agent') {
            const payload = agentTaskPayloadSchema.parse(task.payload);
            taskResult = agentTaskResultSchema.parse(await this.#agent.run(payload, controller.signal, (progress) => {
              const current = this.#tasks.find(task.id);
              if (current && current.status !== 'paused' && current.status !== 'canceled') {
                this.#tasks.reportProgress(task.id, progress);
              }
            }));
          } else {
            const payload = exportTaskPayloadSchema.parse(task.payload);
            taskResult = exportReportSchema.parse(await this.#export.export(payload, controller.signal, task.id));
          }
          if (!this.#tasks.find(task.id)) continue;
          this.#tasks.advance(task.id, 'downloading', 0.85);
          this.#tasks.advance(task.id, 'saving', 0.95);
          if (task.kind === 'export' && taskResult && Number(taskResult.failed) > 0) {
            this.#tasks.finish(task.id, 'failed', taskResult, 'EXPORT_PARTIAL_FAILURE');
          } else {
            this.#tasks.finish(task.id, 'completed', taskResult);
          }
        } catch (error) {
          const current = this.#tasks.find(task.id);
          if (!this.#stopped && current && current.status !== 'paused' && current.status !== 'canceled' && current.status !== 'failed') {
            const fallback = task.kind === 'generation' ? 'GENERATION_FAILED' : task.kind === 'agent' ? 'AGENT_FAILED' : task.kind === 'export' ? 'EXPORT_FAILED' : task.kind === 'collection-analysis' ? 'COLLECTION_ANALYSIS_FAILED' : 'ANALYSIS_FAILED';
            const errorCode = normalizeTaskErrorCode(error, fallback);
            this.#tasks.advance(task.id, 'failed', current.progress, errorCode);
          }
        } finally {
          this.#controllers.delete(task.id);
        }
      }
    } finally {
      this.#running = false;
      this.#drainPromise = null;
      if (!this.#stopped && this.#tasks.hasQueued(['analysis', 'collection-analysis', 'generation', 'agent', 'export'])) {
        this.wake();
      }
    }
  }
}
