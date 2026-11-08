import { execFile as execFileCallback } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { _electron as electron, expect, test } from '@playwright/test';

import { CatalogService } from '../../apps/desktop/src/main/catalog-service';

const execFile = promisify(execFileCallback);

test('imports and previews a macOS encoded HEIC image', async () => {
  test.skip(process.platform !== 'darwin', 'This fixture uses macOS sips to encode HEIC');
  const root = await mkdtemp(path.join(tmpdir(), 'photoallisai-heic-preview-'));
  const source = path.join(root, 'photos');
  const userData = path.join(root, 'user-data');
  let application: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    await mkdir(source, { recursive: true });
    const jpeg = path.join(source, 'camera.jpg');
    const heic = path.join(source, 'camera.heic');
    await copyFile(path.resolve('apps/desktop/src/renderer/public/demo/portrait.jpg'), jpeg);
    await execFile('sips', ['-s', 'format', 'heic', jpeg, '--out', heic]);
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
    const card = page.locator('.catalog-card').filter({ hasText: 'camera.heic' });
    await expect(card).toBeVisible();
    await expect.poll(() => card.locator('img').evaluate((image: HTMLImageElement) => image.naturalWidth), { timeout: 15_000 }).toBeGreaterThan(0);
    await card.dblclick();
    await expect(page.getByRole('region', { name: '看图', exact: true })).toBeVisible();
    await expect.poll(() => page.locator('.photo-canvas img.base-image').evaluate((image: HTMLImageElement) => image.naturalWidth), { timeout: 15_000 }).toBeGreaterThan(0);
  } finally {
    if (application) await application.close();
    await rm(root, { recursive: true, force: true });
  }
});
