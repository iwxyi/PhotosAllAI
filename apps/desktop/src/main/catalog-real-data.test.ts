import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { CatalogService, isSupportedImage } from './catalog-service';

const configuredRoot = process.env.PHOTOALLISAI_TEST_DATA;
const suite = configuredRoot ? describe : describe.skip;
let temporaryDirectory: string | null = null;

suite('real photo catalog', () => {
  it('indexes the supplied library without modifying source files', { timeout: 120_000 }, async () => {
    const source = path.resolve(configuredRoot!);
    const sourceBefore = await stat(source);
    temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'photoallisai-real-data-'));
    const catalog = new CatalogService(path.join(temporaryDirectory, 'catalog.sqlite'));

    const imported = await catalog.importFolders([source]);
    const firstPage = catalog.listAssetPage({ folderId: null, cursor: null, limit: 200 });
    expect(imported).toBeGreaterThan(0);
    expect(firstPage.totalCount).toBe(imported);
    expect(firstPage.items).toHaveLength(Math.min(200, imported));
    expect(firstPage.items.every((asset) => isSupportedImage(asset.fileName))).toBe(true);
    expect(catalog.listFolders()).toEqual([
      expect.objectContaining({ name: path.basename(source), assetCount: imported })
    ]);
    expect((await stat(source)).mtimeMs).toBe(sourceBefore.mtimeMs);
    catalog.close();
  });
});

afterAll(async () => {
  if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
});
