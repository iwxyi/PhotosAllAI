import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it } from 'vitest';

import { TaskService } from './task-service';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('large task history pagination', () => {
  it('walks 10,000 tasks with duplicate sort values without omissions', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'photoallisai-task-performance-'));
    temporaryDirectories.push(directory);
    const databasePath = path.join(directory, 'catalog.sqlite');
    const initial = new TaskService(databasePath);
    initial.close();
    const database = new DatabaseSync(databasePath);
    const insert = database.prepare(`
      INSERT INTO tasks (
        id, kind, asset_id, status, position, progress, attempt,
        payload_json, result_json, error_code, created_at, updated_at
      ) VALUES (?, 'generation', ?, 'completed', ?, 1, 0, '{}', NULL, NULL, ?, ?)
    `);
    database.exec('BEGIN IMMEDIATE');
    for (let index = 0; index < 10_000; index += 1) {
      const id = `00000000-0000-4000-8000-${index.toString().padStart(12, '0')}`;
      const timestamp = Math.floor(index / 10);
      insert.run(id, `asset-${index}`, index % 100, timestamp, timestamp);
    }
    database.exec('COMMIT');
    database.close();

    const service = new TaskService(databasePath);
    const seen = new Set<string>();
    let cursor = null;
    let pages = 0;
    do {
      const page = service.listPage({ limit: 200, cursor });
      expect(page.totalCount).toBe(10_000);
      for (const task of page.items) {
        expect(seen.has(task.id)).toBe(false);
        seen.add(task.id);
      }
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor);

    expect(seen.size).toBe(10_000);
    expect(pages).toBe(50);
    service.close();
  });
});
