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
});

