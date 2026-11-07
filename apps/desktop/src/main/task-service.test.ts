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
  it('deletes selected history and events, and keeps completed tasks when removing unfinished work', async () => {
    const file = await databasePath();
    const tasks = new TaskService(file);
    try {
      const input = { kind: 'analysis' as const, assetId: 'photo-1', payload: { providerProfileId: 'model-1', mode: 'full' } };
      const completed = tasks.enqueue(input);
      tasks.claimNext(['analysis']);
      tasks.advance(completed.id, 'processing', 0.1);
      tasks.advance(completed.id, 'downloading', 0.8);
      tasks.advance(completed.id, 'saving', 0.9);
      tasks.finish(completed.id, 'completed', { saved: true });
      const queued = tasks.enqueue({ ...input, assetId: 'queued' });
      const paused = tasks.enqueue({ ...input, assetId: 'paused' });
      tasks.pause(paused.id);
      const failed = tasks.enqueue({ ...input, assetId: 'failed' });
      tasks.advance(failed.id, 'preparing', 0.01);
      tasks.advance(failed.id, 'failed', 0, 'PROVIDER_HTTP_400');
      const canceled = tasks.enqueue({ ...input, assetId: 'canceled' });
      tasks.cancel(canceled.id);
      const targets = tasks.deletionTargets({ scope: 'unfinished' });
      expect(new Set(targets.map((task) => task.id))).toEqual(new Set([queued.id, paused.id, failed.id, canceled.id]));
      expect(tasks.deleteTasks(targets.map((task) => task.id))).toHaveLength(4);
      expect(tasks.list().map((task) => task.id)).toEqual([completed.id]);
      const database = new DatabaseSync(file);
      expect(database.prepare('SELECT COUNT(*) AS count FROM task_events WHERE task_id = ?').get(paused.id)).toEqual({ count: 0 });
      database.close();
      expect(tasks.deleteTasks([completed.id, completed.id, 'missing'])).toEqual([completed.id]);
      expect(tasks.listPage({}).totalCount).toBe(0);
    } finally { tasks.close(); }
  });

  it('deletes below the anchor in displayed batch order including unloaded tasks', async () => {
    const tasks = new TaskService(await databasePath());
    try {
      const enqueue = (assetId: string, batchId: string) => tasks.enqueue({ kind: 'analysis', assetId, payload: { providerProfileId: 'model-1', mode: 'full', batchId } });
      const a = enqueue('a', 'first');
      const b = enqueue('b', 'second');
      const c = enqueue('c', 'first');
      const d = enqueue('d', 'third');
      expect(tasks.deletionTargets({ scope: 'below', taskId: a.id, orderedTaskIds: [a.id, c.id, b.id] }).map((task) => task.id)).toEqual([c.id]);
      expect(tasks.deletionTargets({ scope: 'below-batches', taskId: a.id, orderedTaskIds: [a.id, c.id, b.id] }).map((task) => task.id)).toEqual([b.id, d.id]);
      expect(tasks.deletionTargets({ scope: 'batch', taskId: a.id }).map((task) => task.id)).toEqual([a.id, c.id]);
      expect(tasks.deletionTargets({ scope: 'below', taskId: d.id }).map((task) => task.id)).toEqual([]);
      expect(tasks.deletionTargets({ scope: 'task', taskId: b.id }).map((task) => task.id)).toEqual([b.id]);
      expect(() => tasks.deletionTargets({ scope: 'below', taskId: '00000000-0000-4000-8000-000000000000' })).toThrow('TASK_NOT_FOUND');
      expect(tasks.deletionTargets({ scope: 'all' })).toHaveLength(4);
    } finally { tasks.close(); }
  });

  it('keeps separate submissions and returns every batch member across page boundaries', async () => {
    const file = await databasePath();
    let tasks = new TaskService(file);
    const input = { kind: 'analysis' as const, assetId: 'photo-1', payload: { providerProfileId: 'model-1', mode: 'full', batchId: 'batch-a', locale: 'zh-CN' } };
    const first = tasks.enqueue(input);
    expect(tasks.enqueue(input).id).toBe(first.id);
    tasks.enqueue({ ...input, assetId: 'photo-2' });
    tasks.enqueue({ ...input, payload: { ...input.payload, batchId: 'batch-b' } });
    tasks.claimNext(['analysis']);
    tasks.advance(first.id, 'processing', 0.1);
    tasks.advance(first.id, 'downloading', 0.8);
    tasks.advance(first.id, 'saving', 0.9);
    tasks.finish(first.id, 'completed', { analysisRevisionId: 'revision-1' });
    tasks.close();
    tasks = new TaskService(file);
    try {
      const page = tasks.listPage({ limit: 1, includeBatchMembers: true });
      expect(page.totalCount).toBe(3);
      expect(page.items).toHaveLength(3);
      expect(tasks.listBatch('analysis', 'batch-a')).toHaveLength(2);
      expect(tasks.listBatch('analysis', 'batch-b')).toHaveLength(1);
      expect(page.items.find((task) => task.id === first.id)?.status).toBe('completed');
      expect(page.nextCursor).not.toBeNull();
    } finally { tasks.close(); }
  });
  it('isolates types and submissions while preserving generation groups when resized', async () => {
    const tasks = new TaskService(await databasePath());
    try {
      const submissionId = 'e221f0c9-1452-4291-97ff-8b0fe98c8738';
      const base = { providerProfileId: '08f00b2a-c2ef-43c8-aea7-6ebec183bd17', submissionId,
        batchId: '19d42fac-a42a-405a-8a82-b67154f259a3', prompt: 'generate', resultIndex: 1 };
      const generation = tasks.enqueue({ kind: 'generation', assetId: 'photo-1', payload: base });
      const analysis = tasks.enqueue({ kind: 'analysis', assetId: 'photo-1', payload: { submissionId } });
      expect(tasks.enqueue({ kind: 'analysis', assetId: 'photo-1', payload: { submissionId: 'another-submission' } }).id).not.toBe(analysis.id);
      expect(tasks.listBatch('generation', submissionId).map((task) => task.id)).toEqual([generation.id]);
      const resized = tasks.resizeQueuedGenerationBatch({ batchId: base.batchId, assetId: 'photo-1', count: 3 });
      expect(resized.every((task) => task.payload.submissionId === submissionId)).toBe(true);
      expect(tasks.listBatch('generation', submissionId)).toHaveLength(3);
      expect(tasks.listBatch('analysis', submissionId)).toHaveLength(1);
      for (const kind of ['agent', 'export', 'collection-analysis'] as const) {
        const task = tasks.enqueue({ kind, assetId: null, payload: {} });
        expect(task.payload.submissionId).toEqual(expect.any(String));
        expect(tasks.listBatch(kind, String(task.payload.submissionId))).toHaveLength(1);
      }
    } finally { tasks.close(); }
  });

  it('persists measured progress without adding invalid state transitions or overwriting canceled tasks', async () => {
    const tasks = new TaskService(await databasePath());
    try {
      const task = tasks.enqueue({ kind: 'export', assetId: null, payload: {} });
      tasks.claimNext(['export']);
      tasks.advance(task.id, 'processing', 0.1);
      tasks.reportProgress(task.id, 0.5, { succeeded: 1, failed: 0, total: 2 });
      expect(tasks.find(task.id)).toMatchObject({ status: 'processing', progress: 0.5, result: { succeeded: 1, total: 2 } });
      tasks.cancel(task.id);
      tasks.reportProgress(task.id, 0.8, { succeeded: 2 });
      expect(tasks.find(task.id)).toMatchObject({ status: 'canceled', result: { succeeded: 1, total: 2 } });
    } finally { tasks.close(); }
  });

  it('reuses analysis work in flight but allows other photos, models, and later reruns', async () => {
    const tasks = new TaskService(await databasePath());
    try {
      const input = { kind: 'analysis' as const, assetId: 'photo-1', payload: { providerProfileId: 'model-1', mode: 'full' } };
      const first = tasks.enqueue(input);
      expect(tasks.enqueue(input).id).toBe(first.id);
      tasks.claimNext(['analysis']);
      expect(tasks.enqueue(input).id).toBe(first.id);
      expect(tasks.enqueue({ ...input, assetId: 'photo-2' }).id).not.toBe(first.id);
      expect(tasks.enqueue({ ...input, payload: { ...input.payload, providerProfileId: 'model-2' } }).id).not.toBe(first.id);
      tasks.cancel(first.id);
      expect(tasks.enqueue(input).id).not.toBe(first.id);
      const generation = { ...input, kind: 'generation' as const };
      expect(tasks.enqueue(generation).id).not.toBe(tasks.enqueue(generation).id);
    } finally { tasks.close(); }
  });

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

  it('keeps completed generation submissions in creation order after queue positions are reused', async () => {
    const file = await databasePath();
    const tasks = new TaskService(file);
    try {
      const enqueue = (batchId: string) => tasks.enqueue({ kind: 'generation', assetId: 'same-photo', payload: { batchId, prompt: batchId } });
      const old = enqueue('old-batch');
      tasks.claimNext(['generation']);
      tasks.advance(old.id, 'processing', 0.5);
      tasks.advance(old.id, 'downloading', 0.8);
      tasks.advance(old.id, 'saving', 0.9);
      tasks.finish(old.id, 'completed', { saved: true });
      const middle = enqueue('middle-batch');
      tasks.claimNext(['generation']);
      tasks.advance(middle.id, 'processing', 0.5);
      tasks.advance(middle.id, 'downloading', 0.8);
      tasks.advance(middle.id, 'saving', 0.9);
      tasks.finish(middle.id, 'completed', { saved: true });
      const latest = enqueue('latest-batch');
      tasks.claimNext(['generation']);
      tasks.advance(latest.id, 'processing', 0.5);
      tasks.advance(latest.id, 'downloading', 0.8);
      tasks.advance(latest.id, 'saving', 0.9);
      tasks.finish(latest.id, 'completed', { saved: true });
      const database = new DatabaseSync(file);
      const setCreatedAt = database.prepare('UPDATE tasks SET created_at = ? WHERE id = ?');
      setCreatedAt.run(1000, old.id);
      setCreatedAt.run(2000, middle.id);
      setCreatedAt.run(3000, latest.id);
      database.close();
      expect([old, middle, latest].map((task) => task.position)).toEqual([0, 0, 0]);
      expect(tasks.listPage({ limit: 10 }).items.map((task) => task.id)).toEqual([latest.id, middle.id, old.id]);
      const firstPage = tasks.listPage({ limit: 1 });
      expect(firstPage.items[0]?.id).toBe(latest.id);
      expect(tasks.listPage({ limit: 1, cursor: firstPage.nextCursor }).items[0]?.id).toBe(middle.id);
    } finally { tasks.close(); }
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
    expect(seen).toEqual([...created].sort((left, right) => right.createdAt - left.createdAt || right.id.localeCompare(left.id)).map((task) => task.id));
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
    expect(retried.payload).toEqual(task.payload);
    expect(retried.payload.submissionId).toEqual(expect.any(String));
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
