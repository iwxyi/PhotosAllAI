import { createRequire } from 'node:module';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { _electron as electron, expect, test } from '@playwright/test';

import { CatalogService } from '../../apps/desktop/src/main/catalog-service';

const sharp = createRequire(path.resolve('apps/desktop/package.json'))('sharp');

test('imports and previews TIFF with the bundled decoder', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'photoallisai-tiff-preview-'));
  const source = path.join(root, 'photos');
  const userData = path.join(root, 'user-data');
  let application: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    await mkdir(source, { recursive: true });
    const filePath = path.join(source, 'camera.tiff');
    await sharp({ create: { width: 720, height: 480, channels: 3, background: '#4277aa' } }).tiff().toFile(filePath);
    const databasePath = path.join(userData, 'library', 'catalog.sqlite');
    await mkdir(path.dirname(databasePath), { recursive: true });
    const catalog = new CatalogService(databasePath);
    await catalog.importFolders([source]);
    catalog.close();

    application = await electron.launch({
      args: [path.resolve('apps/desktop/out/main/index.js')],
      env: { ...process.env, PHOTOALLISAI_USER_DATA: userData }
    });
    const page = await application.firstWindow();
    const card = page.locator('.catalog-card').first();
    await expect(card).toBeVisible();
    await expect.poll(() => card.locator('img').evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
    await card.dblclick();
    await expect(page.getByRole('region', { name: '看图', exact: true })).toBeVisible();
    await expect.poll(() => page.locator('.photo-canvas img.base-image').evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
  } finally {
    if (application) await application.close();
    await rm(root, { recursive: true, force: true });
  }
});
