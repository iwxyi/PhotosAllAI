import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { TaskRunner } from './task-runner';
import { TaskService } from './task-service';

const temporaryDirectories: string[] = [];
const providerProfileId = 'cf9c8a2a-e903-45c9-b531-129a0d4fbe5d';

async function tasks(): Promise<TaskService> {
  const directory = await mkdtemp(path.join(tmpdir(), 'photoallisai-runner-'));
  temporaryDirectories.push(directory);
  return new TaskService(path.join(directory, 'catalog.sqlite'));
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('analysis task runner', () => {
  it('does not restore a deleted running task when its processor returns late', async () => {
    const queue = await tasks();
    const task = queue.enqueue({ kind: 'analysis', assetId: 'deleted', payload: { providerProfileId, mode: 'full' } });
    let resolveAnalysis!: (value: unknown) => void;
    let signal: AbortSignal | undefined;
    const analyze = vi.fn((_id: string, _profile: string, received?: AbortSignal) => {
      signal = received;
      return new Promise((resolve) => { resolveAnalysis = resolve; });
    });
    const runner = new TaskRunner(queue, { analyze }, { generate: vi.fn() });
    runner.start();
    await vi.waitFor(() => expect(queue.find(task.id)?.status).toBe('processing'));
    runner.cancel(task.id);
    queue.deleteTasks([task.id]);
    expect(signal?.aborted).toBe(true);
    resolveAnalysis({});
    await runner.stop();
    expect(queue.find(task.id)).toBeNull();
    expect(queue.listPage({}).totalCount).toBe(0);
    queue.close();
  });
  it('runs an agent plan and persists its structured workflow result', async () => {
    const queue = await tasks();
    const payload = {
      instruction: '删除模糊图，选出最好看的 30 张并进行动漫风修图',
      globalPrompt: '动漫风，保留人物身份',
      selection: { excludeBlurry: true, excludeNearDuplicates: true, limit: 30 },
      perAssetPrompts: [{ assetId: 'asset-1', prompt: '突出眼神', negativePrompt: '过度磨皮' }],
      steps: [
        { id: 'select', kind: 'select', selection: { limit: 30 } },
        { id: 'edit', kind: 'generate', providerProfileId, prompt: '动漫风', dependsOn: ['select'] }
      ],
      outputDirectory: '/tmp/动漫',
      dryRun: false
    };
    const result = {
      selectedAssetIds: ['asset-1'], removedAssetIds: ['asset-2'], ratedAssetIds: ['asset-1'],
      generatedResultIds: ['32b027ec-aa41-4d0e-a9ea-5c42a2393108'], movedAssetIds: ['asset-1'],
      completedSteps: ['select', 'edit'], skippedSteps: [], warnings: [], dryRun: false
    };
    const run = vi.fn().mockResolvedValue(result);
    const task = queue.enqueue({ kind: 'agent', assetId: null, payload });
    const runner = new TaskRunner(queue, { analyze: vi.fn() }, { generate: vi.fn() }, undefined, { run });
    runner.start();
    await vi.waitFor(() => expect(queue.find(task.id)?.status).toBe('completed'));
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ globalPrompt: payload.globalPrompt }), expect.any(AbortSignal), expect.any(Function));
    expect(queue.find(task.id)?.result).toEqual(result);
    await runner.stop();
    queue.close();
  });

  it('ignores agent progress reported after shutdown begins', async () => {
    const queue = await tasks();
    const task = queue.enqueue({ kind: 'agent', assetId: null, payload: {
      instruction: 'Review the selection', steps: [{ id: 'select', kind: 'select', selection: { limit: 30 } }]
    } });
    let reportProgress!: (progress: number) => void;
    let resolveRun!: (value: unknown) => void;
    const run = vi.fn((_payload: unknown, _signal?: AbortSignal, onProgress?: (progress: number) => void) => {
      reportProgress = onProgress!;
      return new Promise((resolve) => { resolveRun = resolve; });
    });
    const runner = new TaskRunner(queue, { analyze: vi.fn() }, { generate: vi.fn() }, undefined, { run });
    runner.start();
    await vi.waitFor(() => expect(queue.find(task.id)?.status).toBe('processing'));
    const progress = queue.find(task.id)!.progress;

    const stopped = runner.stop();
    reportProgress(0.8);
    expect(queue.find(task.id)?.progress).toBe(progress);
    resolveRun({ selectedAssetIds: [], removedAssetIds: [], ratedAssetIds: [], generatedResultIds: [], movedAssetIds: [], completedSteps: [], skippedSteps: [], warnings: [], dryRun: false });
    await stopped;
    expect(queue.find(task.id)?.status).toBe('processing');
    queue.close();
  });

  it('ignores progress from an old agent attempt after the resumed attempt starts', async () => {
    const queue = await tasks();
    const task = queue.enqueue({ kind: 'agent', assetId: null, payload: {
      instruction: 'Review the selection', steps: [{ id: 'select', kind: 'select', selection: { limit: 30 } }]
    } });
    let oldProgress!: (progress: number) => void;
    let resolveFirst!: (value: unknown) => void;
    let resolveSecond!: (value: unknown) => void;
    let attempt = 0;
    const run = vi.fn((_payload: unknown, _signal?: AbortSignal, onProgress?: (progress: number) => void) =>
      new Promise((resolve) => {
        if (attempt++ === 0) {
          oldProgress = onProgress!;
          resolveFirst = resolve;
        } else {
          resolveSecond = resolve;
        }
      })
    );
    const runner = new TaskRunner(queue, { analyze: vi.fn() }, { generate: vi.fn() }, undefined, { run });
    runner.start();
    await vi.waitFor(() => expect(queue.find(task.id)?.status).toBe('processing'));
    queue.pause(task.id);
    queue.resume(task.id);
    resolveFirst({});
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));

    const progress = queue.find(task.id)!.progress;
    oldProgress(0.8);
    expect(queue.find(task.id)?.progress).toBe(progress);
    resolveSecond({});
    await vi.waitFor(() => expect(queue.find(task.id)?.status).toBe('completed'));
    await runner.stop();
    queue.close();
  });

  it('keeps an actively paused task paused after aborting its processor', async () => {
    const queue = await tasks();
    const task = queue.enqueue({ kind: 'analysis', assetId: 'asset-paused', payload: { providerProfileId, mode: 'full' } });
    let receivedSignal: AbortSignal | undefined;
    const analyze = vi.fn((_assetId: string, _providerProfileId: string, signal?: AbortSignal) => {
      receivedSignal = signal;
      return new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      });
    });
    const runner = new TaskRunner(queue, { analyze }, { generate: vi.fn() });
    runner.start();
    await vi.waitFor(() => expect(queue.find(task.id)?.status).toBe('processing'));

    queue.pause(task.id);
    runner.cancel(task.id);
    await vi.waitFor(() => expect(receivedSignal?.aborted).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(queue.find(task.id)?.status).toBe('paused');
    await runner.stop();
    queue.close();
  });

  it('ignores a late result from a paused attempt after the task resumes', async () => {
    const queue = await tasks();
    const task = queue.enqueue({ kind: 'analysis', assetId: 'asset-resumed', payload: { providerProfileId, mode: 'full' } });
    let resolveFirst!: (value: unknown) => void;
    const analyze = vi.fn()
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }))
      .mockResolvedValueOnce({ id: 'new-revision', result: { summary: 'current attempt' } });
    const runner = new TaskRunner(queue, { analyze }, { generate: vi.fn() });
    runner.start();
    await vi.waitFor(() => expect(queue.find(task.id)?.status).toBe('processing'));

    queue.pause(task.id);
    runner.cancel(task.id);
    queue.resume(task.id);
    resolveFirst({ id: 'old-revision', result: { summary: 'stale attempt' } });

    await vi.waitFor(() => expect(queue.find(task.id)?.status).toBe('completed'));
    expect(analyze).toHaveBeenCalledTimes(2);
    expect(queue.find(task.id)?.result).toEqual({
      analysisRevisionId: 'new-revision', analysis: { summary: 'current attempt' }
    });
    await runner.stop();
    queue.close();
  });

  it('ignores a late failure from an attempt that was paused and resumed', async () => {
    const queue = await tasks();
    const task = queue.enqueue({ kind: 'analysis', assetId: 'asset-retry', payload: { providerProfileId, mode: 'full' } });
    let rejectFirst!: (reason: Error) => void;
    const analyze = vi.fn()
      .mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectFirst = reject; }))
      .mockResolvedValueOnce({ id: 'retry-revision', result: { summary: 'retry succeeded' } });
    const runner = new TaskRunner(queue, { analyze }, { generate: vi.fn() });
    runner.start();
    await vi.waitFor(() => expect(queue.find(task.id)?.status).toBe('processing'));

    queue.pause(task.id);
    queue.resume(task.id);
    rejectFirst(new Error('PROVIDER_HTTP_429'));

    await vi.waitFor(() => expect(queue.find(task.id)?.status).toBe('completed'));
    expect(analyze).toHaveBeenCalledTimes(2);
    expect(queue.find(task.id)?.result).toEqual({
      analysisRevisionId: 'retry-revision', analysis: { summary: 'retry succeeded' }
    });
    await runner.stop();
    queue.close();
  });

  it('leaves active work recoverable when shutdown aborts the processor', async () => {
    const queue = await tasks();
    const task = queue.enqueue({ kind: 'analysis', assetId: 'asset-shutdown', payload: { providerProfileId, mode: 'full' } });
    const analyze = vi.fn((_assetId: string, _providerProfileId: string, signal?: AbortSignal) =>
      new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      })
    );
    const runner = new TaskRunner(queue, { analyze }, { generate: vi.fn() });
    runner.start();
    await vi.waitFor(() => expect(queue.find(task.id)?.status).toBe('processing'));

    await runner.stop();
    expect(queue.find(task.id)?.status).toBe('processing');
    const databasePath = path.join(temporaryDirectories.at(-1)!, 'catalog.sqlite');
    queue.close();

    const recoveredQueue = new TaskService(databasePath);
    expect(recoveredQueue.find(task.id)).toMatchObject({
      status: 'queued',
      progress: 0,
      attempt: 1,
      errorCode: 'APP_INTERRUPTED'
    });
    recoveredQueue.close();
  });

  it('processes queued analysis work through completion', async () => {
    const queue = await tasks();
    const revision = { id: 'revision-1', result: { summary: '中文分析' } };
    const analyze = vi.fn().mockResolvedValue(revision);
    queue.enqueue({ kind: 'analysis', assetId: 'asset-1', payload: { providerProfileId, mode: 'full', locale: 'zh-CN' } });
    const runner = new TaskRunner(queue, { analyze }, { generate: vi.fn() });
    runner.start();

    await vi.waitFor(() => expect(queue.list()[0]?.status).toBe('completed'));
    expect(analyze).toHaveBeenCalledWith('asset-1', providerProfileId, expect.any(AbortSignal), 'zh-CN');
    expect(queue.list()[0]?.result).toEqual({ analysisRevisionId: revision.id, analysis: revision.result });
    expect(analyze.mock.calls[0]?.[2].aborted).toBe(false);
    runner.stop();
    queue.close();
  });

  it('processes collection analysis and persists its structured report', async () => {
    const queue = await tasks();
    const report = {
      summary: '两张照片内容相近，第一张质量更好。',
      groups: [{ title: '相似人像', assetIds: ['asset-1', 'asset-2'], reason: '构图与主体一致' }],
      keepAssetIds: ['asset-1'],
      reviewAssetIds: ['asset-2'],
      recommendations: ['保留第一张作为主选']
    };
    const analyzeCollection = vi.fn().mockResolvedValue(report);
    queue.enqueue({ kind: 'collection-analysis', assetId: null, payload: { providerProfileId, assetIds: ['asset-1', 'asset-2'] } });
    const runner = new TaskRunner(queue, { analyze: vi.fn(), analyzeCollection }, { generate: vi.fn() });
    runner.start();

    await vi.waitFor(() => expect(queue.list()[0]?.status).toBe('completed'));
    expect(analyzeCollection).toHaveBeenCalledWith(['asset-1', 'asset-2'], providerProfileId, expect.any(AbortSignal), undefined);
    expect(queue.list()[0]?.result).toEqual(report);
    await runner.stop();
    queue.close();
  });

  it('records a stable failure code and leaves the task retryable', async () => {
    const queue = await tasks();
    queue.enqueue({ kind: 'analysis', assetId: 'asset-1', payload: { providerProfileId, mode: 'full' } });
    const runner = new TaskRunner(
      queue,
      { analyze: vi.fn().mockRejectedValue(new Error('PROVIDER_HTTP_429')) },
      { generate: vi.fn() }
    );
    runner.start();

    await vi.waitFor(() => expect(queue.list()[0]?.status).toBe('failed'));
    expect(queue.list()[0]?.errorCode).toBe('PROVIDER_HTTP_429');
    runner.stop();
    queue.close();
  });

  it('does not persist free-form failure details', async () => {
    const queue = await tasks();
    queue.enqueue({ kind: 'analysis', assetId: 'asset-1', payload: { providerProfileId, mode: 'full' } });
    const privateDetail = '/Users/private/Pictures/client.raw';
    const runner = new TaskRunner(
      queue,
      { analyze: vi.fn().mockRejectedValue(new Error(`failed reading ${privateDetail}`)) },
      { generate: vi.fn() }
    );
    runner.start();

    await vi.waitFor(() => expect(queue.list()[0]?.status).toBe('failed'));
    expect(queue.list()[0]?.errorCode).toBe('ANALYSIS_FAILED');
    expect(JSON.stringify(queue.list()[0])).not.toContain(privateDetail);
    runner.stop();
    queue.close();
  });

  it('processes generation work in the shared serial queue', async () => {
    const queue = await tasks();
    const generate = vi.fn().mockResolvedValue({});
    const payload = {
      providerProfileId,
      batchId: '4fdbbb8a-8c33-484a-9719-2d36d61c4f66',
      prompt: 'Remove pedestrians',
      resultIndex: 1
    };
    queue.enqueue({ kind: 'generation', assetId: 'asset-2', payload });
    const runner = new TaskRunner(queue, { analyze: vi.fn() }, { generate });
    runner.start();

    await vi.waitFor(() => expect(queue.list()[0]?.status).toBe('completed'));
    expect(generate).toHaveBeenCalledWith('asset-2', expect.objectContaining(payload), expect.any(AbortSignal), expect.any(String));
    expect(generate.mock.calls[0]?.[2].aborted).toBe(false);
    runner.stop();
    queue.close();
  });

  it('keeps catalog analysis responsive while a generation request is in flight', async () => {
    const queue = await tasks();
    let resolveGeneration!: (value: unknown) => void;
    const generate = vi.fn(() => new Promise((resolve) => { resolveGeneration = resolve; }));
    const analyze = vi.fn().mockResolvedValue({ id: 'revision-concurrent', result: { summary: 'ready' } });
    queue.enqueue({ kind: 'generation', assetId: 'asset-generation', payload: {
      providerProfileId, batchId: '4fdbbb8a-8c33-484a-9719-2d36d61c4f66', prompt: 'Generate', resultIndex: 1
    } });
    const analysis = queue.enqueue({ kind: 'analysis', assetId: 'asset-analysis', payload: { providerProfileId, mode: 'full' } });
    const runner = new TaskRunner(queue, { analyze }, { generate });
    runner.start();

    await vi.waitFor(() => expect(generate).toHaveBeenCalled());
    await vi.waitFor(() => expect(queue.find(analysis.id)?.status).toBe('completed'));
    expect(queue.find(analysis.id)?.result).toEqual({
      analysisRevisionId: 'revision-concurrent', analysis: { summary: 'ready' }
    });
    expect(queue.list().find((task) => task.kind === 'generation')?.status).toBe('processing');
    resolveGeneration({});
    await runner.stop();
    queue.close();
  });

  it('marks a generation gateway failure as uncertain instead of bulk retryable', async () => {
    const queue = await tasks();
    const task = queue.enqueue({ kind: 'generation', assetId: 'asset-uncertain', payload: {
      providerProfileId, batchId: '4fdbbb8a-8c33-484a-9719-2d36d61c4f66', prompt: 'Generate', resultIndex: 1
    } });
    const runner = new TaskRunner(queue, { analyze: vi.fn() }, {
      generate: vi.fn().mockRejectedValue(new Error('PROVIDER_HTTP_503: gateway unavailable'))
    });
    runner.start();
    await vi.waitFor(() => expect(queue.find(task.id)?.status).toBe('failed'));
    expect(queue.find(task.id)?.errorCode).toBe('GENERATION_RESULT_UNCERTAIN');
    expect(queue.retryFailedGenerations()).toEqual({ retried: 0, remaining: 0 });
    await runner.stop();
    queue.close();
  });

  it('marks a successful provider response that cannot be saved as uncertain', async () => {
    const queue = await tasks();
    const task = queue.enqueue({ kind: 'generation', assetId: 'asset-invalid-result', payload: {
      providerProfileId, batchId: '4fdbbb8a-8c33-484a-9719-2d36d61c4f66', prompt: 'Generate', resultIndex: 1
    } });
    const error = Object.assign(new Error('PROVIDER_IMAGE_MISSING'), { generationOutcomeUncertain: true });
    const runner = new TaskRunner(queue, { analyze: vi.fn() }, { generate: vi.fn().mockRejectedValue(error) });
    runner.start();
    await vi.waitFor(() => expect(queue.find(task.id)?.status).toBe('failed'));
    expect(queue.find(task.id)?.errorCode).toBe('GENERATION_RESULT_UNCERTAIN');
    await runner.stop();
    queue.close();
  });

  it('wakes an idle catalog lane when analysis is queued during generation', async () => {
    const queue = await tasks();
    let resolveGeneration!: (value: unknown) => void;
    const generate = vi.fn(() => new Promise((resolve) => { resolveGeneration = resolve; }));
    queue.enqueue({ kind: 'generation', assetId: 'asset-generation', payload: {
      providerProfileId, batchId: '4fdbbb8a-8c33-484a-9719-2d36d61c4f66', prompt: 'Generate', resultIndex: 1
    } });
    const runner = new TaskRunner(queue, { analyze: vi.fn().mockResolvedValue({ id: 'revision-late', result: {} }) }, { generate });
    runner.start();
    await vi.waitFor(() => expect(generate).toHaveBeenCalled());

    const analysis = queue.enqueue({ kind: 'analysis', assetId: 'asset-late', payload: { providerProfileId, mode: 'full' } });
    runner.wake();
    await vi.waitFor(() => expect(queue.find(analysis.id)?.status).toBe('completed'));
    expect(queue.list().find((task) => task.kind === 'generation')?.status).toBe('processing');
    resolveGeneration({});
    await runner.stop();
    queue.close();
  });

  it('aborts active generation without completing or failing the canceled task', async () => {
    const queue = await tasks();
    let receivedSignal: AbortSignal | undefined;
    const generate = vi.fn((_assetId: string, _payload: unknown, signal?: AbortSignal) => {
      receivedSignal = signal;
      return new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      });
    });
    queue.enqueue({
      kind: 'generation',
      assetId: 'asset-3',
      payload: {
        providerProfileId,
        batchId: '4fdbbb8a-8c33-484a-9719-2d36d61c4f66',
        prompt: 'Remove pedestrians',
        resultIndex: 1
      }
    });
    const runner = new TaskRunner(queue, { analyze: vi.fn() }, { generate });
    runner.start();
    await vi.waitFor(() => expect(generate).toHaveBeenCalled());

    runner.cancel(queue.list()[0]!.id);
    queue.cancel(queue.list()[0]!.id);
    await vi.waitFor(() => expect(receivedSignal?.aborted).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(queue.list()[0]?.status).toBe('canceled');
    runner.stop();
    queue.close();
  });

  it('processes queued export work with its dedicated payload contract', async () => {
    const queue = await tasks();
    const exportTask = vi.fn().mockResolvedValue({
      id: '04b31e0b-71d4-4654-8d56-8f197632e612', canceled: false,
      total: 1, succeeded: 1, failed: 0,
      files: [{ resultId: '32b027ec-aa41-4d0e-a9ea-5c42a2393108', fileName: 'photo.png' }],
      failures: []
    });
    const payload = {
      resultIds: ['32b027ec-aa41-4d0e-a9ea-5c42a2393108'],
      destinationDirectory: '/tmp/photoallisai-export'
    };
    queue.enqueue({ kind: 'export', assetId: null, payload });
    const runner = new TaskRunner(queue, { analyze: vi.fn() }, { generate: vi.fn() }, { export: exportTask });
    runner.start();

    await vi.waitFor(() => expect(queue.list()[0]?.status).toBe('completed'));
    expect(exportTask).toHaveBeenCalledWith(expect.objectContaining(payload), expect.any(AbortSignal), expect.any(String));
    expect(exportTask.mock.calls[0]?.[2]).toBe(queue.list()[0]?.id);
    expect(queue.list()[0]?.result).toMatchObject({ succeeded: 1, failed: 0 });
    runner.stop();
    queue.close();
  });

  it('records export-specific failures and keeps the task retryable', async () => {
    const queue = await tasks();
    queue.enqueue({
      kind: 'export',
      assetId: null,
      payload: {
        resultIds: ['32b027ec-aa41-4d0e-a9ea-5c42a2393108'],
        destinationDirectory: '/tmp/photoallisai-export'
      }
    });
    const runner = new TaskRunner(queue, { analyze: vi.fn() }, { generate: vi.fn() }, {
      export: vi.fn().mockRejectedValue(new Error('EXPORT_DESTINATION_NOT_DIRECTORY'))
    });
    runner.start();

    await vi.waitFor(() => expect(queue.list()[0]?.status).toBe('failed'));
    expect(queue.list()[0]?.errorCode).toBe('EXPORT_DESTINATION_NOT_DIRECTORY');
    runner.stop();
    queue.close();
  });

  it('persists a partial export report as a retryable failure', async () => {
    const queue = await tasks();
    queue.enqueue({
      kind: 'export', assetId: null,
      payload: {
        resultIds: ['32b027ec-aa41-4d0e-a9ea-5c42a2393108'],
        destinationDirectory: '/tmp/photoallisai-export'
      }
    });
    const report = {
      id: '04b31e0b-71d4-4654-8d56-8f197632e612', canceled: false,
      total: 1, succeeded: 0, failed: 1, files: [],
      failures: [{ resultId: '32b027ec-aa41-4d0e-a9ea-5c42a2393108', errorCode: 'EXPORT_NAME_EXISTS' }]
    };
    const runner = new TaskRunner(queue, { analyze: vi.fn() }, { generate: vi.fn() }, {
      export: vi.fn().mockResolvedValue(report)
    });
    runner.start();

    await vi.waitFor(() => expect(queue.list()[0]?.status).toBe('failed'));
    expect(queue.list()[0]).toMatchObject({
      progress: 1,
      errorCode: 'EXPORT_PARTIAL_FAILURE',
      result: report
    });
    const retried = queue.retry(queue.list()[0]!.id);
    expect(retried).toMatchObject({ status: 'queued', progress: 0, result: null });
    runner.stop();
    queue.close();
  });
});
