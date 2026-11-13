import { mkdir, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';

import { CatalogService } from '../../apps/desktop/src/main/catalog-service';

test('hides offline photos from the gallery while keeping folder recovery available', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'photoallisai-offline-gallery-'));
  const source = path.join(root, 'photos');
  const userData = path.join(root, 'user-data');
  const database = path.join(userData, 'library', 'catalog.sqlite');
  const oldFile = path.join(source, 'old.jpg');
  const currentFile = path.join(source, 'current.jpg');
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    await mkdir(source, { recursive: true });
    await mkdir(path.dirname(database), { recursive: true });
    await writeFile(oldFile, 'old');
    await writeFile(currentFile, 'current');
    const catalog = new CatalogService(database);
    await catalog.importFolders([source]);
    await unlink(oldFile);
    await catalog.synchronizeImportedRoot(source);
    catalog.close();

    app = await electron.launch({ args: [path.resolve('apps/desktop/out/main/index.js')], env: { ...process.env, PHOTOALLISAI_USER_DATA: userData } });
    const page = await app.firstWindow();
    await expect(page.locator('.catalog-card')).toHaveCount(1);
    await expect(page.locator('.catalog-card-meta strong')).toHaveText('current.jpg');
    await expect(page.locator('[data-catalog-tool="count"]')).toContainText('1 张');
    await expect(page.locator('.folder-row').filter({ hasText: 'photos' }).locator('.row-count')).toHaveText('1');
  } finally {
    await app?.close();
    await rm(root, { recursive: true, force: true });
  }
});
