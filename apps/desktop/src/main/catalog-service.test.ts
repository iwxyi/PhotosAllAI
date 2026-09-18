import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

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

    const catalog = new CatalogService(path.join(root, 'catalog.sqlite'));
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
    expect(assets.find((asset) => asset.fileName === 'visible.jpg')?.thumbnailUrl).toMatch(/^photoasset:\/\/thumbnail/);
    expect(assets.find((asset) => asset.fileName === 'raw.NEF')?.previewUrl).toMatch(/^photoasset:\/\/preview/);
    catalog.close();
  });
});
