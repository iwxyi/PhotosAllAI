import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

import {
  enqueueTaskInputSchema,
  generationTaskPayloadSchema,
  persistedTaskSchema,
  resizeQueuedGenerationBatchInputSchema,
  updateQueuedGenerationTaskInputSchema,
  updateQueuedGenerationTasksInputSchema,
  type EnqueueTaskInput,
  type PersistedTask,
  type ResizeQueuedGenerationBatchInput,
  type UpdateQueuedGenerationTaskInput,
  type UpdateQueuedGenerationTasksInput
} from '@photoallisai/contracts';
import { assertTaskTransition, type TaskStatus } from '@photoallisai/domain';

type TaskRow = {
  id: string;
  kind: PersistedTask['kind'];
  asset_id: string | null;
  status: TaskStatus;
  position: number;
  progress: number;
  attempt: number;
  payload_json: string;
  error_code: string | null;
  created_at: number;
  updated_at: number;
};

const INTERRUPTED_STATUSES: TaskStatus[] = [
  'preparing', 'uploading', 'processing', 'downloading', 'saving'
];

export class TaskService {
  readonly #database: DatabaseSync;

  constructor(databasePath: string) {
    this.#database = new DatabaseSync(databasePath);
    this.#database.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    this.#migrate();
    this.#recoverInterrupted();
  }

  close(): void {
    this.#database.close();
  }

