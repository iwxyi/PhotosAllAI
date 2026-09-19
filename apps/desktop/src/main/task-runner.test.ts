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
    const analyze = vi.fn().mockResolvedValue({});
    queue.enqueue({ kind: 'analysis', assetId: 'asset-1', payload: { providerProfileId, mode: 'full' } });
    const runner = new TaskRunner(queue, { analyze }, { generate: vi.fn() });
    runner.start();

    await vi.waitFor(() => expect(queue.list()[0]?.status).toBe('completed'));
    expect(analyze).toHaveBeenCalledWith('asset-1', providerProfileId, expect.any(AbortSignal));
    expect(analyze.mock.calls[0]?.[2].aborted).toBe(false);
    runner.stop();
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
    expect(generate).toHaveBeenCalledWith('asset-2', expect.objectContaining(payload), expect.any(AbortSignal));
    expect(generate.mock.calls[0]?.[2].aborted).toBe(false);
    runner.stop();
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
