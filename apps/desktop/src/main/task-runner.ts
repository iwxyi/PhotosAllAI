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
  generate(assetId: string | null, payload: unknown, signal?: AbortSignal, requestId?: string): Promise<unknown>;
}

interface ExportProcessor {
  export(payload: unknown, signal: AbortSignal, taskId: string): Promise<unknown>;
}

interface AgentProcessor {
  run(payload: unknown, signal?: AbortSignal, onProgress?: (progress: number) => void): Promise<unknown>;
}

export class TaskRunner {
  static readonly #generationKinds = ['generation', 'agent'] as const;
  static readonly #catalogKinds = ['analysis', 'collection-analysis', 'export'] as const;
  #stopped = false;
  readonly #lanes = new Map<string, Promise<void>>();
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
    return Promise.all([...this.#lanes.values()]).then(() => undefined);
  }

  cancel(taskId: string): void {
    this.#controllers.get(taskId)?.abort();
  }

  wake(): void {
    if (this.#stopped) return;
    this.#wakeLane('generation', TaskRunner.#generationKinds);
    this.#wakeLane('catalog', TaskRunner.#catalogKinds);
  }

  #wakeLane(name: string, kinds: readonly PersistedTask['kind'][]): void {
    if (this.#lanes.has(name)) return;
    const promise = Promise.resolve().then(() => this.#runLane(kinds)).finally(() => {
      this.#lanes.delete(name);
      if (!this.#stopped && this.#tasks.hasQueued(kinds)) this.#wakeLane(name, kinds);
    });
    this.#lanes.set(name, promise);
  }

  async #runLane(kinds: readonly PersistedTask['kind'][]): Promise<void> {
      while (!this.#stopped) {
        const task = this.#tasks.claimNext(kinds);
        if (!task) break;
        const controller = new AbortController();
        this.#controllers.set(task.id, controller);
        try {
          if (task.kind === 'analysis' && !task.assetId) throw new Error('TASK_ASSET_MISSING');
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
            if (!task.assetId && !payload.outputFolderId) throw new Error('TASK_ASSET_MISSING');
            const generated = await this.#generation.generate(task.assetId, payload, controller.signal, task.id);
            if (generated && typeof generated === 'object') taskResult = { generation: generated };
          } else if (task.kind === 'agent') {
            const payload = agentTaskPayloadSchema.parse(task.payload);
            let acceptingProgress = true;
            try {
              taskResult = agentTaskResultSchema.parse(await this.#agent.run(payload, controller.signal, (progress) => {
                if (!acceptingProgress || controller.signal.aborted || this.#stopped) return;
                const current = this.#tasks.find(task.id);
                if (current?.status === 'processing') this.#tasks.reportProgress(task.id, progress);
              }));
            } finally {
              acceptingProgress = false;
            }
          } else {
            const payload = exportTaskPayloadSchema.parse(task.payload);
            taskResult = exportReportSchema.parse(await this.#export.export(payload, controller.signal, task.id));
          }
          const current = this.#tasks.find(task.id);
          if (controller.signal.aborted || this.#stopped || current?.status !== 'processing') continue;
          this.#tasks.advance(task.id, 'downloading', 0.85);
          this.#tasks.advance(task.id, 'saving', 0.95);
          if (task.kind === 'export' && taskResult && Number(taskResult.failed) > 0) {
            this.#tasks.finish(task.id, 'failed', taskResult, 'EXPORT_PARTIAL_FAILURE');
          } else {
            this.#tasks.finish(task.id, 'completed', taskResult);
          }
        } catch (error) {
          const current = this.#tasks.find(task.id);
          if (!controller.signal.aborted && !this.#stopped && current && (current.status === 'preparing' || current.status === 'processing')) {
            const fallback = task.kind === 'generation' ? 'GENERATION_FAILED' : task.kind === 'agent' ? 'AGENT_FAILED' : task.kind === 'export' ? 'EXPORT_FAILED' : task.kind === 'collection-analysis' ? 'COLLECTION_ANALYSIS_FAILED' : 'ANALYSIS_FAILED';
            const normalized = normalizeTaskErrorCode(error, fallback);
            const errorCode = task.kind === 'generation' && (
              (error instanceof Error && 'generationOutcomeUncertain' in error && error.generationOutcomeUncertain === true)
              ||
              /^PROVIDER_HTTP_5\d{2}(?::|$)/u.test(normalized)
              || ['PROVIDER_REQUEST_TIMEOUT', 'PROVIDER_CONNECTION_FAILED'].includes(normalized)
            ) ? 'GENERATION_RESULT_UNCERTAIN' : normalized;
            this.#tasks.advance(task.id, 'failed', current.progress, errorCode);
          }
        } finally {
          this.#controllers.delete(task.id);
        }
      }
  }
}