  #migrate(): void {
    this.#database.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        asset_id TEXT,
        status TEXT NOT NULL,
        position INTEGER NOT NULL,
        progress REAL NOT NULL DEFAULT 0,
        attempt INTEGER NOT NULL DEFAULT 0,
        payload_json TEXT NOT NULL,
        error_code TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS tasks_queue_idx ON tasks(status, position, created_at);
      CREATE TABLE IF NOT EXISTS task_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        from_status TEXT,
        to_status TEXT NOT NULL,
        occurred_at INTEGER NOT NULL,
        details_json TEXT NOT NULL DEFAULT '{}'
      );
      COMMIT;
    `);
  }

  #recoverInterrupted(): void {
    const now = Date.now();
    const placeholders = INTERRUPTED_STATUSES.map(() => '?').join(', ');
    const interrupted = this.#database
      .prepare(`SELECT id, status FROM tasks WHERE status IN (${placeholders})`)
      .all(...INTERRUPTED_STATUSES) as Pick<TaskRow, 'id' | 'status'>[];

    if (interrupted.length === 0) return;
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      const update = this.#database.prepare(`
        UPDATE tasks SET status = 'queued', progress = 0, attempt = attempt + 1,
          error_code = 'APP_INTERRUPTED', updated_at = ? WHERE id = ?
      `);
      const event = this.#database.prepare(`
        INSERT INTO task_events (task_id, from_status, to_status, occurred_at, details_json)
        VALUES (?, ?, 'queued', ?, '{"reason":"app_interrupted"}')
      `);
      for (const task of interrupted) {
        update.run(now, task.id);
        event.run(task.id, task.status, now);
      }
      this.#database.exec('COMMIT');
    } catch (error) {
      this.#database.exec('ROLLBACK');
      throw error;
    }
  }

  list(): PersistedTask[] {
    return (this.#database.prepare(`
      SELECT * FROM tasks
      ORDER BY CASE status WHEN 'queued' THEN 0 WHEN 'failed' THEN 1 ELSE 2 END,
        position ASC, created_at DESC
    `).all() as TaskRow[]).map((row) => this.#toTask(row));
  }

  enqueue(rawInput: EnqueueTaskInput): PersistedTask {
    const input = enqueueTaskInputSchema.parse(rawInput);
    const now = Date.now();
    const id = randomUUID();
    const maximum = this.#database.prepare(`
      SELECT COALESCE(MAX(position), -1) AS value FROM tasks WHERE status = 'queued'
    `).get() as { value: number };
    const position = maximum.value + 1;
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      this.#database.prepare(`
        INSERT INTO tasks (
          id, kind, asset_id, status, position, progress, attempt,
          payload_json, error_code, created_at, updated_at
        ) VALUES (?, ?, ?, 'queued', ?, 0, 0, ?, NULL, ?, ?)
      `).run(id, input.kind, input.assetId, position, JSON.stringify(input.payload), now, now);
      this.#database.prepare(`
        INSERT INTO task_events (task_id, from_status, to_status, occurred_at)
        VALUES (?, 'draft', 'queued', ?)
      `).run(id, now);
      this.#database.exec('COMMIT');
    } catch (error) {
      this.#database.exec('ROLLBACK');
      throw error;
    }
    return this.#get(id);
  }

  claimNext(kinds: readonly PersistedTask['kind'][]): PersistedTask | null {
    if (kinds.length === 0) return null;
    const placeholders = kinds.map(() => '?').join(', ');
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      const row = this.#database.prepare(`
        SELECT * FROM tasks WHERE status = 'queued' AND kind IN (${placeholders})
        ORDER BY position ASC, created_at ASC LIMIT 1
      `).get(...kinds) as TaskRow | undefined;
      if (!row) {
        this.#database.exec('COMMIT');
        return null;
      }
      const now = Date.now();
      this.#database.prepare(`
        UPDATE tasks SET status = 'preparing', progress = 0, updated_at = ?
        WHERE id = ? AND status = 'queued'
      `).run(now, row.id);
      this.#database.prepare(`
        INSERT INTO task_events (task_id, from_status, to_status, occurred_at)
        VALUES (?, 'queued', 'preparing', ?)
      `).run(row.id, now);
      this.#database.exec('COMMIT');
      return this.#get(row.id);
    } catch (error) {
      this.#database.exec('ROLLBACK');
      throw error;
    }
  }

  advance(taskId: string, status: TaskStatus, progress: number, errorCode: string | null = null): PersistedTask {
    const task = this.#get(taskId);
    assertTaskTransition(task.status, status);
    const now = Date.now();
    const boundedProgress = Math.max(0, Math.min(progress, 1));
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      this.#database.prepare(`
        UPDATE tasks SET status = ?, progress = ?, error_code = ?, updated_at = ? WHERE id = ?
      `).run(status, boundedProgress, errorCode, now, taskId);
      this.#database.prepare(`
        INSERT INTO task_events (task_id, from_status, to_status, occurred_at, details_json)
        VALUES (?, ?, ?, ?, ?)
      `).run(taskId, task.status, status, now, JSON.stringify(errorCode ? { errorCode } : {}));
      this.#database.exec('COMMIT');
    } catch (error) {
      this.#database.exec('ROLLBACK');
      throw error;
    }
    return this.#get(taskId);
  }

  cancel(taskId: string): PersistedTask {
    const task = this.#get(taskId);
    if (task.status === 'canceled') return task;
    if (task.status === 'completed') throw new Error('TASK_ALREADY_COMPLETED');
    return this.#transition(task, 'canceled');
  }

  retry(taskId: string): PersistedTask {
    const task = this.#get(taskId);
    if (task.status !== 'failed' && task.status !== 'canceled') throw new Error('TASK_NOT_RETRYABLE');
    const maximum = this.#database.prepare(`
      SELECT COALESCE(MAX(position), -1) AS value FROM tasks WHERE status = 'queued'
    `).get() as { value: number };
    return this.#transition(task, 'queued', maximum.value + 1);
  }

  reorder(taskIds: readonly string[]): PersistedTask[] {
    const queued = this.list().filter((task) => task.status === 'queued');
    const queuedIds = new Set(queued.map((task) => task.id));
    if (taskIds.length !== queued.length || taskIds.some((id) => !queuedIds.has(id))) {
      throw new Error('TASK_REORDER_SET_MISMATCH');
    }
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      const update = this.#database.prepare('UPDATE tasks SET position = ?, updated_at = ? WHERE id = ?');
      const now = Date.now();
      taskIds.forEach((id, position) => update.run(position, now, id));
      this.#database.exec('COMMIT');
    } catch (error) {
      this.#database.exec('ROLLBACK');
      throw error;
    }
    return this.list();
  }

  updateQueuedGeneration(rawInput: UpdateQueuedGenerationTaskInput): PersistedTask {
    const input = updateQueuedGenerationTaskInputSchema.parse(rawInput);
    const task = this.#get(input.taskId);
    if (task.kind !== 'generation') throw new Error('TASK_KIND_NOT_EDITABLE');
    if (task.status !== 'queued') throw new Error('TASK_ALREADY_STARTED');
    const payload = generationTaskPayloadSchema.parse({ ...task.payload, prompt: input.prompt });
    const now = Date.now();
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      const result = this.#database.prepare(`
        UPDATE tasks SET payload_json = ?, updated_at = ? WHERE id = ? AND status = 'queued'
      `).run(JSON.stringify(payload), now, task.id);
      if (result.changes !== 1) throw new Error('TASK_ALREADY_STARTED');
      this.#database.prepare(`
        INSERT INTO task_events (task_id, from_status, to_status, occurred_at, details_json)
        VALUES (?, 'queued', 'queued', ?, '{"reason":"payload_updated"}')
      `).run(task.id, now);
      this.#database.exec('COMMIT');
    } catch (error) {
      this.#database.exec('ROLLBACK');
      throw error;
    }
    return this.#get(task.id);
  }

  updateQueuedGenerations(rawInput: UpdateQueuedGenerationTasksInput): PersistedTask[] {
    const input = updateQueuedGenerationTasksInputSchema.parse(rawInput);
    const ids = [...new Set(input.taskIds)];
    if (ids.length !== input.taskIds.length) throw new Error('DUPLICATE_TASK_ID');
    const tasks = ids.map((id) => this.#get(id));
    const payloads = tasks.map((task) => {
      if (task.kind !== 'generation') throw new Error('TASK_KIND_NOT_EDITABLE');
      if (task.status !== 'queued') throw new Error('TASK_ALREADY_STARTED');
      return generationTaskPayloadSchema.parse({
        ...task.payload,
        ...(input.providerProfileId === undefined ? {} : { providerProfileId: input.providerProfileId }),
        ...(input.prompt === undefined ? {} : { prompt: input.prompt }),
        ...(input.templateId === undefined ? {} : { templateId: input.templateId, templateVersion: input.templateVersion })
      });
    });
    const resizeGroup = input.resize
      ? this.list().filter((task) => task.kind === 'generation' && task.assetId === input.resize!.assetId && task.payload.batchId === input.resize!.batchId)
      : [];
    if (input.resize && resizeGroup.length === 0) throw new Error('GENERATION_BATCH_NOT_FOUND');
    const immutable = resizeGroup.filter((task) => task.status !== 'queued' && task.status !== 'canceled');
    if (input.resize && input.resize.count < immutable.length) throw new Error('GENERATION_COUNT_BELOW_STARTED');
    const resizeQueued = resizeGroup.filter((task) => task.status === 'queued').sort((left, right) => Number(left.payload.resultIndex) - Number(right.payload.resultIndex));
    if (input.resize && resizeQueued.some((task) => !ids.includes(task.id))) throw new Error('GENERATION_BATCH_UPDATE_SET_MISMATCH');
    const now = Date.now();
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      const update = this.#database.prepare(`UPDATE tasks SET payload_json = ?, updated_at = ? WHERE id = ? AND status = 'queued'`);
      const event = this.#database.prepare(`
        INSERT INTO task_events (task_id, from_status, to_status, occurred_at, details_json)
        VALUES (?, 'queued', 'queued', ?, ?)
      `);
      ids.forEach((id, index) => {
        if (update.run(JSON.stringify(payloads[index]), now, id).changes !== 1) throw new Error('TASK_ALREADY_STARTED');
        event.run(id, now, JSON.stringify({
          reason: 'payload_updated',
          fields: [input.providerProfileId === undefined ? null : 'provider', input.prompt === undefined ? null : 'prompt', input.templateId === undefined ? null : 'template'].filter(Boolean)
        }));
      });
      if (input.resize) {
        const activeCount = immutable.length + resizeQueued.length;
        if (input.resize.count < activeCount) {
          const cancel = this.#database.prepare(`UPDATE tasks SET status = 'canceled', updated_at = ? WHERE id = ? AND status = 'queued'`);
          const cancelEvent = this.#database.prepare(`INSERT INTO task_events (task_id, from_status, to_status, occurred_at, details_json) VALUES (?, 'queued', 'canceled', ?, '{"reason":"batch_resized"}')`);
          for (const task of resizeQueued.slice(input.resize.count - immutable.length).reverse()) {
            if (cancel.run(now, task.id).changes !== 1) throw new Error('TASK_ALREADY_STARTED');
            cancelEvent.run(task.id, now);
          }
        } else if (input.resize.count > activeCount) {
          const sourceIndex = resizeQueued.length > 0 ? ids.indexOf(resizeQueued.at(-1)!.id) : -1;
          const sourcePayload = sourceIndex >= 0 ? payloads[sourceIndex]! : generationTaskPayloadSchema.parse(immutable.at(-1)?.payload);
          let resultIndex = Math.max(...resizeGroup.map((task) => Number(task.payload.resultIndex) || 0));
          const maximum = this.#database.prepare(`SELECT COALESCE(MAX(position), -1) AS value FROM tasks WHERE status = 'queued'`).get() as { value: number };
          const insert = this.#database.prepare(`INSERT INTO tasks (id, kind, asset_id, status, position, progress, attempt, payload_json, error_code, created_at, updated_at) VALUES (?, 'generation', ?, 'queued', ?, 0, 0, ?, NULL, ?, ?)`);
          const enqueueEvent = this.#database.prepare(`INSERT INTO task_events (task_id, from_status, to_status, occurred_at, details_json) VALUES (?, 'draft', 'queued', ?, '{"reason":"batch_resized"}')`);
          for (let offset = 1; offset <= input.resize.count - activeCount; offset += 1) {
            const id = randomUUID();
            resultIndex += 1;
            insert.run(id, input.resize.assetId, maximum.value + offset, JSON.stringify({ ...sourcePayload, resultIndex }), now, now);
            enqueueEvent.run(id, now);
          }
        }
      }
      this.#database.exec('COMMIT');
    } catch (error) {
      this.#database.exec('ROLLBACK');
      throw error;
    }
    return input.resize
      ? this.list().filter((task) => task.kind === 'generation' && task.assetId === input.resize!.assetId && task.payload.batchId === input.resize!.batchId)
      : ids.map((id) => this.#get(id));
  }

  resizeQueuedGenerationBatch(rawInput: ResizeQueuedGenerationBatchInput): PersistedTask[] {
    const input = resizeQueuedGenerationBatchInputSchema.parse(rawInput);
    const group = this.list().filter((task) => task.kind === 'generation' && task.assetId === input.assetId && task.payload.batchId === input.batchId);
    if (group.length === 0) throw new Error('GENERATION_BATCH_NOT_FOUND');
    const immutable = group.filter((task) => task.status !== 'queued' && task.status !== 'canceled');
    if (input.count < immutable.length) throw new Error('GENERATION_COUNT_BELOW_STARTED');
    const queued = group.filter((task) => task.status === 'queued').sort((left, right) => Number(left.payload.resultIndex) - Number(right.payload.resultIndex));
    const activeCount = immutable.length + queued.length;
    if (activeCount === input.count) return group;
    const now = Date.now();
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      if (input.count < activeCount) {
        const cancel = this.#database.prepare(`UPDATE tasks SET status = 'canceled', updated_at = ? WHERE id = ? AND status = 'queued'`);
        const event = this.#database.prepare(`INSERT INTO task_events (task_id, from_status, to_status, occurred_at, details_json) VALUES (?, 'queued', 'canceled', ?, '{"reason":"batch_resized"}')`);
        for (const task of queued.slice(input.count - immutable.length).reverse()) {
          if (cancel.run(now, task.id).changes !== 1) throw new Error('TASK_ALREADY_STARTED');
          event.run(task.id, now);
        }
      } else {
        const source = queued.at(-1) ?? immutable.at(-1);
        if (!source) throw new Error('GENERATION_BATCH_NOT_FOUND');
        const payload = generationTaskPayloadSchema.parse(source.payload);
        let resultIndex = Math.max(...group.map((task) => Number(task.payload.resultIndex) || 0));
        const maximum = this.#database.prepare(`SELECT COALESCE(MAX(position), -1) AS value FROM tasks WHERE status = 'queued'`).get() as { value: number };
        const insert = this.#database.prepare(`INSERT INTO tasks (id, kind, asset_id, status, position, progress, attempt, payload_json, error_code, created_at, updated_at) VALUES (?, 'generation', ?, 'queued', ?, 0, 0, ?, NULL, ?, ?)`);
        const event = this.#database.prepare(`INSERT INTO task_events (task_id, from_status, to_status, occurred_at, details_json) VALUES (?, 'draft', 'queued', ?, '{"reason":"batch_resized"}')`);
        for (let offset = 1; offset <= input.count - activeCount; offset += 1) {
          const id = randomUUID();
          resultIndex += 1;
          insert.run(id, input.assetId, maximum.value + offset, JSON.stringify({ ...payload, resultIndex }), now, now);
          event.run(id, now);
        }
      }
      this.#database.exec('COMMIT');
    } catch (error) {
      this.#database.exec('ROLLBACK');
      throw error;
    }
    return this.list().filter((task) => task.kind === 'generation' && task.assetId === input.assetId && task.payload.batchId === input.batchId);
  }

  #transition(task: PersistedTask, status: TaskStatus, position = task.position): PersistedTask {
    assertTaskTransition(task.status, status);
    const now = Date.now();
    const incrementAttempt = status === 'queued' && (task.status === 'failed' || task.status === 'canceled') ? 1 : 0;
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      this.#database.prepare(`
        UPDATE tasks SET status = ?, position = ?, progress = 0,
          attempt = attempt + ?, error_code = NULL, updated_at = ? WHERE id = ?
      `).run(status, position, incrementAttempt, now, task.id);
      this.#database.prepare(`
        INSERT INTO task_events (task_id, from_status, to_status, occurred_at)
        VALUES (?, ?, ?, ?)
      `).run(task.id, task.status, status, now);
      this.#database.exec('COMMIT');
    } catch (error) {
      this.#database.exec('ROLLBACK');
      throw error;
    }
    return this.#get(task.id);
  }

  #get(taskId: string): PersistedTask {
    const row = this.#database.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as TaskRow | undefined;
    if (!row) throw new Error('TASK_NOT_FOUND');
    return this.#toTask(row);
  }

  #toTask(row: TaskRow): PersistedTask {
    return persistedTaskSchema.parse({
      id: row.id,
      kind: row.kind,
      assetId: row.asset_id,
      status: row.status,
      position: row.position,
      progress: row.progress,
      attempt: row.attempt,
      payload: JSON.parse(row.payload_json) as unknown,
      errorCode: row.error_code,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    });
  }
}
