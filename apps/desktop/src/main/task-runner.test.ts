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
  it('processes queued analysis work through completion', async () => {
    const queue = await tasks();
    const analyze = vi.fn().mockResolvedValue({});
    queue.enqueue({ kind: 'analysis', assetId: 'asset-1', payload: { providerProfileId, mode: 'full' } });
    const runner = new TaskRunner(queue, { analyze }, { generate: vi.fn() });
    runner.start();

    await vi.waitFor(() => expect(queue.list()[0]?.status).toBe('completed'));
    expect(analyze).toHaveBeenCalledWith('asset-1', providerProfileId);
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
    expect(generate).toHaveBeenCalledWith('asset-2', expect.objectContaining(payload));
    runner.stop();
    queue.close();
  });
});
