import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterAll, describe, expect, it } from 'vitest';

import { CatalogService } from './catalog-service';
import { isSupportedBrowseMedia } from './media-format-registry';

const configuredRoot = process.env.PHOTOALLISAI_TEST_DATA;
const recheckDatabase = process.env.PHOTOALLISAI_RECHECK_DATABASE;
const suite = configuredRoot ? describe : describe.skip;
let temporaryDirectory: string | null = null;

suite('real photo catalog', () => {
  it('indexes and paginates the complete supplied library without modifying source files', { timeout: 900_000 }, async () => {
    const source = path.resolve(configuredRoot!);
    const sourceBefore = await inventoryFiles(source);
    const expectedImages = sourceBefore.filter((file) => isSupportedBrowseMedia(file.relativePath)
      && file.relativePath.split(path.sep).every((part) => !part.startsWith('.') && !['_PhotoAllIsAI', 'node_modules'].includes(part)));
    const expectedExtensions = countByExtension(expectedImages.map((file) => file.relativePath));
    temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'photoallisai-real-data-'));
    const catalog = new CatalogService(path.join(temporaryDirectory, 'catalog.sqlite'));

    const importStarted = performance.now();
    const imported = await catalog.importFolders([source]);
    const importMs = performance.now() - importStarted;
    expect(imported).toBe(expectedImages.length);
    expect(imported).toBeGreaterThan(0);
    for (const sortBy of ['modifiedAt', 'fileName', 'rating'] as const) {
      const assetIds = new Set<string>();
      const fileNames: string[] = [];
      let cursor = null;
      do {
        const page = catalog.listAssetPage({ folderId: null, cursor, limit: 200, sortBy });
        expect(page.totalCount).toBe(imported);
        for (const asset of page.items) {
          assetIds.add(asset.id);
          fileNames.push(asset.fileName);
        }
        cursor = page.nextCursor;
      } while (cursor);
      expect(fileNames).toHaveLength(imported);
      expect(assetIds.size).toBe(imported);
      expect(fileNames.every((fileName) => isSupportedBrowseMedia(fileName))).toBe(true);
      expect(countByExtension(fileNames)).toEqual(expectedExtensions);
    }
    const folderStarted = performance.now();
    const folders = catalog.listFolders();
    const coldFoldersMs = performance.now() - folderStarted;
    const warmStarted = performance.now();
    catalog.listFolders();
    const warmFoldersMs = performance.now() - warmStarted;
    const smallFolder = folders.find((folder) => !folder.isRoot && folder.assetCount >= 20 && folder.assetCount <= 100);
    const smallStarted = performance.now();
    if (smallFolder) catalog.listAssetPage({ folderId: smallFolder.id, cursor: null, limit: 100 });
    const smallPageMs = performance.now() - smallStarted;
    const repeatedPageStarted = performance.now();
    if (smallFolder) catalog.listAssetPage({ folderId: smallFolder.id, cursor: null, limit: 100 });
    const repeatedPageMs = performance.now() - repeatedPageStarted;
    const collectionsStarted = performance.now();
    catalog.listSmartCollections();
    const collectionsMs = performance.now() - collectionsStarted;
    const otherConnection = new DatabaseSync(path.join(temporaryDirectory, 'catalog.sqlite'));
    otherConnection.prepare('INSERT INTO asset_exif (asset_id, source_size, source_modified_at) SELECT id, size_bytes, modified_at FROM assets LIMIT 1').run();
    otherConnection.close();
    const invalidatedStarted = performance.now();
    catalog.listFolders();
    const invalidatedFoldersMs = performance.now() - invalidatedStarted;
    console.log(JSON.stringify({ phase: 'real-catalog-timing', imported, importMs: Math.round(importMs), folderCount: folders.length, coldFoldersMs: Math.round(coldFoldersMs), warmFoldersMs: Math.round(warmFoldersMs), invalidatedFoldersMs: Math.round(invalidatedFoldersMs), smallFolder: smallFolder?.name, smallPageMs: Math.round(smallPageMs), repeatedPageMs: Math.round(repeatedPageMs), collectionsMs: Math.round(collectionsMs) }));
    expect(folders.filter((folder) => folder.isRoot)).toEqual([
      expect.objectContaining({ name: path.basename(source), assetCount: imported, parentId: null })
    ]);
    expect(folders.filter((folder) => !folder.isRoot).every((folder) => folders.some((parent) => parent.id === folder.parentId && parent.depth === folder.depth - 1))).toBe(true);
    expect(await inventoryFiles(source)).toEqual(sourceBefore);
    catalog.close();
  });
});

(configuredRoot && recheckDatabase ? describe : describe.skip)('real catalog recheck performance', () => {
  it('measures a full recheck on a disposable database copy', { timeout: 900_000 }, async () => {
    const catalog = new CatalogService(recheckDatabase!);
    const delays: number[] = [];
    let expected = performance.now() + 10;
    const timer = setInterval(() => {
      const now = performance.now();
      delays.push(Math.max(0, now - expected));
      expected = now + 10;
    }, 10);
    try {
      const started = performance.now();
      const result = await catalog.synchronizeImportedRoot(path.resolve(configuredRoot!));
      delays.sort((left, right) => left - right);
      console.log(JSON.stringify({ phase: 'real-catalog-recheck', elapsedMs: Math.round(performance.now() - started), result, ticks: delays.length,
        eventLoopP95Ms: Math.round(delays[Math.floor(delays.length * 0.95)] ?? 0), eventLoopMaxMs: Math.round(delays.at(-1) ?? 0),
        stallsOver50Ms: delays.filter((delay) => delay > 50).length, stallsOver100Ms: delays.filter((delay) => delay > 100).length }));
    } finally {
      clearInterval(timer);
      catalog.close();
    }
  });
});

type FileInventoryEntry = { relativePath: string; size: number; modifiedAt: number };

async function inventoryFiles(root: string): Promise<FileInventoryEntry[]> {
  const files: FileInventoryEntry[] = [];
  const directories = [root];
  while (directories.length > 0) {
    const directory = directories.pop()!;
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const filePath = path.join(directory, entry.name);
      if (entry.isDirectory()) directories.push(filePath);
      else if (entry.isFile()) {
        const metadata = await stat(filePath);
        files.push({
          relativePath: path.relative(root, filePath),
          size: metadata.size,
          modifiedAt: metadata.mtimeMs
        });
      }
    }
  }
  return files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

function countByExtension(fileNames: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const fileName of fileNames) {
    const extension = path.extname(fileName).toLowerCase();
    counts[extension] = (counts[extension] ?? 0) + 1;
  }
  return counts;
}

afterAll(async () => {
  if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
});
