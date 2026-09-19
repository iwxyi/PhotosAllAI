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
  it('adds persisted task results to an existing task database', async () => {
    const file = await databasePath();
    const legacy = new DatabaseSync(file);
    legacy.exec(`
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL, asset_id TEXT, status TEXT NOT NULL,
        position INTEGER NOT NULL, progress REAL NOT NULL DEFAULT 0,
        attempt INTEGER NOT NULL DEFAULT 0, payload_json TEXT NOT NULL, error_code TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
    `);
    legacy.close();

    const tasks = new TaskService(file);
    const inspection = new DatabaseSync(file);
    const columns = inspection.prepare('PRAGMA table_info(tasks)').all() as { name: string }[];
    expect(columns.map((column) => column.name)).toContain('result_json');
    inspection.close();
    expect(tasks.enqueue({ kind: 'analysis', assetId: 'asset-1', payload: {} }).result).toBeNull();
    tasks.close();
  });

  it('queues tasks deterministically', async () => {
    const tasks = new TaskService(await databasePath());
    const first = tasks.enqueue({ kind: 'analysis', assetId: 'asset-1', payload: { depth: 'full' } });
    const second = tasks.enqueue({ kind: 'generation', assetId: 'asset-2', payload: { count: 1 } });
    expect(tasks.list().map((task) => task.id)).toEqual([first.id, second.id]);
    tasks.close();
  });

  it('paginates growing task history with stable cursors and global counts', async () => {
    const file = await databasePath();
    const tasks = new TaskService(file);
    const created = Array.from({ length: 7 }, (_, index) =>
      tasks.enqueue({ kind: 'analysis', assetId: `asset-${index}`, payload: {} }));
    const failed = tasks.claimNext(['analysis'])!;
    tasks.advance(failed.id, 'processing', 0.2);
    tasks.advance(failed.id, 'failed', 0.2, 'ANALYSIS_FAILED');
    const active = tasks.claimNext(['analysis'])!;
    tasks.advance(active.id, 'processing', 0.4);
    tasks.cancel(created.at(-1)!.id);

    const seen: string[] = [];
    let cursor = null;
    do {
      const page = tasks.listPage({ limit: 2, cursor });
      seen.push(...page.items.map((task) => task.id));
      expect(page).toMatchObject({
        totalCount: 7,
        queuedCount: 4,
        activeCount: 1,
        failedCount: 1,
        failedGenerationCount: 0
      });
      cursor = page.nextCursor;
    } while (cursor);

    expect(seen).toHaveLength(7);
    expect(new Set(seen).size).toBe(7);
    expect(seen[0]).toBe(active.id);
    expect(seen.at(-2)).toBe(failed.id);
    expect(seen.at(-1)).toBe(created.at(-1)!.id);
    tasks.close();
    const database = new DatabaseSync(file);
    expect(database.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'tasks_history_idx'
    `).get()).toEqual({ name: 'tasks_history_idx' });
    database.close();
  });

  it('moves one queued task without requiring the complete queue from the renderer', async () => {
    const tasks = new TaskService(await databasePath());
    const first = tasks.enqueue({ kind: 'analysis', assetId: 'asset-1', payload: {} });
    const second = tasks.enqueue({ kind: 'analysis', assetId: 'asset-2', payload: {} });
    const third = tasks.enqueue({ kind: 'analysis', assetId: 'asset-3', payload: {} });

    tasks.moveQueued({ taskId: third.id, direction: -1 });
    expect(tasks.list().filter((task) => task.status === 'queued').map((task) => task.id))
      .toEqual([first.id, third.id, second.id]);
    expect(tasks.moveQueued({ taskId: first.id, direction: -1 }).id).toBe(first.id);
    expect(tasks.list().filter((task) => task.status === 'queued').map((task) => task.id))
      .toEqual([first.id, third.id, second.id]);
    tasks.close();
  });

  it('retries failed generation tasks in bounded audited batches', async () => {
    const file = await databasePath();
    const tasks = new TaskService(file);
    for (let index = 0; index < 3; index += 1) {
      tasks.enqueue({ kind: 'generation', assetId: `asset-${index}`, payload: {} });
      const task = tasks.claimNext(['generation'])!;
      tasks.advance(task.id, 'processing', 0.5);
      tasks.advance(task.id, 'failed', 0.5, 'GENERATION_FAILED');
    }
    tasks.enqueue({ kind: 'analysis', assetId: 'analysis-asset', payload: {} });
    const analysis = tasks.claimNext(['analysis'])!;
    tasks.advance(analysis.id, 'processing', 0.5);
    tasks.advance(analysis.id, 'failed', 0.5, 'ANALYSIS_FAILED');

    expect(tasks.retryFailedGenerations({ limit: 2 })).toEqual({ retried: 2, remaining: 1 });
    expect(tasks.retryFailedGenerations({ limit: 2 })).toEqual({ retried: 1, remaining: 0 });
    expect(tasks.list().filter((task) => task.kind === 'generation').every((task) =>
      task.status === 'queued' && task.attempt === 1 && task.errorCode === null)).toBe(true);
    expect(tasks.find(analysis.id)?.status).toBe('failed');
    expect(tasks.hasActiveTasks()).toBe(true);
    expect(tasks.hasQueued(['generation'])).toBe(true);
    tasks.close();

    const database = new DatabaseSync(file);
    const events = database.prepare(`
      SELECT COUNT(*) AS value FROM task_events WHERE details_json = '{"reason":"batch_retry"}'
    `).get() as { value: number };
    expect(events.value).toBe(3);
    database.close();
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

  it('pauses queued and active tasks and resumes them at the queue tail', async () => {
    const tasks = new TaskService(await databasePath());
    const queued = tasks.enqueue({ kind: 'analysis', assetId: 'asset-queued', payload: {} });
    const active = tasks.enqueue({ kind: 'analysis', assetId: 'asset-active', payload: {} });
    tasks.claimNext(['analysis']);
    tasks.advance(queued.id, 'processing', 0.4);

    expect(tasks.pause(queued.id)).toMatchObject({ status: 'paused', progress: 0.4 });
    expect(tasks.pause(active.id)).toMatchObject({ status: 'paused', progress: 0 });
    expect(tasks.listPage({ limit: 10, cursor: null })).toMatchObject({
      queuedCount: 0, pausedCount: 2, activeCount: 0
    });

    const saving = tasks.enqueue({ kind: 'analysis', assetId: 'asset-saving', payload: {} });
    tasks.claimNext(['analysis']);
    tasks.advance(saving.id, 'processing', 0.5);
    tasks.advance(saving.id, 'downloading', 0.85);
    tasks.advance(saving.id, 'saving', 0.95);
    expect(() => tasks.pause(saving.id)).toThrow('TASK_NOT_PAUSABLE');

    const resumedActive = tasks.resume(active.id);
    const resumedQueued = tasks.resume(queued.id);
    expect(resumedActive).toMatchObject({ status: 'queued', progress: 0, attempt: 0 });
    expect(resumedQueued).toMatchObject({ status: 'queued', progress: 0, attempt: 1 });
    expect(tasks.list().filter((task) => task.status === 'queued').map((task) => task.id))
      .toEqual([active.id, queued.id]);
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
