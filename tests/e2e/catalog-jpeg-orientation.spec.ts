import path from 'node:path';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';
import { _electron as electron, expect, test } from '@playwright/test';
import { CatalogService } from '../../apps/desktop/src/main/catalog-service';
import { ImageFileService } from '../../apps/desktop/src/main/image-file-service';
import { galleryInspectionScript } from '../../apps/desktop/src/main/gallery-inspection';

const sharp = createRequire(path.resolve('apps/desktop/package.json'))('sharp') as typeof import('../../apps/desktop/node_modules/sharp');

test('legacy sideways JPEG dimensions are repaired before a portrait enters the waterfall', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'photo-jpeg-orientation-'));
  const userData = path.join(root, 'user-data');
  const photos = path.join(root, 'photos');
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    await mkdir(path.join(userData, 'library'), { recursive: true });
    await mkdir(photos);
    await sharp(path.resolve('apps/desktop/src/renderer/public/demo/coast.jpg')).resize(600, 400, { fit: 'fill' }).withMetadata({ orientation: 8 }).toFile(path.join(photos, 'rotated.jpg'));
    const databasePath = path.join(userData, 'library', 'catalog.sqlite');
    const catalog = new CatalogService(databasePath);
    await catalog.importFolders([photos]);
    const asset = catalog.listAssetPage({}).items[0]!;
    const details = await new ImageFileService(catalog).details(asset.id);
    expect([details.width, details.height]).toEqual([400, 600]);
    catalog.saveDimensions(asset.id, 600, 400);
    catalog.close();
    const database = new DatabaseSync(databasePath);
    database.exec('UPDATE asset_exif SET dimension_version = 0');
    database.close();
    app = await electron.launch({ args: [path.resolve('apps/desktop/out/main/index.js')], env: { ...process.env, PHOTOALLISAI_USER_DATA: userData } });
    const page = await app.firstWindow();
    await page.evaluate(() => localStorage.setItem('photoallisai.catalog-view-mode', 'masonry'));
    await page.reload();
    await expect.poll(() => {
      const check = new DatabaseSync(databasePath);
      try {
        return check.prepare('SELECT width, height, dimension_version FROM asset_exif LIMIT 1').get();
      } finally { check.close(); }
    }).toEqual({ width: 400, height: 600, dimension_version: 1 });
    const card = page.locator('.catalog-masonry .catalog-card').first();
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(card.locator('img:not(.catalog-image-previous)')).toHaveClass(/is-ready/);
    const inspection = await page.evaluate(galleryInspectionScript) as { images: Array<{ indexed: { width: number; height: number }; decoded: { width: number; height: number }; frame: { width: number; height: number }; ratioMismatch: string | null }> };
    expect(inspection.images[0]).toMatchObject({ indexed: { width: 400, height: 600 }, ratioMismatch: null });
    expect(inspection.images[0]!.decoded.height).toBeGreaterThan(inspection.images[0]!.decoded.width);
    expect(inspection.images[0]!.frame.height).toBeGreaterThan(inspection.images[0]!.frame.width);
  } finally {
    await app?.close();
    await rm(root, { recursive: true, force: true });
  }
});
