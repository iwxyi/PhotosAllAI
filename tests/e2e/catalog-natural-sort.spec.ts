import path from 'node:path';
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { _electron as electron, expect, test } from '@playwright/test';
import { CatalogService } from '../../apps/desktop/src/main/catalog-service';

test('gallery files and nested linked folders use natural name order', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'photoallisai-natural-sort-'));
  const userData = path.join(directory, 'user-data');
  const photos = path.join(directory, 'photos');
  const fixture = path.resolve('apps/desktop/src/renderer/public/demo/portrait.jpg');
  await mkdir(path.join(userData, 'library'), { recursive: true });
  for (const name of ['导出2', '导出10']) {
    await mkdir(path.join(photos, name), { recursive: true });
    await copyFile(fixture, path.join(photos, name, `${name}.jpg`));
  }
  const catalog = new CatalogService(path.join(userData, 'library', 'catalog.sqlite'));
  await catalog.importFolders([photos]);
  catalog.close();
  const app = await electron.launch({ args: [path.resolve('apps/desktop/out/main/index.js')], env: { ...process.env, PHOTOALLISAI_USER_DATA: userData } });
  try {
    const page = await app.firstWindow();
    await expect(page.locator('.folder-row[role="treeitem"]')).toHaveCount(1);
    await page.getByRole('button', { name: '展开 photos' }).click();
    await expect(page.locator('.folder-row[role="treeitem"]')).toHaveCount(3);
    expect(await page.locator('.folder-row[role="treeitem"] > span:not(.row-count)').allTextContents()).toEqual(['photos', '导出2', '导出10']);
    await expect(page.locator('.catalog-card-meta strong')).toHaveText(['导出2.jpg', '导出10.jpg']);
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
