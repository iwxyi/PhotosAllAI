import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

import {
  enqueueTaskInputSchema,
  persistedTaskSchema,
  type EnqueueTaskInput,
  type PersistedTask
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
