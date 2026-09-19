import { mkdtemp, mkdir, readFile, realpath, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it } from 'vitest';

import { CatalogService, isSupportedImage } from './catalog-service';

const temporaryDirectories: string[] = [];

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'photoallisai-catalog-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('catalog image discovery', () => {
  it('recognizes supported extensions case-insensitively', () => {
    expect(isSupportedImage('portrait.JPG')).toBe(true);
    expect(isSupportedImage('camera.CR3')).toBe(true);
    expect(isSupportedImage('notes.txt')).toBe(false);
  });

  it('persists supported files and ignores managed output directories', async () => {
    const root = await createTemporaryDirectory();
    const photosDirectory = path.join(root, 'photos');
    const ignoredDirectory = path.join(photosDirectory, '_PhotoAllIsAI');
    await mkdir(ignoredDirectory, { recursive: true });
    await writeFile(path.join(photosDirectory, 'visible.jpg'), 'jpeg-fixture');
    await writeFile(path.join(photosDirectory, 'raw.NEF'), 'raw-fixture');
    await writeFile(path.join(photosDirectory, 'notes.txt'), 'not-an-image');
    await writeFile(path.join(ignoredDirectory, 'generated.jpg'), 'managed-result');

    const databasePath = path.join(root, 'catalog.sqlite');
    const catalog = new CatalogService(databasePath);
    const imported = await catalog.importFolders([photosDirectory]);
    const assets = catalog.listAssets();

    expect(imported).toBe(2);
    expect(assets.map((asset) => asset.fileName).sort()).toEqual(['raw.NEF', 'visible.jpg']);
    expect(catalog.listFolders()).toEqual([{ id: assets[0]?.folderId, name: 'photos', assetCount: 2, offlineCount: 0 }]);
    const updated = catalog.updateMetadata({ assetIds: assets.map((asset) => asset.id), rating: 4 });
    expect(updated.every((asset) => asset.rating === 4)).toBe(true);
    const firstPage = catalog.listAssetPage({ folderId: null, cursor: null, limit: 1 });
    const secondPage = catalog.listAssetPage({ folderId: null, cursor: firstPage.nextCursor, limit: 1 });
    expect(firstPage.totalCount).toBe(2);
    expect(firstPage.nextCursor).not.toBeNull();
    expect(secondPage.items).toHaveLength(1);
    expect(secondPage.items[0]?.id).not.toBe(firstPage.items[0]?.id);
    expect(secondPage.nextCursor).toBeNull();
    const namePage = catalog.listAssetPage({ folderId: null, sortBy: 'fileName', cursor: null, limit: 1 });
    expect(namePage.items[0]?.fileName).toBe('raw.NEF');
    const nameSecondPage = catalog.listAssetPage({ folderId: null, sortBy: 'fileName', cursor: namePage.nextCursor, limit: 1 });
    expect(nameSecondPage.items[0]?.fileName).toBe('visible.jpg');
    catalog.updateMetadata({ assetIds: [assets[0]!.id], rating: 1 });
    catalog.updateMetadata({ assetIds: [assets[1]!.id], rating: 5 });
    const ratingPage = catalog.listAssetPage({ folderId: null, sortBy: 'rating', cursor: null, limit: 1 });
    expect(ratingPage.items[0]?.rating).toBe(5);
    const ratingSecondPage = catalog.listAssetPage({ folderId: null, sortBy: 'rating', cursor: ratingPage.nextCursor, limit: 1 });
    expect(ratingSecondPage.items[0]?.rating).toBe(1);
    const database = new DatabaseSync(databasePath);
    const searchableId = assets.find((asset) => asset.fileName === 'visible.jpg')!.id;
    database.prepare('INSERT INTO asset_search (asset_id, normalized_content) VALUES (?, ?)')
      .run(searchableId, '城市 夜景 人像');
    const insertToken = database.prepare('INSERT INTO asset_search_tokens (asset_id, token) VALUES (?, ?)');
    for (const token of ['夜', '景', '夜景']) insertToken.run(searchableId, token);
    database.close();
    expect(catalog.listAssetPage({ folderId: null, query: '夜景', cursor: null, limit: 20 }).items)
      .toHaveLength(1);
    expect(catalog.listAssetPage({ folderId: null, query: 'visible', cursor: null, limit: 20 }).items[0]?.fileName)
      .toBe('visible.jpg');
    expect(catalog.listAssetPage({ folderId: null, query: 'missing', cursor: null, limit: 20 }).totalCount)
      .toBe(0);
    const tags = catalog.updateTags({
      assetIds: assets.map((asset) => asset.id),
      addTags: ['人像', ' 人像 ', '夜景'],
      removeTagIds: []
    });
    expect(tags).toHaveLength(2);
    expect(tags.every((tag) => tag.assetCount === 2)).toBe(true);
    const portraitTag = tags.find((tag) => tag.name === '人像')!;
    const taggedPage = catalog.listAssetPage({ tagId: portraitTag.id, cursor: null, limit: 20 });
    expect(taggedPage.totalCount).toBe(2);
    expect(taggedPage.items.every((asset) => asset.tags.some((tag) => tag.id === portraitTag.id))).toBe(true);
    const remaining = catalog.updateTags({
      assetIds: [assets[0]!.id],
      addTags: [],
      removeTagIds: [portraitTag.id]
    });
    expect(remaining.find((tag) => tag.id === portraitTag.id)?.assetCount).toBe(1);
    catalog.deleteTag(portraitTag.id);
    expect(catalog.listTags().some((tag) => tag.id === portraitTag.id)).toBe(false);
    expect(assets.find((asset) => asset.fileName === 'visible.jpg')?.thumbnailUrl).toMatch(/^photoasset:\/\/thumbnail/);
    expect(assets.find((asset) => asset.fileName === 'raw.NEF')?.previewUrl).toMatch(/^photoasset:\/\/preview/);
    catalog.close();
  });

  it('paginates case-insensitive filename sorting without repeats or omissions', async () => {
    const root = await createTemporaryDirectory();
    const photosDirectory = path.join(root, 'photos');
    await mkdir(photosDirectory, { recursive: true });
    for (const fileName of ['alpha.jpg', 'Bravo.jpg', 'charlie.jpg', 'Delta.jpg', 'echo.jpg']) {
      await writeFile(path.join(photosDirectory, fileName), fileName);
    }
    const catalog = new CatalogService(path.join(root, 'catalog.sqlite'));
    await catalog.importFolders([photosDirectory]);
    const fileNames: string[] = [];
    let cursor = null;
    do {
      const page = catalog.listAssetPage({ folderId: null, sortBy: 'fileName', cursor, limit: 2 });
      fileNames.push(...page.items.map((asset) => asset.fileName));
      cursor = page.nextCursor;
    } while (cursor);

    expect(fileNames).toEqual(['alpha.jpg', 'Bravo.jpg', 'charlie.jpg', 'Delta.jpg', 'echo.jpg']);
    catalog.close();
  });

  it('manages virtual albums and dynamic smart collections without moving files', async () => {
    const root = await createTemporaryDirectory();
    const photosDirectory = path.join(root, 'photos');
    await mkdir(photosDirectory, { recursive: true });
    await writeFile(path.join(photosDirectory, 'one.jpg'), 'one');
    await writeFile(path.join(photosDirectory, 'two.jpg'), 'two');
    const catalog = new CatalogService(path.join(root, 'catalog.sqlite'));
    await catalog.importFolders([photosDirectory]);
    const assets = catalog.listAssets();
    const database = new DatabaseSync(path.join(root, 'catalog.sqlite'));
    database.exec("CREATE TABLE generation_results (id TEXT PRIMARY KEY, asset_id TEXT NOT NULL, review_state TEXT NOT NULL)");
    database.prepare("INSERT INTO generation_results (id, asset_id, review_state) VALUES (?, ?, 'undecided')").run('result-1', assets[0]!.id);
    database.close();
    catalog.updateMetadata({ assetIds: [assets[0]!.id], favorite: true });
    const album = catalog.saveAlbum({ name: '交付候选' });
    expect(catalog.updateAlbumAssets({ albumId: album.id, assetIds: [assets[0]!.id], mode: 'add' })).toMatchObject({ assetCount: 1 });
    expect(catalog.listAssetPage({ albumId: album.id, cursor: null, limit: 20 }).items).toHaveLength(1);
    expect(catalog.listSmartCollections().find((item) => item.id === 'favorites')?.assetCount).toBe(1);
    expect(catalog.listSmartCollections().find((item) => item.id === 'to-review')?.assetCount).toBe(1);
    expect(catalog.listAssetPage({ smartCollection: 'to-review', cursor: null, limit: 20 }).items).toHaveLength(1);
    expect(catalog.updateAlbumAssets({ albumId: album.id, assetIds: [assets[0]!.id], mode: 'remove' })).toMatchObject({ assetCount: 0 });
    catalog.deleteAlbum(album.id);
    catalog.close();
  });

  it('builds the recent collection from real import timestamps', async () => {
    const root = await createTemporaryDirectory();
    const photosDirectory = path.join(root, 'photos');
    const databasePath = path.join(root, 'catalog.sqlite');
    await mkdir(photosDirectory, { recursive: true });
    await Promise.all([
      writeFile(path.join(photosDirectory, 'recent.jpg'), 'recent'),
      writeFile(path.join(photosDirectory, 'old.jpg'), 'old')
    ]);
    const catalog = new CatalogService(databasePath);
    await catalog.importFolders([photosDirectory]);
    const database = new DatabaseSync(databasePath);
    database.prepare('UPDATE assets SET imported_at = ? WHERE file_name = ?')
      .run(Date.now() - 31 * 24 * 60 * 60 * 1_000, 'old.jpg');
    database.close();

    expect(catalog.listSmartCollections().find((collection) => collection.id === 'recent')?.assetCount).toBe(1);
    const page = catalog.listAssetPage({ smartCollection: 'recent', cursor: null, limit: 20 });
    expect(page.totalCount).toBe(1);
    expect(page.items[0]?.fileName).toBe('recent.jpg');
    catalog.close();
  });

  it('marks externally removed files offline and restores them after reappearance', async () => {
    const root = await createTemporaryDirectory();
    const photosDirectory = path.join(root, 'photos');
    await mkdir(photosDirectory, { recursive: true });
    const photoPath = path.join(photosDirectory, 'tracked.jpg');
    await writeFile(photoPath, 'photo');
    const catalog = new CatalogService(path.join(root, 'catalog.sqlite'));
    await catalog.importFolders([photosDirectory]);
    await unlink(photoPath);
    await catalog.reconcileImportedFolders();
    expect(catalog.listAssets()[0]?.offline).toBe(true);
    await writeFile(photoPath, 'photo-restored');
    await catalog.reconcileImportedFolders();
    expect(catalog.listAssets()[0]?.offline).toBe(false);
    catalog.close();
  });

  it('keeps inaccessible imported roots offline without blocking other roots', async () => {
    const root = await createTemporaryDirectory();
    const first = path.join(root, 'first');
    const second = path.join(root, 'second');
    await mkdir(first, { recursive: true });
    await mkdir(second, { recursive: true });
    await writeFile(path.join(first, 'first.jpg'), 'first');
    await writeFile(path.join(second, 'second.jpg'), 'second');
    const catalog = new CatalogService(path.join(root, 'catalog.sqlite'));
    await catalog.importFolders([first, second]);
    await rm(first, { recursive: true, force: true });
    await expect(catalog.reconcileImportedFolders()).resolves.toMatchObject({ discovered: 0, offline: 1 });
    expect(catalog.listAssets().find((asset) => asset.fileName === 'first.jpg')?.offline).toBe(true);
    expect(catalog.listAssets().find((asset) => asset.fileName === 'second.jpg')?.offline).toBe(false);
    catalog.close();
  });

  it('unregisters and restores a source folder without changing files or catalog metadata', async () => {
    const root = await createTemporaryDirectory();
    const photosDirectory = path.join(root, 'photos');
    const photoPath = path.join(photosDirectory, 'kept.jpg');
    const databasePath = path.join(root, 'catalog.sqlite');
    await mkdir(photosDirectory, { recursive: true });
    await writeFile(photoPath, 'original-photo-bytes');
    const catalog = new CatalogService(databasePath);
    await catalog.importFolders([photosDirectory]);
    const original = catalog.listAssets()[0]!;
    catalog.updateMetadata({ assetIds: [original.id], rating: 5, favorite: true });
    const tag = catalog.updateTags({ assetIds: [original.id], addTags: ['客户精选'], removeTagIds: [] })[0]!;
    const album = catalog.saveAlbum({ name: '交付候选' });
    catalog.updateAlbumAssets({ albumId: album.id, assetIds: [original.id], mode: 'add' });
    const database = new DatabaseSync(databasePath);
    database.exec(`
      CREATE TABLE analysis_revisions (id TEXT PRIMARY KEY, asset_id TEXT NOT NULL);
      CREATE TABLE generation_results (id TEXT PRIMARY KEY, asset_id TEXT NOT NULL, review_state TEXT NOT NULL);
    `);
    database.prepare('INSERT INTO analysis_revisions (id, asset_id) VALUES (?, ?)').run('analysis-kept', original.id);
    database.prepare("INSERT INTO generation_results (id, asset_id, review_state) VALUES (?, ?, 'undecided')")
      .run('generation-kept', original.id);
    database.close();

    expect(catalog.unregisterFolder(original.folderId)).toEqual({ folderId: original.folderId, assetCount: 1 });
    expect(catalog.listFolders()).toEqual([]);
    expect(catalog.listFolderPaths()).toEqual([]);
    expect(catalog.listAssets()).toEqual([]);
    expect(catalog.listTags()).toEqual([]);
    expect(catalog.listAlbums()[0]?.assetCount).toBe(0);
    expect(catalog.listSmartCollections().find((item) => item.id === 'favorites')?.assetCount).toBe(0);
    await expect(readFile(photoPath, 'utf8')).resolves.toBe('original-photo-bytes');
    expect(() => catalog.unregisterFolder(original.folderId)).toThrow('CATALOG_FOLDER_NOT_FOUND');

    await catalog.importFolders([photosDirectory]);
    const restored = catalog.listAssets()[0]!;
    expect(restored).toMatchObject({ id: original.id, folderId: original.folderId, rating: 5, favorite: true });
    expect(restored.tags).toContainEqual({ id: tag.id, name: tag.name });
    expect(catalog.listFolders()[0]).toMatchObject({ id: original.folderId, assetCount: 1 });
    expect(catalog.listFolderPaths()).toEqual([await realpath(photosDirectory)]);
    expect(catalog.listAlbums()[0]?.assetCount).toBe(1);
    expect(catalog.listTags()[0]).toMatchObject({ id: tag.id, assetCount: 1 });
    expect(catalog.listSmartCollections().find((item) => item.id === 'favorites')?.assetCount).toBe(1);
    const restoredDatabase = new DatabaseSync(databasePath);
    expect(restoredDatabase.prepare('SELECT COUNT(*) AS value FROM analysis_revisions WHERE asset_id = ?').get(original.id))
      .toEqual({ value: 1 });
    expect(restoredDatabase.prepare('SELECT COUNT(*) AS value FROM generation_results WHERE asset_id = ?').get(original.id))
      .toEqual({ value: 1 });
    restoredDatabase.close();
    catalog.close();
  });

  it('rejects unregistering a folder referenced by an active AI task', async () => {
    const root = await createTemporaryDirectory();
    const photosDirectory = path.join(root, 'photos');
    const databasePath = path.join(root, 'catalog.sqlite');
    await mkdir(photosDirectory, { recursive: true });
    await writeFile(path.join(photosDirectory, 'busy.jpg'), 'busy');
    const catalog = new CatalogService(databasePath);
    await catalog.importFolders([photosDirectory]);
    const asset = catalog.listAssets()[0]!;
    const database = new DatabaseSync(databasePath);
    database.exec('CREATE TABLE tasks (asset_id TEXT, status TEXT NOT NULL)');
    database.prepare("INSERT INTO tasks (asset_id, status) VALUES (?, 'processing')").run(asset.id);
    database.close();

    expect(() => catalog.unregisterFolder(asset.folderId)).toThrow('FOLDER_HAS_ACTIVE_TASKS');
    expect(catalog.listFolders()).toHaveLength(1);
    expect(catalog.listAssets()).toHaveLength(1);
    catalog.close();
  });

  it('rejects unregistering a folder referenced by an active file transaction', async () => {
    const root = await createTemporaryDirectory();
    const photosDirectory = path.join(root, 'photos');
    const databasePath = path.join(root, 'catalog.sqlite');
    await mkdir(photosDirectory, { recursive: true });
    await writeFile(path.join(photosDirectory, 'moving.jpg'), 'moving');
    const catalog = new CatalogService(databasePath);
    await catalog.importFolders([photosDirectory]);
    const asset = catalog.listAssets()[0]!;
    const database = new DatabaseSync(databasePath);
    database.exec(`
      CREATE TABLE file_operations (id TEXT PRIMARY KEY, status TEXT NOT NULL);
      CREATE TABLE file_operation_items (
        operation_id TEXT NOT NULL,
        source_folder_id TEXT NOT NULL,
        destination_folder_id TEXT NOT NULL
      );
    `);
    database.prepare("INSERT INTO file_operations (id, status) VALUES ('operation-1', 'executing')").run();
    database.prepare(`
      INSERT INTO file_operation_items (operation_id, source_folder_id, destination_folder_id)
      VALUES ('operation-1', ?, 'another-folder')
    `).run(asset.folderId);
    database.close();

    expect(() => catalog.unregisterFolder(asset.folderId)).toThrow('FOLDER_HAS_ACTIVE_FILE_OPERATIONS');
    expect(catalog.listFolders()).toHaveLength(1);
    expect(catalog.listAssets()).toHaveLength(1);
    catalog.close();
  });

  it('unregisters large folders without expanding asset ids into SQL parameters', async () => {
    const root = await createTemporaryDirectory();
    const photosDirectory = path.join(root, 'photos');
    const databasePath = path.join(root, 'catalog.sqlite');
    await mkdir(photosDirectory, { recursive: true });
    await writeFile(path.join(photosDirectory, 'seed.jpg'), 'seed');
    const catalog = new CatalogService(databasePath);
    await catalog.importFolders([photosDirectory]);
    const folderId = catalog.listAssets()[0]!.folderId;
    const database = new DatabaseSync(databasePath);
    const insert = database.prepare(`
      INSERT INTO assets (id, folder_id, path, file_name, extension, size_bytes, modified_at, imported_at)
      VALUES (?, ?, ?, ?, '.jpg', 1, 1, 1)
    `);
    database.exec('BEGIN IMMEDIATE');
    for (let index = 0; index < 1_100; index += 1) {
      const fileName = `virtual-${index}.jpg`;
      insert.run(`virtual-${index}`, folderId, path.join(photosDirectory, fileName), fileName);
    }
    database.exec('COMMIT');
    database.close();

    expect(catalog.unregisterFolder(folderId)).toEqual({ folderId, assetCount: 1_101 });
    expect(catalog.listAssets()).toEqual([]);
    catalog.close();
  });

  it('relinks a moved folder while preserving asset identities and discovering new files', async () => {
    const root = await createTemporaryDirectory();
    const original = path.join(root, 'original');
    const relocated = path.join(root, 'relocated');
    await mkdir(path.join(original, 'nested'), { recursive: true });
    await writeFile(path.join(original, 'nested', 'tracked.jpg'), 'tracked');
    const catalog = new CatalogService(path.join(root, 'catalog.sqlite'));
    await catalog.importFolders([original]);
    const asset = catalog.listAssets()[0]!;
    await import('node:fs/promises').then(({ rename }) => rename(original, relocated));
    await writeFile(path.join(relocated, 'new.jpg'), 'new');
    await catalog.reconcileImportedFolders();
    expect(catalog.listAssets()[0]?.offline).toBe(true);

    const result = await catalog.relinkFolder(asset.folderId, relocated);

    expect(result).toMatchObject({ matched: 1, discovered: 1, offline: 0 });
    expect(result.relocations).toEqual([expect.objectContaining({ assetId: asset.id, previousFileName: 'tracked.jpg', nextFileName: 'tracked.jpg' })]);
    expect(catalog.resolveAssetFile(asset.id)?.path).toBe(path.join(await realpath(relocated), 'nested', 'tracked.jpg'));
    expect(catalog.listAssets()).toHaveLength(2);
    catalog.close();
  });

  it('preserves identity after a unique file is renamed and moved inside a relocated folder', async () => {
    const root = await createTemporaryDirectory();
    const original = path.join(root, 'original');
    const relocated = path.join(root, 'relocated');
    await mkdir(path.join(original, 'old'), { recursive: true });
    await writeFile(path.join(original, 'old', 'camera-name.jpg'), 'unique-photo-content');
    const catalog = new CatalogService(path.join(root, 'catalog.sqlite'));
    await catalog.importFolders([original]);
    const asset = catalog.listAssets()[0]!;
    const { rename } = await import('node:fs/promises');
    await rename(original, relocated);
    await mkdir(path.join(relocated, 'organized'), { recursive: true });
    await rename(path.join(relocated, 'old', 'camera-name.jpg'), path.join(relocated, 'organized', 'final-name.jpg'));

    const result = await catalog.relinkFolder(asset.folderId, relocated);

    expect(result).toMatchObject({ matched: 1, discovered: 0, offline: 0 });
    expect(result.relocations).toEqual([expect.objectContaining({
      assetId: asset.id,
      previousFileName: 'camera-name.jpg',
      nextFileName: 'final-name.jpg'
    })]);
    expect(catalog.resolveAssetFile(asset.id)?.path).toBe(path.join(await realpath(relocated), 'organized', 'final-name.jpg'));
    catalog.close();
  });

  it('does not guess identity when metadata fingerprints are ambiguous', async () => {
    const root = await createTemporaryDirectory();
    const original = path.join(root, 'original');
    const relocated = path.join(root, 'relocated');
    await mkdir(original, { recursive: true });
    const firstPath = path.join(original, 'first.jpg');
    const secondPath = path.join(original, 'second.jpg');
    await Promise.all([writeFile(firstPath, 'same'), writeFile(secondPath, 'same')]);
    const timestamp = new Date('2026-01-01T00:00:00.000Z');
    const { rename, utimes } = await import('node:fs/promises');
    await Promise.all([utimes(firstPath, timestamp, timestamp), utimes(secondPath, timestamp, timestamp)]);
    const catalog = new CatalogService(path.join(root, 'catalog.sqlite'));
    await catalog.importFolders([original]);
    const assets = catalog.listAssets();
    const originalIds = new Set(assets.map((asset) => asset.id));
    await rename(original, relocated);
    await Promise.all([
      rename(path.join(relocated, 'first.jpg'), path.join(relocated, 'renamed-a.jpg')),
      rename(path.join(relocated, 'second.jpg'), path.join(relocated, 'renamed-b.jpg'))
    ]);

    const result = await catalog.relinkFolder(assets[0]!.folderId, relocated);

    expect(result).toMatchObject({ matched: 0, discovered: 2, offline: 2 });
    expect(catalog.listAssets().filter((asset) => originalIds.has(asset.id)).every((asset) => asset.offline)).toBe(true);
    catalog.close();
  });

  it('uses indexed content hashes to resolve metadata-ambiguous renamed files', async () => {
    const root = await createTemporaryDirectory();
    const original = path.join(root, 'original');
    const relocated = path.join(root, 'relocated');
    await mkdir(original, { recursive: true });
    const firstPath = path.join(original, 'first.jpg');
    const secondPath = path.join(original, 'second.jpg');
    await Promise.all([writeFile(firstPath, 'AAAA'), writeFile(secondPath, 'BBBB')]);
    const timestamp = new Date('2026-01-01T00:00:00.000Z');
    const { rename, utimes } = await import('node:fs/promises');
    await Promise.all([utimes(firstPath, timestamp, timestamp), utimes(secondPath, timestamp, timestamp)]);
    const catalog = new CatalogService(path.join(root, 'catalog.sqlite'));
    await catalog.importFolders([original]);
    await expect(catalog.indexPendingContentHashes(2)).resolves.toEqual({ indexed: 2, remaining: 0 });
    const assets = catalog.listAssets();
    const firstId = assets.find((asset) => asset.fileName === 'first.jpg')!.id;
    const secondId = assets.find((asset) => asset.fileName === 'second.jpg')!.id;
    await rename(original, relocated);
    await Promise.all([
      rename(path.join(relocated, 'first.jpg'), path.join(relocated, 'renamed-a.jpg')),
      rename(path.join(relocated, 'second.jpg'), path.join(relocated, 'renamed-b.jpg'))
    ]);

    const result = await catalog.relinkFolder(assets[0]!.folderId, relocated);

    expect(result).toMatchObject({ matched: 2, discovered: 0, offline: 0 });
    expect(catalog.resolveAssetFile(firstId)?.fileName).toBe('renamed-a.jpg');
    expect(catalog.resolveAssetFile(secondId)?.fileName).toBe('renamed-b.jpg');
    catalog.close();
  });

  it('invalidates a content hash when an imported file changes', async () => {
    const root = await createTemporaryDirectory();
    const photos = path.join(root, 'photos');
    const filePath = path.join(photos, 'changed.jpg');
    await mkdir(photos, { recursive: true });
    await writeFile(filePath, 'before');
    const catalog = new CatalogService(path.join(root, 'catalog.sqlite'));
    await catalog.importFolders([photos]);
    await expect(catalog.indexPendingContentHashes()).resolves.toEqual({ indexed: 1, remaining: 0 });
    await writeFile(filePath, 'content-after-change');
    const changedTime = new Date(Date.now() + 2_000);
    await import('node:fs/promises').then(({ utimes }) => utimes(filePath, changedTime, changedTime));

    await catalog.importFolders([photos]);

    await expect(catalog.indexPendingContentHashes()).resolves.toEqual({ indexed: 1, remaining: 0 });
    catalog.close();
  });
});
