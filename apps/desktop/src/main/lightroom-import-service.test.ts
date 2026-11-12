import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it } from 'vitest';
import { CatalogService } from './catalog-service';
import { LightroomImportService } from './lightroom-import-service';

const roots: string[] = [];

afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

it('previews and imports only linked files through a relocated root mapping', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'photoallisai-lightroom-'));
  roots.push(root);
  const catalogRoot = path.join(root, 'Current');
  const firstPath = path.join(catalogRoot, 'Shoot', 'one.jpg');
  const ambiguousA = path.join(catalogRoot, 'A', 'same.jpg');
  const ambiguousB = path.join(catalogRoot, 'B', 'same.jpg');
  for (const file of [firstPath, ambiguousA, ambiguousB]) {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, 'image');
  }
  const catalog = new CatalogService(path.join(root, 'app.sqlite'));
  const lrPath = path.join(root, 'Lightroom.lrcat');
  try {
    await catalog.importFolders([catalogRoot]);
    const lightroom = new DatabaseSync(lrPath);
    lightroom.exec("CREATE TABLE AgLibraryRootFolder(id_local INTEGER PRIMARY KEY, absolutePath TEXT); CREATE TABLE AgLibraryFolder(id_local INTEGER PRIMARY KEY, pathFromRoot TEXT, rootFolder INTEGER); CREATE TABLE AgLibraryFile(id_local INTEGER PRIMARY KEY, baseName TEXT, extension TEXT, folder INTEGER); CREATE TABLE Adobe_images(id_local INTEGER PRIMARY KEY, rootFile INTEGER, rating REAL, colorLabels TEXT, masterImage INTEGER); INSERT INTO AgLibraryRootFolder VALUES(1, '/OldRoot/'); INSERT INTO AgLibraryFolder VALUES(1, 'Shoot/', 1); INSERT INTO AgLibraryFolder VALUES(2, 'A/', 1); INSERT INTO AgLibraryFolder VALUES(3, 'B/', 1); INSERT INTO AgLibraryFile VALUES(1, 'one', 'jpg', 1); INSERT INTO AgLibraryFile VALUES(2, 'same', 'jpg', 2); INSERT INTO AgLibraryFile VALUES(3, 'same', 'jpg', 3); INSERT INTO Adobe_images VALUES(1, 1, 4, '黄色', NULL); INSERT INTO Adobe_images VALUES(2, 2, 5, '紫色', NULL); INSERT INTO Adobe_images VALUES(3, 3, 3, '红色', NULL);");
    lightroom.close();
    const importer = new LightroomImportService(catalog);
    const sourceRoots = importer.select(lrPath);
    const preview = importer.preview({
      catalogName: 'Lightroom.lrcat',
      mappings: [{ sourceRoot: sourceRoots[0]!, targetRoot: catalogRoot }],
      policy: 'fill-empty'
    });
    expect(preview).toMatchObject({ sourceCount: 3, linkedCount: 3, matchedCount: 3, changedCount: 3, ambiguousCount: 0, unmatchedCount: 0 });
    expect(preview.examples.find((item) => item.fileName === 'one.jpg')).toMatchObject({ ratingAfter: 4, colorAfter: 'yellow' });
    expect(importer.apply(preview.token)).toEqual({ updated: 3, skipped: 0 });
    const assets = catalog.listAssets();
    expect(assets.find((asset) => asset.fileName === 'one.jpg')).toMatchObject({ rating: 4, labelColor: 'yellow' });
    expect(assets.filter((asset) => asset.fileName === 'same.jpg').every((asset) => asset.rating > 0)).toBe(true);
    expect(() => importer.apply(preview.token)).toThrow('预览已失效');
  } finally { catalog.close(); }
});
