import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it } from 'vitest';

import { TaskService } from './task-service';

const temporaryDirectories: string[] = [];

async function databasePath(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'photoallisai-tasks-'));
  temporaryDirectories.push(directory);
  return path.join(directory, 'catalog.sqlite');
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('persistent task service', () => {
  it('queues and reorders tasks deterministically', async () => {
    const tasks = new TaskService(await databasePath());
    const first = tasks.enqueue({ kind: 'analysis', assetId: 'asset-1', payload: { depth: 'full' } });
    const second = tasks.enqueue({ kind: 'generation', assetId: 'asset-2', payload: { count: 1 } });
    expect(tasks.list().map((task) => task.id)).toEqual([first.id, second.id]);
    expect(tasks.reorder([second.id, first.id]).map((task) => task.id)).toEqual([second.id, first.id]);
    tasks.close();
  });

  it('cancels and retries a queued task without losing its payload', async () => {
    const tasks = new TaskService(await databasePath());
    const task = tasks.enqueue({ kind: 'generation', assetId: 'asset-1', payload: { prompt: 'clean' } });
    expect(tasks.cancel(task.id).status).toBe('canceled');
    const retried = tasks.retry(task.id);
    expect(retried.status).toBe('queued');
    expect(retried.payload).toEqual({ prompt: 'clean' });
    tasks.close();
  });

  it('assigns retried tasks after the current queue tail', async () => {
    const tasks = new TaskService(await databasePath());
    const queued = tasks.enqueue({ kind: 'analysis', assetId: 'asset-queued', payload: {} });
    const failed = tasks.enqueue({ kind: 'generation', assetId: 'asset-failed', payload: {} });
    tasks.claimNext(['generation']);
    tasks.advance(failed.id, 'processing', 0.1);
    tasks.advance(failed.id, 'failed', 0.1, 'TEST_FAILURE');

    const retried = tasks.retry(failed.id);
    expect(retried.position).toBe(1);
    expect(tasks.list().filter((task) => task.status === 'queued').map((task) => task.id)).toEqual([queued.id, failed.id]);
    tasks.close();
  });

  it('recovers interrupted work after application restart', async () => {
    const file = await databasePath();
    const tasks = new TaskService(file);
    const task = tasks.enqueue({ kind: 'generation', assetId: 'asset-1', payload: {} });
    tasks.close();

    const database = new DatabaseSync(file);
    database.prepare(`UPDATE tasks SET status = 'processing', progress = 0.6 WHERE id = ?`).run(task.id);
    database.close();

    const recoveredService = new TaskService(file);
    const recovered = recoveredService.list()[0];
    expect(recovered).toMatchObject({ status: 'queued', progress: 0, attempt: 1, errorCode: 'APP_INTERRUPTED' });
    recoveredService.close();
  });

  it('edits only queued generation prompts and records the validated snapshot', async () => {
    const tasks = new TaskService(await databasePath());
    const task = tasks.enqueue({
      kind: 'generation',
      assetId: 'asset-1',
      payload: {
        providerProfileId: '08f00b2a-c2ef-43c8-aea7-6ebec183bd17',
        batchId: '19d42fac-a42a-405a-8a82-b67154f259a3',
        prompt: 'remove distractions',
        templateId: null,
        templateVersion: null,
        resultIndex: 1,
        storageMode: 'managed'
      }
    });
    const updated = tasks.updateQueuedGeneration({ taskId: task.id, prompt: '保留人物并清除路人' });
    expect(updated.payload.prompt).toBe('保留人物并清除路人');
    tasks.claimNext(['generation']);
    expect(() => tasks.updateQueuedGeneration({ taskId: task.id, prompt: 'too late' })).toThrow('TASK_ALREADY_STARTED');
    tasks.close();
  });

  it('atomically updates selected queued generation snapshots', async () => {
    const tasks = new TaskService(await databasePath());
    const basePayload = {
      providerProfileId: '08f00b2a-c2ef-43c8-aea7-6ebec183bd17',
      batchId: '19d42fac-a42a-405a-8a82-b67154f259a3', prompt: 'old',
      templateId: null, templateVersion: null, resultIndex: 1, storageMode: 'managed'
    };
    const first = tasks.enqueue({ kind: 'generation', assetId: 'asset-1', payload: basePayload });
    const second = tasks.enqueue({ kind: 'generation', assetId: 'asset-2', payload: { ...basePayload, resultIndex: 2 } });
    const updated = tasks.updateQueuedGenerations({
      taskIds: [first.id, second.id],
      providerProfileId: 'f221f0c9-1452-4291-97ff-8b0fe98c8738',
      prompt: 'new prompt', templateId: null, templateVersion: null
    });
    expect(updated.every((task) => task.payload.providerProfileId === 'f221f0c9-1452-4291-97ff-8b0fe98c8738')).toBe(true);
    expect(updated.every((task) => task.payload.prompt === 'new prompt')).toBe(true);
    tasks.claimNext(['generation']);
    expect(() => tasks.updateQueuedGenerations({ taskIds: [first.id, second.id], prompt: 'late' })).toThrow('TASK_ALREADY_STARTED');
    expect(tasks.list().find((task) => task.id === second.id)?.payload.prompt).toBe('new prompt');
    tasks.close();
  });

  it('grows and shrinks a queued generation batch without reusing result indexes', async () => {
    const tasks = new TaskService(await databasePath());
    const payload = {
      providerProfileId: '08f00b2a-c2ef-43c8-aea7-6ebec183bd17',
      batchId: '19d42fac-a42a-405a-8a82-b67154f259a3', prompt: 'generate',
      templateId: null, templateVersion: null, resultIndex: 1, storageMode: 'managed'
    };
    tasks.enqueue({ kind: 'generation', assetId: 'asset-1', payload });
    const grown = tasks.resizeQueuedGenerationBatch({ batchId: payload.batchId, assetId: 'asset-1', count: 3 });
    expect(grown.filter((task) => task.status === 'queued').map((task) => task.payload.resultIndex).sort()).toEqual([1, 2, 3]);
    const shrunk = tasks.resizeQueuedGenerationBatch({ batchId: payload.batchId, assetId: 'asset-1', count: 1 });
    expect(shrunk.filter((task) => task.status === 'queued')).toHaveLength(1);
    expect(shrunk.filter((task) => task.status === 'canceled')).toHaveLength(2);
    const regrown = tasks.resizeQueuedGenerationBatch({ batchId: payload.batchId, assetId: 'asset-1', count: 2 });
    expect(regrown.filter((task) => task.status === 'queued').map((task) => task.payload.resultIndex).sort()).toEqual([1, 4]);
    tasks.close();
  });
});
