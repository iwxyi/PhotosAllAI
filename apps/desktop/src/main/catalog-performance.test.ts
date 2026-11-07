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
  it('rebuilds folder navigation after local and external path changes', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'photoallisai-folder-cache-'));
    temporaryDirectories.push(directory);
    const databasePath = path.join(directory, 'catalog.sqlite');
    const catalog = new CatalogService(databasePath);
    const writer = new DatabaseSync(databasePath);
    writer.prepare('INSERT INTO folders (id, path, name, imported_at) VALUES (?, ?, ?, ?)')
      .run('folder-tree', '/fixture/tree', 'Tree', 1);
    const insert = writer.prepare(`INSERT INTO assets (id, folder_id, path, file_name, extension, size_bytes, modified_at, imported_at)
      VALUES (?, 'folder-tree', ?, ?, '.jpg', 1, 1, 1)`);
    insert.run('one', '/fixture/tree/first/one.jpg', 'one.jpg');
    const initial = catalog.listFolders();
    const first = initial.find((folder) => folder.name === 'first')!;
    expect(first.assetCount).toBe(1);
    expect(catalog.listFolders()).toBe(initial);
    expect(catalog.listAssetPage({ folderId: first.id }).items.map((asset) => asset.id)).toEqual(['one']);

    insert.run('two', '/fixture/tree/second/two.jpg', 'two.jpg');
    const external = catalog.listFolders();
    expect(external).not.toBe(initial);
    expect(external.find((folder) => folder.name === 'second')?.assetCount).toBe(1);
    expect(catalog.listAssetPage({ folderId: external.find((folder) => folder.name === 'second')!.id }).items.map((asset) => asset.id))
      .toEqual(['two']);
    writer.close();

    catalog.updateMetadata({ assetIds: ['one'], rating: 5 });
    const local = catalog.listFolders();
    expect(local).toBe(external);
    expect(local.find((folder) => folder.name === 'first')?.assetCount).toBe(1);
    const offlineWriter = new DatabaseSync(databasePath);
    offlineWriter.prepare('UPDATE assets SET offline_at = 5 WHERE id = ?').run('one');
    const offline = catalog.listFolders();
    expect(offline).not.toBe(local);
    expect(offline.find((folder) => folder.name === 'first')?.offlineCount).toBe(1);
    offlineWriter.close();
    catalog.close();
  });

  it('keeps a 100,000 asset folder tree cached after a rating change', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'photoallisai-folder-rating-'));
    temporaryDirectories.push(directory);
    const databasePath = path.join(directory, 'catalog.sqlite');
    new CatalogService(databasePath).close();
    const writer = new DatabaseSync(databasePath);
    writer.prepare('INSERT INTO folders (id, path, name, imported_at) VALUES (?, ?, ?, ?)')
      .run('rating-root', '/fixture/rating', 'Rating', 1);
    const insert = writer.prepare(`INSERT INTO assets (id, folder_id, path, file_name, extension, size_bytes, modified_at, imported_at)
      VALUES (?, 'rating-root', ?, ?, '.jpg', 1, 1, 1)`);
    writer.exec('BEGIN IMMEDIATE');
    for (let index = 0; index < 100_000; index += 1) {
      const id = `rating-${index}`;
      insert.run(id, `/fixture/rating/${id}.jpg`, `${id}.jpg`);
    }
    writer.exec('COMMIT');
    writer.close();

    const catalog = new CatalogService(databasePath);
    const folders = catalog.listFolders();
    catalog.updateMetadata({ assetIds: ['rating-0'], rating: 5 });
    const startedAt = performance.now();
    expect(catalog.listFolders()).toBe(folders);
    console.info('100k folder cache after rating', { milliseconds: Math.round(performance.now() - startedAt) });
    catalog.close();
  }, 20_000);

  it('yields during large-root offline reconciliation', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'photoallisai-offline-reconcile-'));
    temporaryDirectories.push(directory);
    const databasePath = path.join(directory, 'catalog.sqlite');
    new CatalogService(databasePath).close();
    const writer = new DatabaseSync(databasePath);
    writer.prepare('INSERT INTO folders (id, path, name, imported_at) VALUES (?, ?, ?, ?)')
      .run('missing-root', path.join(directory, 'missing'), 'Missing', 1);
    const insert = writer.prepare(`INSERT INTO assets (id, folder_id, path, file_name, extension, size_bytes, modified_at, imported_at)
      VALUES (?, 'missing-root', ?, ?, '.jpg', 1, 1, 1)`);
    writer.exec('BEGIN IMMEDIATE');
    for (let index = 0; index < 10_000; index += 1) {
      const id = `missing-${index}`;
      insert.run(id, path.join(directory, 'missing', `${id}.jpg`), `${id}.jpg`);
    }
    writer.exec('COMMIT');
    writer.close();

    const catalog = new CatalogService(databasePath);
    let eventLoopTurnObserved = false;
    const sync = catalog.synchronizeFolder('missing-root');
    setImmediate(() => { eventLoopTurnObserved = true; });
    const report = await sync;
    expect(eventLoopTurnObserved).toBe(true);
    expect(report).toEqual({ discovered: 0, offline: 10_000 });
    expect(catalog.listFolders()[0]?.offlineCount).toBe(10_000);
    catalog.close();
  }, 20_000);

  it('invalidates cached totals after local and external catalog writes', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'photoallisai-count-cache-'));
    temporaryDirectories.push(directory);
    const databasePath = path.join(directory, 'catalog.sqlite');
    const catalog = new CatalogService(databasePath);
    const writer = new DatabaseSync(databasePath);
    writer.prepare('INSERT INTO folders (id, path, name, imported_at) VALUES (?, ?, ?, ?)')
      .run('folder-count', '/fixture/count', 'Count', 1);
    const insert = writer.prepare(`INSERT INTO assets (id, folder_id, path, file_name, extension, size_bytes, modified_at, imported_at)
      VALUES (?, 'folder-count', ?, ?, '.jpg', 1, 1, 1)`);
    insert.run('one', '/fixture/count/one.jpg', 'one.jpg');
    expect(catalog.listAssetPage({ folderId: 'folder-count' }).totalCount).toBe(1);
    expect(catalog.listAssetPage({ folderId: 'folder-count' }).totalCount).toBe(1);
    insert.run('two', '/fixture/count/two.jpg', 'two.jpg');
    expect(catalog.listAssetPage({ folderId: 'folder-count' }).totalCount).toBe(2);
    writer.close();
    catalog.updateMetadata({ assetIds: ['one'], rating: 5 });
    expect(catalog.listAssetPage({ folderId: 'folder-count', minimumRating: 5 }).totalCount).toBe(1);
    catalog.updateMetadata({ assetIds: ['two'], rating: 5 });
    expect(catalog.listAssetPage({ folderId: 'folder-count', minimumRating: 5 }).totalCount).toBe(2);
    catalog.close();
  });

  it('migrates existing catalogs to indexed browsing without losing assets', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'photoallisai-browse-migration-'));
    temporaryDirectories.push(directory);
    const databasePath = path.join(directory, 'catalog.sqlite');
    new CatalogService(databasePath).close();
    const database = new DatabaseSync(databasePath);
    database.prepare('INSERT INTO folders (id, path, name, imported_at) VALUES (?, ?, ?, ?)')
      .run('folder-existing', '/fixture/existing', 'Existing', 1);
    database.prepare(`INSERT INTO assets (id, folder_id, path, file_name, extension, size_bytes, modified_at, imported_at)
      VALUES ('existing', 'folder-existing', '/fixture/existing/existing.jpg', 'existing.jpg', '.jpg', 1, 1, 1)`).run();
    for (const row of database.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'assets_browse_%'").all() as { name: string }[]) {
      database.exec(`DROP INDEX ${row.name}`);
    }
    database.exec('PRAGMA user_version = 11');
    database.close();

    const migrated = new CatalogService(databasePath);
    expect(migrated.listAssetPage({ folderId: 'folder-existing', sortBy: 'fileName' }).items.map((asset) => asset.id))
      .toEqual(['existing']);
    migrated.close();
    const verified = new DatabaseSync(databasePath);
    expect(verified.prepare('PRAGMA user_version').get()).toEqual({ user_version: 12 });
    expect((verified.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'index' AND name LIKE 'assets_browse_%'").get() as { count: number }).count).toBe(12);
    verified.close();
  });

  it.skipIf(process.env.CATALOG_MILLION_BENCH !== '1')('benchmarks a 1,000,000 asset root on demand', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'photoallisai-million-catalog-'));
    temporaryDirectories.push(directory);
    const databasePath = path.join(directory, 'catalog.sqlite');
    new CatalogService(databasePath).close();
    const database = new DatabaseSync(databasePath);
    database.prepare('INSERT INTO folders (id, path, name, imported_at) VALUES (?, ?, ?, ?)')
      .run('folder-million', '/fixture/million', 'Million', 1);
    const insert = database.prepare(`
      INSERT INTO assets (id, folder_id, path, file_name, extension, size_bytes, modified_at, imported_at)
      VALUES (?, 'folder-million', ?, ?, '.jpg', 1, ?, 1)
    `);
    database.exec('BEGIN IMMEDIATE');
    for (let index = 0; index < 1_000_000; index += 1) {
      const id = `asset-${String(index).padStart(7, '0')}`;
      insert.run(id, `/fixture/million/${id}.jpg`, `${id}.jpg`, Math.floor(index / 5));
    }
    database.exec('COMMIT');
    database.close();

    const catalog = new CatalogService(databasePath);
    const measurements = (['fileName', 'rating', 'modifiedAt'] as const).map((sortBy) => {
      const startedAt = performance.now();
      const page = catalog.listAssetPage({ folderId: 'folder-million', sortBy, limit: 200 });
      const firstPageMs = Math.round(performance.now() - startedAt);
      const nextStartedAt = performance.now();
      const nextPage = catalog.listAssetPage({ folderId: 'folder-million', sortBy, cursor: page.nextCursor, limit: 200 });
      return { sortBy, firstPageMs, nextPageMs: Math.round(performance.now() - nextStartedAt), count: page.items.length, nextCount: nextPage.items.length, total: page.totalCount };
    });
    const positioned = (['fileName', 'rating', 'modifiedAt'] as const).flatMap((sortBy) => [0, 500_000, 990_000].map((offset) => {
      const startedAt = performance.now();
      const page = catalog.listAssetPage({ folderId: 'folder-million', sortBy, offset, limit: 200 });
      return { sortBy, offset, milliseconds: Math.round(performance.now() - startedAt), count: page.items.length, total: page.totalCount };
    }));
    console.info('1m catalog page baseline', { measurements, positioned });
    expect(measurements.every((measurement) => measurement.count === 200 && measurement.nextCount === 200 && measurement.total === 1_000_000)).toBe(true);
    expect(positioned.every((measurement) => measurement.count === 200 && measurement.total === 1_000_000)).toBe(true);
    catalog.close();
  }, 60_000);

  it('summarizes a 100,000 asset root without retaining per-asset rows', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'photoallisai-large-folder-summary-'));
    temporaryDirectories.push(directory);
    const databasePath = path.join(directory, 'catalog.sqlite');
    new CatalogService(databasePath).close();
    const database = new DatabaseSync(databasePath);
    database.prepare('INSERT INTO folders (id, path, name, imported_at) VALUES (?, ?, ?, ?)')
      .run('folder-summary', '/fixture/summary', 'Summary', 1);
    const insert = database.prepare(`
      INSERT INTO assets (id, folder_id, path, file_name, extension, size_bytes, modified_at, imported_at, offline_at)
      VALUES (?, 'folder-summary', ?, ?, '.jpg', 1, 1, 1, ?)
    `);
    database.exec('BEGIN IMMEDIATE');
    for (let index = 0; index < 100_000; index += 1) {
      const id = `summary-${index}`;
      insert.run(id, `/fixture/summary/${id}.jpg`, `${id}.jpg`, index % 10 === 0 ? 1 : null);
    }
    database.exec('COMMIT');
    database.close();

    const catalog = new CatalogService(databasePath);
    const startedAt = performance.now();
    const folders = catalog.listFolders();
    const durationMs = performance.now() - startedAt;
    const cachedStartedAt = performance.now();
    const cachedFolders = catalog.listFolders();
    const cachedDurationMs = performance.now() - cachedStartedAt;
    const pageTimings = (['fileName', 'rating', 'modifiedAt'] as const).map((sortBy) => {
      const start = performance.now();
      const first = catalog.listAssetPage({ folderId: 'folder-summary', sortBy, limit: 200 });
      return { sortBy, milliseconds: Math.round(performance.now() - start), count: first.items.length };
    });
    const deepPageTimings = (['fileName', 'rating', 'modifiedAt'] as const).map((sortBy) => {
      const start = performance.now();
      const cursor = { id: 'summary-90000', modifiedAt: 1, sortValue: sortBy === 'fileName' ? 'summary-90000.jpg' : 0 };
      const page = catalog.listAssetPage({ folderId: 'folder-summary', sortBy, cursor, limit: 200 });
      return { sortBy, milliseconds: Math.round(performance.now() - start), count: page.items.length };
    });
    const positionTimings = (['fileName', 'rating', 'modifiedAt'] as const).flatMap((sortBy) => [0, 50_000, 99_000].map((offset) => {
      const start = performance.now();
      const page = catalog.listAssetPage({ folderId: 'folder-summary', sortBy, offset, limit: 200 });
      return { sortBy, offset, milliseconds: Math.round(performance.now() - start), count: page.items.length };
    }));
    console.info('100k catalog baseline', { folderSummaryMs: Math.round(durationMs), cachedFolderSummaryMs: Math.round(cachedDurationMs), pageTimings, deepPageTimings, positionTimings });
    expect(positionTimings.every((measurement) => measurement.count === 200)).toBe(true);
    const planDb = new DatabaseSync(databasePath);
    for (const field of ['file_name COLLATE NOCASE', 'rating', 'modified_at'] as const) {
      for (const direction of ['ASC', 'DESC'] as const) {
        for (const folderId of [null, 'folder-summary']) {
          const scope = folderId ? 'AND folder_id = ?' : '';
          const indexField = field.startsWith('file_name') ? 'name' : field === 'rating' ? 'rating' : 'modified';
          const indexName = `assets_browse_${folderId ? '' : 'all_'}${indexField}_${direction.toLowerCase()}_idx`;
          const plan = planDb.prepare(`EXPLAIN QUERY PLAN SELECT id FROM assets INDEXED BY ${indexName} WHERE removed_at IS NULL ${scope} ORDER BY ${field} ${direction}, id ASC LIMIT 201`)
            .all(...(folderId ? [folderId] : [])) as { detail: string }[];
          expect(plan.some((row) => row.detail.includes('USE TEMP B-TREE')), `${field} ${direction} ${folderId ?? 'all'}: ${JSON.stringify(plan)}`).toBe(false);
          expect(plan.some((row) => row.detail.includes('USING INDEX assets_browse_'))).toBe(true);
        }
      }
    }
    planDb.close();
    expect(folders).toEqual([expect.objectContaining({ id: 'folder-summary', assetCount: 100_000, offlineCount: 10_000 })]);
    expect(cachedFolders).toBe(folders);
    expect(durationMs).toBeLessThan(2_000);
    catalog.close();
  });

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
