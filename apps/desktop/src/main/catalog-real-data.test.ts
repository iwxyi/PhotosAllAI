import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { CatalogService, isSupportedImage } from './catalog-service';

const configuredRoot = process.env.PHOTOALLISAI_TEST_DATA;
const suite = configuredRoot ? describe : describe.skip;
let temporaryDirectory: string | null = null;

suite('real photo catalog', () => {
  it('indexes and paginates the complete supplied library without modifying source files', { timeout: 120_000 }, async () => {
    const source = path.resolve(configuredRoot!);
    const sourceBefore = await inventoryFiles(source);
    const expectedImages = sourceBefore.filter((file) => isSupportedImage(file.relativePath));
    const expectedExtensions = countByExtension(expectedImages.map((file) => file.relativePath));
    temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'photoallisai-real-data-'));
    const catalog = new CatalogService(path.join(temporaryDirectory, 'catalog.sqlite'));

    const imported = await catalog.importFolders([source]);
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
      expect(fileNames.every((fileName) => isSupportedImage(fileName))).toBe(true);
      expect(countByExtension(fileNames)).toEqual(expectedExtensions);
    }
    expect(catalog.listFolders()).toEqual([
      expect.objectContaining({ name: path.basename(source), assetCount: imported })
    ]);
    expect(await inventoryFiles(source)).toEqual(sourceBefore);
    catalog.close();
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
