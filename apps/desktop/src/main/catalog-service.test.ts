import { mkdtemp, mkdir, realpath, rm, unlink, writeFile } from 'node:fs/promises';
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
});
