import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
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
    expect(catalog.listFolders()).toEqual([{ id: assets[0]?.folderId, name: 'photos', assetCount: 2 }]);
    const updated = catalog.updateMetadata({ assetIds: assets.map((asset) => asset.id), rating: 4 });
    expect(updated.every((asset) => asset.rating === 4)).toBe(true);
    const firstPage = catalog.listAssetPage({ folderId: null, cursor: null, limit: 1 });
    const secondPage = catalog.listAssetPage({ folderId: null, cursor: firstPage.nextCursor, limit: 1 });
    expect(firstPage.totalCount).toBe(2);
    expect(firstPage.nextCursor).not.toBeNull();
    expect(secondPage.items).toHaveLength(1);
    expect(secondPage.items[0]?.id).not.toBe(firstPage.items[0]?.id);
    expect(secondPage.nextCursor).toBeNull();
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
    expect(assets.find((asset) => asset.fileName === 'visible.jpg')?.thumbnailUrl).toMatch(/^photoasset:\/\/thumbnail/);
    expect(assets.find((asset) => asset.fileName === 'raw.NEF')?.previewUrl).toMatch(/^photoasset:\/\/preview/);
    catalog.close();
  });
});
