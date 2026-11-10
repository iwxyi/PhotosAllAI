import { mkdtemp, mkdir, readFile, realpath, rename, rm, stat, unlink, utimes, writeFile } from 'node:fs/promises';
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
  it('trashes a parent folder once and removes its descendants from the catalog', async () => {
    const root = await createTemporaryDirectory();
    const source = path.join(root, 'photos');
    await mkdir(path.join(source, 'A', 'child'), { recursive: true });
    await mkdir(path.join(source, 'B'), { recursive: true });
    await writeFile(path.join(source, 'A', 'child', 'one.jpg'), 'fixture');
    await writeFile(path.join(source, 'B', 'two.jpg'), 'fixture');
    const catalog = new CatalogService(path.join(root, 'catalog.sqlite'));
    try {
      await catalog.importFolders([source]);
      const folder = catalog.listFolders().find((item) => item.name === 'A')!;
      const trashed: string[] = [];
      await catalog.trashFolder(folder.id, async (folderPath) => { trashed.push(folderPath); await rm(folderPath, { recursive: true }); });
      expect(trashed).toEqual([path.join(await realpath(source), 'A')]);
      expect(catalog.listFolders().map((item) => item.name)).toEqual(['photos', 'B']);
      expect(catalog.listAssetPage({}).items.map((item) => item.fileName)).toEqual(['two.jpg']);
    } finally { catalog.close(); }
  });
  it('persists empty child folders, resolves name collisions and tracks renames and moves', async () => {
    const root = await createTemporaryDirectory();
    const source = path.join(root, 'photos');
    await mkdir(source);
    const database = path.join(root, 'catalog.sqlite');
    let catalog = new CatalogService(database);
    try {
      await catalog.importFolders([source]);
      const parent = catalog.listFolders()[0]!;
      const first = (await catalog.createFolder({ parentFolderId: parent.id })).folder;
      const second = (await catalog.createFolder({ parentFolderId: parent.id })).folder;
      expect(first.name).toBe('新建文件夹');
      expect(second.name).toBe('新建文件夹 2');
      const nested = (await catalog.createFolder({ parentFolderId: first.id })).folder;
      expect(nested.parentId).toBe(first.id);
      await expect(catalog.renameFolder({ folderId: first.id, name: '..' })).rejects.toThrow('INVALID_FOLDER_NAME');
      await expect(catalog.renameFolder({ folderId: first.id, name: second.name })).rejects.toThrow('FOLDER_NAME_ALREADY_EXISTS');
      const renamed = (await catalog.renameFolder({ folderId: first.id, name: '输出' })).folder;
      expect(renamed.id).not.toBe(first.id);
      expect(catalog.listFolders().find((folder) => folder.parentId === renamed.id)?.name).toBe('新建文件夹');
      const moved = await catalog.moveFolder({ sourceFolderId: renamed.id, targetFolderId: second.id });
      expect(moved.folder.parentId).toBe(second.id);
      catalog.close();
      catalog = new CatalogService(database);
      expect(catalog.listFolders().find((folder) => folder.id === moved.folder.id)?.assetCount).toBe(0);
      expect(catalog.resolveFolderPath(moved.folder.id)).toBe(await realpath(path.join(source, second.name, '输出')));
      expect((await stat(path.join(source, second.name, '输出', nested.name))).isDirectory()).toBe(true);
    } finally { catalog.close(); }
  });

  it('combines folder, local date, month and format filters before counting and pagination', async () => {
    const root = await createTemporaryDirectory();
    const catalog = new CatalogService(path.join(root, 'catalog.sqlite'));
    try {
      const photoRoot = path.join(root, 'photos');
      const january = new Date(2026, 0, 15, 12);
      const february = new Date(2026, 1, 1, 0);
      for (const [relative, date] of [['A/one.jpg', january], ['A/two.png', january], ['B/three.jpg', february], ['A/sub/four.jpg', january]] as const) {
        const file = path.join(photoRoot, relative);
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, 'fixture');
        await utimes(file, date, date);
      }
      await catalog.importFolders([photoRoot]);
      const folders = catalog.listFolders();
      const folderA = folders.find((folder) => folder.name === 'A')!;
      const folderB = folders.find((folder) => folder.name === 'B')!;
      expect(catalog.listAssetPage({ folderIds: [folderA.id] }).totalCount).toBe(3);
      expect(catalog.listAssetPage({ folderIds: [folderA.id, folderB.id] }).totalCount).toBe(4);
      expect(catalog.listAssetPage({ folderIds: [folderA.id, folders.find((folder) => folder.name === 'sub')!.id] }).totalCount).toBe(3);
      expect(catalog.listAssetPage({ folderIds: ['missing'] }).totalCount).toBe(0);
      expect(catalog.listAssetPage({ months: ['2026-01', '2026-02'], formats: ['jpg', 'PNG'] }).totalCount).toBe(4);
      const filters = { folderIds: [folderA.id, folderB.id], dateFrom: new Date(2026, 0, 1).getTime(), dateTo: february.getTime(), months: ['2026-01'], formats: ['JPG'], sortBy: 'fileName' as const, limit: 1 };
      const first = catalog.listAssetPage(filters);
      expect(first.totalCount).toBe(2);
      expect(first.items[0]?.fileName).toBe('four.jpg');
      expect(first.items[0]?.directoryId).toBe(folders.find((folder) => folder.name === 'sub')?.id);
      const next = catalog.listAssetPage({ ...filters, cursor: first.nextCursor });
      expect(next.items[0]?.fileName).toBe('one.jpg');
      expect(next.nextCursor).toBeNull();
      expect(catalog.listAssetPage({ dateFrom: february.getTime(), months: ['2026-01'] }).totalCount).toBe(0);
      expect(catalog.listAssetPage({ dateFrom: february.getTime() }).items[0]?.fileName).toBe('three.jpg');
    } finally { catalog.close(); }
  });

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
    const taskAsset = catalog.listAssetPage({ assetIds: [assets[0]!.id], limit: 500 });
    expect(taskAsset.items.map((asset) => asset.id)).toEqual([assets[0]!.id]);
    expect(taskAsset.totalCount).toBe(1);
    expect(catalog.listAssetPage({ assetIds: ['missing-asset'] }).items).toEqual([]);
    expect(assets.map((asset) => asset.fileName).sort()).toEqual(['raw.NEF', 'visible.jpg']);
    expect(catalog.listFolders()).toEqual([expect.objectContaining({ id: assets[0]?.folderId, name: 'photos', assetCount: 2, offlineCount: 0, parentId: null, rootId: assets[0]?.folderId, depth: 0, isRoot: true })]);
    const updated = catalog.updateMetadata({ assetIds: assets.map((asset) => asset.id), rating: 4 });
    expect(updated.every((asset) => asset.rating === 4)).toBe(true);
    expect(catalog.updateMetadata({ assetIds: [assets[0]!.id], flag: 'picked' })[0]?.flag).toBe('picked');
    expect(catalog.listAssets().find((asset) => asset.id === assets[0]!.id)?.flag).toBe('picked');
    expect(catalog.updateMetadata({ assetIds: [assets[0]!.id], flag: 'rejected' })[0]?.flag).toBe('rejected');
    expect(catalog.updateMetadata({ assetIds: [assets[0]!.id], flag: 'unflagged' })[0]?.flag).toBe('unflagged');
    const labeled = catalog.updateMetadata({ assetIds: assets.map((asset) => asset.id), labelColor: 'green' });
    expect(labeled.every((asset) => asset.labelColor === 'green')).toBe(true);
    const cleared = catalog.updateMetadata({ assetIds: [assets[0]!.id], labelColor: null });
    expect(cleared[0]?.labelColor).toBeNull();
    expect(catalog.listAssets().find((asset) => asset.id === assets[1]!.id)?.labelColor).toBe('green');
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
    for (const sortBy of ['fileName', 'rating', 'modifiedAt'] as const) {
      for (const sortDirection of ['asc', 'desc'] as const) {
        const first = catalog.listAssetPage({ sortBy, sortDirection, limit: 1 });
        const second = catalog.listAssetPage({ sortBy, sortDirection, cursor: first.nextCursor, limit: 1 });
        const complete = catalog.listAssetPage({ sortBy, sortDirection, limit: 20 });
        expect([...first.items, ...second.items].map((item) => item.id)).toEqual(complete.items.map((item) => item.id));
        const positioned = catalog.listAssetPage({ sortBy, sortDirection, offset: 1, limit: 1 });
        expect(positioned.items.map((item) => item.id)).toEqual(second.items.map((item) => item.id));
        expect(positioned.totalCount).toBe(complete.totalCount);
        expect(catalog.listAssetPage({ sortBy, sortDirection, offset: 2, limit: 1 }).items).toEqual([]);
        expect(new Set([...first.items, ...second.items].map((item) => item.id)).size).toBe(2);
      }
    }
    expect(() => catalog.listAssetPage({ cursor: firstPage.nextCursor, offset: 1 })).toThrow('Use either cursor or offset');
    expect(catalog.listAssetPage({ sortBy: 'fileName', sortDirection: 'desc' }).items[0]?.fileName).toBe('visible.jpg');
    expect(catalog.listAssetPage({ sortBy: 'rating', sortDirection: 'asc' }).items[0]?.rating).toBe(1);
    expect(catalog.listAssetPage({ minimumRating: 5, ratingOperator: 'gte' }).totalCount).toBe(1);
    expect(catalog.listAssetPage({ minimumRating: 1, ratingOperator: 'eq' }).items[0]?.id).toBe(assets[0]!.id);
    expect(catalog.listAssetPage({ minimumRating: 1, ratingOperator: 'lte' }).totalCount).toBe(1);
    catalog.updateMetadata({ assetIds: [assets[1]!.id], flag: 'picked' });
    const filteredPage = catalog.listAssetPage({ minimumRating: 4, flags: ['picked'], colors: ['green'], limit: 1 });
    expect(filteredPage.totalCount).toBe(1);
    expect(filteredPage.items[0]?.id).toBe(assets[1]!.id);
    expect(catalog.listAssetPage({ flags: ['rejected'] }).totalCount).toBe(0);
    expect(catalog.listAssetPage({ colors: ['red', 'green'] }).totalCount).toBe(1);
    catalog.updateMetadata({ assetIds: [assets[1]!.id], flag: 'unflagged' });

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

  it('exposes nested folders and filters assets recursively', async () => {
    const root = await createTemporaryDirectory();
    const source = path.join(root, 'library');
    await mkdir(path.join(source, '2026', '春季'), { recursive: true });
    await mkdir(path.join(source, '2026', '夏季'), { recursive: true });
    await writeFile(path.join(source, '2026', '春季', 'one.jpg'), 'one');
    await writeFile(path.join(source, '2026', '夏季', 'two.jpg'), 'two');
    const catalog = new CatalogService(path.join(root, 'catalog.sqlite'));
    await catalog.importFolders([source]);
    const folders = catalog.listFolders();
    const rootFolder = folders.find((folder) => folder.isRoot)!;
    const year = folders.find((folder) => folder.name === '2026')!;
    const spring = folders.find((folder) => folder.name === '春季')!;
    expect(year.parentId).toBe(rootFolder.id);
    expect(spring.parentId).toBe(year.id);
    expect(year.assetCount).toBe(2);
    const page = catalog.listAssetPage({ folderId: year.id, cursor: null, limit: 20 });
    expect(page.items.map((asset) => asset.fileName).sort()).toEqual(['one.jpg', 'two.jpg']);
    await unlink(path.join(source, '2026', '春季', 'one.jpg'));
    await writeFile(path.join(source, '2026', '春季', 'three.jpg'), 'three');
    expect(await catalog.synchronizeFolder(spring.id)).toEqual({ discovered: 1, offline: 1 });
    expect(catalog.resolveFolderPath(spring.id)).toBe(await realpath(path.join(source, '2026', '春季')));
    expect(catalog.listAssetPage({ folderId: spring.id, cursor: null, limit: 20 }).items)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ fileName: 'one.jpg', offline: true }),
        expect.objectContaining({ fileName: 'three.jpg', offline: false })
      ]));
    catalog.close();
  });

  it('moves a nested folder and preserves catalog asset identity', async () => {
    const root = await createTemporaryDirectory();
    const source = path.join(root, 'library');
    await mkdir(path.join(source, 'from', 'nested'), { recursive: true });
    await mkdir(path.join(source, 'to'), { recursive: true });
    await writeFile(path.join(source, 'from', 'nested', 'photo.jpg'), 'photo');
    await writeFile(path.join(source, 'to', 'keep.jpg'), 'keep');
    const catalog = new CatalogService(path.join(root, 'catalog.sqlite'));
    await catalog.importFolders([source]);
    const before = catalog.listAssets().find((asset) => asset.fileName === 'photo.jpg')!;
    const folders = catalog.listFolders();
    const nested = folders.find((folder) => folder.name === 'nested')!;
    const target = folders.find((folder) => folder.name === 'to')!;
    const result = await catalog.moveFolder({ sourceFolderId: nested.id, targetFolderId: target.id });
    const after = catalog.listAssets().find((asset) => asset.fileName === 'photo.jpg')!;
    const afterFile = catalog.resolveAssetFile(after.id)!;
    expect(after.id).toBe(before.id);
    expect(afterFile.path).toBe(path.join(await realpath(source), 'to', 'nested', 'photo.jpg'));
    expect(result.folder.parentId).toBe(target.id);
    expect(result.relocations).toEqual([expect.objectContaining({ assetId: before.id, nextPath: afterFile.path })]);
    await expect(stat(path.join(source, 'to', 'nested', 'photo.jpg'))).resolves.toBeDefined();
    await expect(catalog.moveFolder({ sourceFolderId: target.id, targetFolderId: result.folder.id })).rejects.toThrow('FOLDER_MOVE_INTO_DESCENDANT');
    catalog.close();
  });

  it('moves an associated root into another root without duplicate indexing', async () => {
    const root = await createTemporaryDirectory();
    const source = path.join(root, 'source');
    const target = path.join(root, 'target');
    await mkdir(source, { recursive: true });
    await mkdir(target, { recursive: true });
    await writeFile(path.join(source, 'photo.jpg'), 'photo');
    await writeFile(path.join(target, 'keep.jpg'), 'keep');
    const catalog = new CatalogService(path.join(root, 'catalog.sqlite'));
    await catalog.importFolders([source, target]);
    const sourceRoot = catalog.listFolders().find((folder) => folder.isRoot && folder.name === 'source')!;
    const targetRoot = catalog.listFolders().find((folder) => folder.isRoot && folder.name === 'target')!;
    const assetId = catalog.listAssets().find((asset) => asset.fileName === 'photo.jpg')!.id;
    const result = await catalog.moveFolder({ sourceFolderId: sourceRoot.id, targetFolderId: targetRoot.id });
    expect(result.folder.parentId).toBe(targetRoot.id);
    expect(catalog.listFolders().some((folder) => folder.id === sourceRoot.id)).toBe(false);
    expect(catalog.listAssets().find((asset) => asset.id === assetId)?.folderId).toBe(targetRoot.id);
    await expect(stat(path.join(target, 'source', 'photo.jpg'))).resolves.toBeDefined();
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

  it('keeps indexed sorting deterministic in both directions with tied values', async () => {
    const root = await createTemporaryDirectory();
    const photosDirectory = path.join(root, 'photos');
    await mkdir(photosDirectory, { recursive: true });
    for (const fileName of ['a.jpg', 'A.jpg', 'b.jpg', 'B.jpg', 'c.jpg', 'C.jpg']) {
      await writeFile(path.join(photosDirectory, fileName), fileName);
    }
    const catalog = new CatalogService(path.join(root, 'catalog.sqlite'));
    await catalog.importFolders([photosDirectory]);
    const folder = catalog.listFolders()[0];
    expect(folder).toBeDefined();
    for (const sortBy of ['fileName', 'rating', 'modifiedAt'] as const) {
      for (const sortDirection of ['asc', 'desc'] as const) {
        for (const folderId of [null, folder!.id]) {
          const expected = catalog.listAssetPage({ folderId, sortBy, sortDirection, limit: 100 }).items.map((asset) => asset.id);
          const actual: string[] = [];
          let cursor = null;
          do {
            const page = catalog.listAssetPage({ folderId, sortBy, sortDirection, limit: 2, cursor });
            actual.push(...page.items.map((asset) => asset.id));
            cursor = page.nextCursor;
          } while (cursor);
          expect(actual).toEqual(expected);
        }
      }
    }
    catalog.close();
  });

  it('does not hold the catalog write lock while inspecting source files', async () => {
    const root = await createTemporaryDirectory();
    const photosDirectory = path.join(root, 'photos');
    const databasePath = path.join(root, 'catalog.sqlite');
    await mkdir(photosDirectory, { recursive: true });
    await Promise.all(Array.from({ length: 300 }, (_value, index) =>
      writeFile(path.join(photosDirectory, `photo-${String(index).padStart(3, '0')}.jpg`), `photo-${index}`)
    ));
    const catalog = new CatalogService(databasePath);
    const observer = new DatabaseSync(databasePath);
    observer.exec('PRAGMA busy_timeout = 1');
    let importFinished = false;
    const importing = catalog.importFolders([photosDirectory]).finally(() => { importFinished = true; });
    let folderVisible = false;
    for (let attempt = 0; attempt < 100 && !folderVisible; attempt += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      folderVisible = Boolean(observer.prepare('SELECT 1 FROM folders LIMIT 1').get());
    }
    expect(folderVisible).toBe(true);
    expect(importFinished).toBe(false);

    expect(() => observer.prepare(`
      INSERT INTO tags (id, name, normalized_name) VALUES ('concurrent-tag', 'Concurrent', 'concurrent')
    `).run()).not.toThrow();
    await expect(importing).resolves.toBe(300);
    observer.close();
    catalog.close();
  });

  it('imports a large directory in bounded metadata batches and skips vanished files', async () => {
    const root = await createTemporaryDirectory();
    const photosDirectory = path.join(root, 'photos');
    await mkdir(photosDirectory);
    const files = Array.from({ length: 1_100 }, (_, index) => path.join(photosDirectory, `photo-${String(index).padStart(4, '0')}.jpg`));
    await Promise.all(files.map((file) => writeFile(file, 'image')));
    const catalog = new CatalogService(path.join(root, 'catalog.sqlite'));
    let eventLoopTurnObserved = false;
    const importing = catalog.importFolders([photosDirectory]);
    setImmediate(() => { eventLoopTurnObserved = true; });
    expect(await importing).toBe(1_100);
    expect(eventLoopTurnObserved).toBe(true);
    expect(catalog.getStats().assets).toBe(1_100);
    await unlink(files[900]!);
    await expect(catalog.synchronizeFolder(catalog.listFolders()[0]!.id)).resolves.toEqual({ discovered: 0, offline: 1 });
    expect(catalog.getStats().assets).toBe(1_100);
    catalog.close();
  }, 20_000);

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

  it('saves editable rules and follows folder renames and moves', async () => {
    const root = await createTemporaryDirectory();
    const source = path.join(root, 'photos');
    await mkdir(path.join(source, 'A', 'child'), { recursive: true });
    await mkdir(path.join(source, 'B'), { recursive: true });
    await writeFile(path.join(source, 'A', 'child', 'one.jpg'), 'one');
    await writeFile(path.join(source, 'B', 'two.jpg'), 'two');
    const catalog = new CatalogService(path.join(root, 'catalog.sqlite'));
    try {
      await catalog.importFolders([source]);
      const original = catalog.listFolders().find((folder) => folder.name === 'child')!;
      const destination = catalog.listFolders().find((folder) => folder.name === 'B')!;
      const saved = catalog.saveSmartCollection({ name: '待留用', rule: { version: 1, scope: { all: false, favorites: false, folders: false, albums: false, folderIds: [original.id], albumIds: [] }, match: 'any', conditions: [{ field: 'rating', operator: 'gte', value: 4 }, { field: 'fileName', operator: 'contains', value: 'one' }] } });
      expect(saved.assetCount).toBe(1);
      expect(catalog.listAssetPage({ smartCollection: saved.id }).items.map((item) => item.fileName)).toEqual(['one.jpg']);
      const renamed = (await catalog.renameFolder({ folderId: original.id, name: 'renamed' })).folder;
      expect(catalog.listSmartCollections().find((item) => item.id === saved.id)?.rule.scope.folderIds).toEqual([renamed.id]);
      const moved = (await catalog.moveFolder({ sourceFolderId: renamed.id, targetFolderId: destination.id })).folder;
      expect(catalog.listSmartCollections().find((item) => item.id === saved.id)?.rule.scope.folderIds).toEqual([moved.id]);
      expect(catalog.listAssetPage({ smartCollection: saved.id }).totalCount).toBe(1);
      catalog.deleteSmartCollection(saved.id);
      expect(catalog.listAssetPage({ smartCollection: saved.id }).totalCount).toBe(0);
      catalog.deleteSmartCollection('unrated');
      expect(catalog.listSmartCollections().some((item) => item.id === 'unrated')).toBe(false);
    } finally { catalog.close(); }
  });

  it('indexes EXIF values for collection conditions and refreshes stale metadata', async () => {
    const root = await createTemporaryDirectory();
    const source = path.join(root, 'photos');
    await mkdir(source);
    await writeFile(path.join(source, 'one.jpg'), 'one');
    const catalog = new CatalogService(path.join(root, 'catalog.sqlite'));
    try {
      await catalog.importFolders([source]);
      const asset = catalog.listAssets()[0]!;
      const saved = catalog.saveSmartCollection({ name: 'Sony 高 ISO', rule: { version: 1, scope: { all: true, favorites: false, folders: false, albums: false, folderIds: [], albumIds: [] }, match: 'all', conditions: [{ field: 'cameraMake', operator: 'eq', value: 'Sony' }, { field: 'iso', operator: 'gte', value: 800 }] } });
      expect(catalog.listSmartCollections().find((item) => item.id === saved.id)?.indexing).toBe(true);
      expect(catalog.listAssetPage({ smartCollection: saved.id }).totalCount).toBe(0);
      catalog.saveExifDetails(asset.id, { path: path.join(source, 'one.jpg'), sizeBytes: asset.sizeBytes, modifiedAt: asset.modifiedAt, cameraMake: 'Sony', iso: 1600 });
      expect(catalog.listAssetPage({ smartCollection: saved.id }).totalCount).toBe(1);
      expect(catalog.listSmartCollections().find((item) => item.id === saved.id)?.indexing).toBe(false);
      const database = new DatabaseSync(path.join(root, 'catalog.sqlite'));
      database.prepare('UPDATE assets SET modified_at = modified_at + 1 WHERE id = ?').run(asset.id);
      database.close();
      expect(catalog.listAssetPage({ smartCollection: saved.id }).totalCount).toBe(0);
      expect(catalog.listExifIndexCandidates()).toEqual([asset.id]);
    } finally { catalog.close(); }
  });

  it('keeps a missing external directory scope until the user reconnects it', async () => {
    const root = await createTemporaryDirectory();
    const source = path.join(root, 'photos');
    await mkdir(path.join(source, 'old'), { recursive: true });
    await writeFile(path.join(source, 'old', 'one.jpg'), 'fixture');
    const catalog = new CatalogService(path.join(root, 'catalog.sqlite'));
    try {
      await catalog.importFolders([source]);
      const old = catalog.listFolders().find((folder) => folder.name === 'old')!;
      const collection = catalog.saveSmartCollection({ name: '指定目录', rule: { version: 1, scope: { all: false, favorites: false, folders: false, albums: false, folderIds: [old.id], albumIds: [] }, match: 'all', conditions: [] } });
      await rename(path.join(source, 'old'), path.join(source, 'new'));
      await catalog.relinkFolder(catalog.listFolders().find((folder) => folder.isRoot)!.id, source);
      expect(catalog.listSmartCollections().find((item) => item.id === collection.id)?.rule.scope.folderIds).toEqual([old.id]);
      expect(catalog.listAssetPage({ smartCollection: collection.id }).totalCount).toBe(0);
      const replacement = catalog.listFolders().find((folder) => folder.name === 'new')!;
      catalog.saveSmartCollection({ id: collection.id, name: collection.name, rule: { ...collection.rule, scope: { ...collection.rule.scope, folderIds: [replacement.id] } } });
      expect(catalog.listAssetPage({ smartCollection: collection.id }).totalCount).toBe(1);
    } finally { catalog.close(); }
  });

  it('reconnects an externally renamed child after the watcher indexed its new path', async () => {
    const root = await createTemporaryDirectory();
    const source = path.join(root, 'photos');
    const originalPath = path.join(source, 'old');
    const replacementPath = path.join(source, 'new');
    await mkdir(originalPath, { recursive: true });
    await writeFile(path.join(originalPath, 'one.jpg'), 'fixture');
    const catalog = new CatalogService(path.join(root, 'catalog.sqlite'));
    try {
      await catalog.importFolders([source]);
      const old = catalog.listFolders().find((folder) => folder.name === 'old')!;
      const asset = catalog.listAssets()[0]!;
      const originalAssetPath = catalog.resolveAssetFile(asset.id)!.path;
      catalog.updateMetadata({ assetIds: [asset.id], rating: 5 });
      const collection = catalog.saveSmartCollection({ name: '旧目录', rule: {
        version: 1, scope: { all: false, favorites: false, folders: false, albums: false, folderIds: [old.id], albumIds: [] }, match: 'all', conditions: []
      } });
      await rename(originalPath, replacementPath);
      await catalog.synchronizeImportedFile(await realpath(source), 'new/one.jpg');
      await catalog.synchronizeImportedFile(await realpath(source), 'old/one.jpg');
      expect(catalog.listAssets()).toHaveLength(2);
      const report = await catalog.relinkFolder(old.id, replacementPath);
      expect(report).toMatchObject({ matched: 1, discovered: 0 });
      expect(report.relocations).toEqual([expect.objectContaining({ assetId: asset.id, previousPath: originalAssetPath, nextPath: path.join(await realpath(replacementPath), 'one.jpg') })]);
      expect(catalog.listAssets()).toHaveLength(1);
      expect(catalog.listAssets()[0]).toMatchObject({ id: asset.id, rating: 5, offline: false });
      expect(catalog.listSmartCollections().find((item) => item.id === collection.id)?.rule.scope.folderIds).toEqual([report.folder.id]);
      expect(catalog.listAssetPage({ smartCollection: collection.id }).items.map((item) => item.id)).toEqual([asset.id]);
    } finally { catalog.close(); }
  });

  it('automatically follows an external child rename during a folder scan', async () => {
    const root = await createTemporaryDirectory();
    const source = path.join(root, 'photos');
    const originalPath = path.join(source, 'old');
    const replacementPath = path.join(source, 'new');
    await mkdir(originalPath, { recursive: true });
    await writeFile(path.join(originalPath, 'one.jpg'), 'fixture');
    const catalog = new CatalogService(path.join(root, 'catalog.sqlite'));
    try {
      await catalog.importFolders([source]);
      const sourceRoot = catalog.listFolders().find((folder) => folder.isRoot)!;
      const old = catalog.listFolders().find((folder) => folder.name === 'old')!;
      const asset = catalog.listAssets()[0]!;
      catalog.updateMetadata({ assetIds: [asset.id], rating: 4 });
      const collection = catalog.saveSmartCollection({ name: '跟随目录', rule: {
        version: 1, scope: { all: false, favorites: false, folders: false, albums: false, folderIds: [old.id], albumIds: [] }, match: 'all', conditions: []
      } });
      await rename(originalPath, replacementPath);
      expect(await catalog.synchronizeFolder(sourceRoot.id)).toEqual({ discovered: 0, offline: 0 });
      expect(catalog.listAssets()).toHaveLength(1);
      expect(catalog.listAssets()[0]).toMatchObject({ id: asset.id, rating: 4, offline: false });
      const replacement = catalog.listFolders().find((folder) => folder.name === 'new')!;
      expect(catalog.listSmartCollections().find((item) => item.id === collection.id)?.rule.scope.folderIds).toEqual([replacement.id]);
      expect(catalog.takeExternalRelocations()).toEqual([expect.objectContaining({ assetId: asset.id })]);
      expect(catalog.takeExternalRelocations()).toEqual([]);
    } finally { catalog.close(); }
  });

  it('does not discard edits on a newly indexed child while reconnecting an old folder', async () => {
    const root = await createTemporaryDirectory();
    const source = path.join(root, 'photos');
    const originalPath = path.join(source, 'old');
    const replacementPath = path.join(source, 'new');
    await mkdir(originalPath, { recursive: true });
    await writeFile(path.join(originalPath, 'one.jpg'), 'fixture');
    const catalog = new CatalogService(path.join(root, 'catalog.sqlite'));
    try {
      await catalog.importFolders([source]);
      const old = catalog.listFolders().find((folder) => folder.name === 'old')!;
      const originalId = catalog.listAssets()[0]!.id;
      await rename(originalPath, replacementPath);
      await catalog.synchronizeImportedFile(await realpath(source), 'new/one.jpg');
      const newAsset = catalog.listAssets().find((asset) => asset.id !== originalId)!;
      catalog.updateMetadata({ assetIds: [newAsset.id], rating: 3 });
      await expect(catalog.relinkFolder(old.id, replacementPath)).rejects.toThrow('RELINK_TARGET_HAS_EDITED_ASSETS');
      expect(catalog.listAssets()).toHaveLength(2);
    } finally { catalog.close(); }
  });

  it('persists edits and deletion of default collections after reopening', async () => {
    const root = await createTemporaryDirectory();
    const databasePath = path.join(root, 'catalog.sqlite');
    const catalog = new CatalogService(databasePath);
    const original = catalog.listSmartCollections().find((item) => item.id === 'unrated')!;
    catalog.saveSmartCollection({ id: original.id, name: '尚未打分', rule: original.rule });
    catalog.deleteSmartCollection('recent');
    catalog.close();
    const reopened = new CatalogService(databasePath);
    try {
      expect(reopened.listSmartCollections().find((item) => item.id === 'unrated')?.name).toBe('尚未打分');
      expect(reopened.listSmartCollections().some((item) => item.id === 'recent')).toBe(false);
    } finally { reopened.close(); }
  });

  it('repairs missing collection and EXIF tables even when the schema version is current', async () => {
    const root = await createTemporaryDirectory();
    const databasePath = path.join(root, 'catalog.sqlite');
    new CatalogService(databasePath).close();
    const database = new DatabaseSync(databasePath);
    database.exec('DROP TABLE smart_collections; DROP TABLE asset_exif');
    database.close();
    const repaired = new CatalogService(databasePath);
    try {
      expect(repaired.listSmartCollections()).toHaveLength(6);
      const verification = new DatabaseSync(databasePath);
      expect(verification.prepare('PRAGMA user_version').get()).toEqual({ user_version: 14 });
      expect(verification.prepare("SELECT name FROM sqlite_master WHERE name = 'asset_exif'").get()).toEqual({ name: 'asset_exif' });
      verification.close();
    } finally { repaired.close(); }
  });

  it('unions selected scopes and applies all or any conditions to that union', async () => {
    const root = await createTemporaryDirectory();
    const source = path.join(root, 'photos');
    await mkdir(path.join(source, 'A'), { recursive: true });
    await mkdir(path.join(source, 'B'), { recursive: true });
    await writeFile(path.join(source, 'A', 'keep.jpg'), 'one');
    await writeFile(path.join(source, 'B', 'favorite.jpg'), 'two');
    await writeFile(path.join(source, 'B', 'excluded.png'), 'three');
    const catalog = new CatalogService(path.join(root, 'catalog.sqlite'));
    try {
      await catalog.importFolders([source]);
      const assets = catalog.listAssets();
      const favorite = assets.find((item) => item.fileName === 'favorite.jpg')!;
      catalog.updateMetadata({ assetIds: [favorite.id], favorite: true, rating: 5 });
      const folderA = catalog.listFolders().find((item) => item.name === 'A')!;
      const rule = { version: 1 as const, scope: { all: false, favorites: true, folders: false, albums: false, folderIds: [folderA.id], albumIds: [] }, match: 'all' as const, conditions: [{ field: 'format' as const, operator: 'eq' as const, value: 'jpg' }, { field: 'rating' as const, operator: 'gte' as const, value: 5 }] };
      const saved = catalog.saveSmartCollection({ name: '并集中的高分 JPG', rule });
      expect(catalog.listAssetPage({ smartCollection: saved.id }).items.map((item) => item.fileName)).toEqual(['favorite.jpg']);
      catalog.saveSmartCollection({ id: saved.id, name: saved.name, rule: { ...rule, match: 'any' } });
      expect(catalog.listAssetPage({ smartCollection: saved.id }).items.map((item) => item.fileName).sort()).toEqual(['favorite.jpg', 'keep.jpg']);
      expect(catalog.listSmartCollections().find((item) => item.id === saved.id)?.assetCount).toBe(2);
    } finally { catalog.close(); }
  });

  it('selects all linked folders or albums and matches string patterns', async () => {
    const root = await createTemporaryDirectory();
    const first = path.join(root, 'first');
    const second = path.join(root, 'second');
    await mkdir(first);
    await mkdir(second);
    await writeFile(path.join(first, 'Keep-01.jpg'), 'one');
    await writeFile(path.join(second, 'skip-02.jpg'), 'two');
    const catalog = new CatalogService(path.join(root, 'catalog.sqlite'));
    try {
      await catalog.importFolders([first, second]);
      const keep = catalog.listAssets().find((item) => item.fileName === 'Keep-01.jpg')!;
      const album = catalog.saveAlbum({ name: 'Selected delivery' });
      catalog.updateAlbumAssets({ albumId: album.id, assetIds: [keep.id], mode: 'add' });
      const base = { version: 1 as const, scope: { all: false, favorites: false, folders: true, albums: false, folderIds: [], albumIds: [] }, match: 'all' as const };
      const saved = catalog.saveSmartCollection({ name: 'Pattern', rule: { ...base, conditions: [{ field: 'fileName', operator: 'regex', value: '^keep-\\d+\\.jpg$' }] } });
      expect(catalog.listAssetPage({ smartCollection: saved.id }).items.map((item) => item.id)).toEqual([keep.id]);
      catalog.saveSmartCollection({ id: saved.id, name: saved.name, rule: { ...base, scope: { ...base.scope, folders: false, albums: true }, conditions: [{ field: 'albumName', operator: 'regex', value: 'delivery$' }] } });
      expect(catalog.listAssetPage({ smartCollection: saved.id }).items.map((item) => item.id)).toEqual([keep.id]);
      expect(() => catalog.saveSmartCollection({ name: 'Invalid', rule: { ...base, conditions: [{ field: 'fileName', operator: 'regex', value: '[' }] } })).toThrow('SMART_COLLECTION_INVALID_REGEX');
      expect(() => catalog.saveSmartCollection({ name: 'Slow', rule: { ...base, conditions: [{ field: 'fileName', operator: 'regex', value: '(a+)+$' }] } })).toThrow('SMART_COLLECTION_INVALID_REGEX');
    } finally { catalog.close(); }
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

  it('reports newly discovered files when another file disappears in the same reconciliation', async () => {
    const root = await createTemporaryDirectory();
    const photosDirectory = path.join(root, 'photos');
    await mkdir(photosDirectory, { recursive: true });
    const removedPath = path.join(photosDirectory, 'removed.jpg');
    await writeFile(removedPath, 'removed');
    await writeFile(path.join(photosDirectory, 'kept.jpg'), 'kept');
    const catalog = new CatalogService(path.join(root, 'catalog.sqlite'));
    await expect(catalog.importFolders([photosDirectory])).resolves.toBe(2);
    await unlink(removedPath);
    await writeFile(path.join(photosDirectory, 'new.jpg'), 'new');

    await expect(catalog.reconcileImportedFolders()).resolves.toEqual({ discovered: 1, offline: 1 });
    expect(catalog.listAssets().find((asset) => asset.fileName === 'removed.jpg')?.offline).toBe(true);
    expect(catalog.listAssets().find((asset) => asset.fileName === 'new.jpg')?.offline).toBe(false);
    await expect(catalog.importFolders([photosDirectory])).resolves.toBe(0);
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

  it('synchronizes one imported root without marking unrelated roots offline', async () => {
    const root = await createTemporaryDirectory();
    const first = path.join(root, 'first');
    const second = path.join(root, 'second');
    await mkdir(first);
    await mkdir(second);
    await writeFile(path.join(first, 'first.jpg'), 'first');
    await writeFile(path.join(second, 'second.jpg'), 'second');
    const catalog = new CatalogService(path.join(root, 'catalog.sqlite'));
    await catalog.importFolders([first, second]);
    await unlink(path.join(first, 'first.jpg'));
    await writeFile(path.join(second, 'new.jpg'), 'new');
    await expect(catalog.synchronizeImportedRoot(first)).resolves.toEqual({ discovered: 0, offline: 1 });
    expect(catalog.listAssets().find((asset) => asset.fileName === 'second.jpg')?.offline).toBe(false);
    expect(catalog.listAssets().find((asset) => asset.fileName === 'new.jpg')).toBeUndefined();
    await expect(catalog.synchronizeImportedRoot(second)).resolves.toEqual({ discovered: 1, offline: 0 });
    catalog.close();
  });

  it('updates a changed file without scanning unrelated files', async () => {
    const root = await createTemporaryDirectory();
    const photos = path.join(root, 'photos');
    await mkdir(photos);
    const first = path.join(photos, 'first.jpg');
    const second = path.join(photos, 'second.jpg');
    await writeFile(first, 'old');
    await writeFile(second, 'other');
    const catalog = new CatalogService(path.join(root, 'catalog.sqlite'));
    await catalog.importFolders([photos]);
    const original = catalog.listAssets().find((asset) => asset.fileName === 'first.jpg')!;
    await writeFile(first, 'longer new content');
    await catalog.synchronizeImportedFile(await realpath(photos), 'first.jpg');
    const updated = catalog.listAssets().find((asset) => asset.fileName === 'first.jpg')!;
    expect(updated.id).toBe(original.id);
    expect(updated.sizeBytes).toBeGreaterThan(original.sizeBytes);
    expect(catalog.listAssets().find((asset) => asset.fileName === 'second.jpg')?.offline).toBe(false);
    await unlink(first);
    await catalog.synchronizeImportedFile(await realpath(photos), 'first.jpg');
    expect(catalog.listAssets().find((asset) => asset.fileName === 'first.jpg')?.offline).toBe(true);
    await expect(catalog.synchronizeImportedFile(await realpath(photos), '../outside.jpg')).rejects.toThrow('INVALID_WATCH_PATH');
    await mkdir(path.join(photos, '_PhotoAllIsAI'));
    await writeFile(path.join(photos, '_PhotoAllIsAI', 'generated.jpg'), 'generated');
    await catalog.synchronizeImportedFile(await realpath(photos), '_PhotoAllIsAI/generated.jpg');
    expect(catalog.listAssets().some((asset) => asset.fileName === 'generated.jpg')).toBe(false);
    catalog.close();
  });

  it('reconciles a renamed file within its parent directory and preserves unrelated directories', async () => {
    const root = await createTemporaryDirectory();
    const photos = path.join(root, 'photos');
    const a = path.join(photos, 'a');
    const b = path.join(photos, 'b');
    await mkdir(a, { recursive: true });
    await mkdir(b);
    const oldPath = path.join(a, 'old.jpg');
    await writeFile(oldPath, 'old');
    await writeFile(path.join(b, 'unrelated.jpg'), 'other');
    const catalog = new CatalogService(path.join(root, 'catalog.sqlite'));
    await catalog.importFolders([photos]);
    await rename(oldPath, path.join(a, 'new.jpg'));
    await writeFile(path.join(b, 'unseen.jpg'), 'unseen');
    const canonical = await realpath(photos);
    expect(await catalog.synchronizeImportedDirectory(canonical, 'a/new.jpg')).toBe(true);
    expect(catalog.listAssets().find((asset) => asset.fileName === 'old.jpg')?.offline).toBe(true);
    expect(catalog.listAssets().find((asset) => asset.fileName === 'new.jpg')?.offline).toBe(false);
    expect(catalog.listAssets().find((asset) => asset.fileName === 'unseen.jpg')).toBeUndefined();
    expect(catalog.listAssets().find((asset) => asset.fileName === 'unrelated.jpg')?.offline).toBe(false);
    catalog.close();
  });

  it('requires a root scan when a watched rename points to a moved directory', async () => {
    const root = await createTemporaryDirectory();
    const photos = path.join(root, 'photos');
    const child = path.join(photos, 'child');
    await mkdir(child, { recursive: true });
    await writeFile(path.join(child, 'photo.jpg'), 'photo');
    const catalog = new CatalogService(path.join(root, 'catalog.sqlite'));
    await catalog.importFolders([photos]);
    const canonical = await realpath(photos);
    await rename(child, path.join(photos, 'moved'));
    expect(await catalog.synchronizeImportedDirectory(canonical, 'child')).toBe(false);
    expect(await catalog.synchronizeImportedDirectory(canonical, 'moved')).toBe(false);
    catalog.close();
  });

  it('escalates a rename of an indexed empty directory', async () => {
    const root = await createTemporaryDirectory();
    const photos = path.join(root, 'photos');
    await mkdir(photos);
    const catalog = new CatalogService(path.join(root, 'catalog.sqlite'));
    await catalog.importFolders([photos]);
    const parent = catalog.listFolders()[0]!;
    const empty = (await catalog.createFolder({ parentFolderId: parent.id })).folder;
    const originalPath = catalog.resolveFolderPath(empty.id)!;
    await rename(originalPath, path.join(photos, 'renamed-empty'));
    expect(await catalog.synchronizeImportedDirectory(await realpath(photos), path.basename(originalPath))).toBe(false);
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

  it('counts reappearing and newly discovered files while preserving asset identity', async () => {
    const root = await createTemporaryDirectory();
    const photos = path.join(root, 'photos');
    await mkdir(photos);
    const oldPath = path.join(photos, 'old.jpg');
    await writeFile(oldPath, 'old');
    const catalog = new CatalogService(path.join(root, 'catalog.sqlite'));
    expect(await catalog.importFolders([photos])).toBe(1);
    const id = catalog.listAssets()[0]!.id;
    await unlink(oldPath);
    await catalog.synchronizeImportedFile(await realpath(photos), 'old.jpg');
    await writeFile(oldPath, 'restored');
    await writeFile(path.join(photos, 'new.jpg'), 'new');
    expect(await catalog.importFolders([photos])).toBe(1);
    expect(await catalog.importFolders([photos])).toBe(0);
    expect(catalog.listAssets().find((asset) => asset.fileName === 'old.jpg')).toMatchObject({ id, offline: false });
    catalog.close();
  });
});
