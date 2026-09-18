import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it } from 'vitest';

import { CatalogService } from './catalog-service';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('large catalog pagination', () => {
  it('walks 10,000 deterministic resources without duplicates or offset scans', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'photoallisai-large-catalog-'));
    temporaryDirectories.push(directory);
    const databasePath = path.join(directory, 'catalog.sqlite');
    const migration = new CatalogService(databasePath);
    migration.close();

    const database = new DatabaseSync(databasePath);
    database.prepare('INSERT INTO folders (id, path, name, imported_at) VALUES (?, ?, ?, ?)')
      .run('folder-large', '/fixture/large', 'Large Catalog', 1);
    const insert = database.prepare(`
      INSERT INTO assets (
        id, folder_id, path, file_name, extension, size_bytes, modified_at, imported_at
      ) VALUES (?, 'folder-large', ?, ?, '.jpg', 1024, ?, 1)
    `);
    database.exec('BEGIN IMMEDIATE');
    for (let index = 0; index < 10_000; index += 1) {
      const id = `asset-${String(index).padStart(5, '0')}`;
      insert.run(id, `/fixture/large/${id}.jpg`, `${id}.jpg`, 1_000_000 - Math.floor(index / 3));
    }
    database.exec('COMMIT');
    database.close();

    const catalog = new CatalogService(databasePath);
    const startedAt = performance.now();
    const ids = new Set<string>();
    let cursor = null;
    let pageCount = 0;
    do {
      const page = catalog.listAssetPage({ folderId: 'folder-large', cursor, limit: 200 });
      expect(page.items.length).toBeLessThanOrEqual(200);
      page.items.forEach((asset) => ids.add(asset.id));
      cursor = page.nextCursor;
      pageCount += 1;
    } while (cursor);
    const durationMs = performance.now() - startedAt;

    expect(ids.size).toBe(10_000);
    expect(pageCount).toBe(50);
    expect(durationMs).toBeLessThan(2_000);
    catalog.close();
  });
});
