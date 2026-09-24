import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';

import { CatalogService } from '../../apps/desktop/src/main/catalog-service';

let electronApp: ElectronApplication;
let page: Page;
let testRoot: string;

test.beforeAll(async () => {
  testRoot = await mkdtemp(path.join(tmpdir(), 'photoallisai-pagination-e2e-'));
  const userData = path.join(testRoot, 'user-data');
  const libraryDirectory = path.join(userData, 'library');
  await mkdir(libraryDirectory, { recursive: true });
  const databasePath = path.join(libraryDirectory, 'catalog.sqlite');
  const migration = new CatalogService(databasePath);
  migration.close();
  const database = new DatabaseSync(databasePath);
  database.prepare('INSERT INTO folders (id, path, name, imported_at) VALUES (?, ?, ?, ?)')
    .run('folder-page', '/fixture/page', 'Paged Catalog', 1);
  const insert = database.prepare(`
    INSERT INTO assets (id, folder_id, path, file_name, extension, size_bytes, modified_at, imported_at)
    VALUES (?, 'folder-page', ?, ?, '.jpg', 1024, ?, 1)
  `);
  database.exec('BEGIN IMMEDIATE');
  for (let index = 0; index < 205; index += 1) {
    const name = `PAGE_${String(index).padStart(3, '0')}.jpg`;
    insert.run(`asset-page-${String(index).padStart(3, '0')}`, `/fixture/page/${name}`, name, 10_000 - index);
  }
  database.exec('COMMIT');
  database.close();

  electronApp = await electron.launch({
    args: [path.resolve('apps/desktop/out/main/index.js')],
    env: { ...process.env, PHOTOALLISAI_USER_DATA: userData }
  });
  page = await electronApp.firstWindow();
  await page.waitForLoadState('domcontentloaded');
});

test.afterAll(async () => {
  if (electronApp) await electronApp.close();
  await rm(testRoot, { recursive: true, force: true });
});

test('loads cursor pages at the virtualized filmstrip boundary', async () => {
  await page.locator('.catalog-card').first().dblclick();
  await expect(page.getByText('205 张照片', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /最近 30 天 0/ })).toBeVisible();
  await page.getByRole('button', { name: /最近 30 天 0/ }).click();
  await expect(page.getByText('此集合为空')).toBeVisible();
  const allPhotos = page.getByRole('button', { name: /所有照片 205/ });
  await expect(allPhotos).not.toHaveClass(/is-active/);
  await expect(page.locator('.library-summary')).toContainText('1 个文件夹 · 205 张照片');
  await allPhotos.click();
  const options = page.locator('.filmstrip [role="option"]');
  expect(await options.count()).toBeLessThan(30);
  await options.nth(0).click();
  await options.nth(1).click({ modifiers: ['Meta'] });
  await options.nth(1).click({ button: 'right' });
  await expect(page.getByRole('menu', { name: '照片菜单 2 张' })).toBeVisible();
  await page.getByRole('menuitem', { name: '标记为首选' }).click();
  await expect(page.getByRole('status')).toContainText('已收藏 2 张照片');
  await expect(page.getByRole('button', { name: /首选 2/ })).toBeVisible();
  await page.screenshot({ path: 'test-results/catalog-batch-favorite.png', animations: 'disabled' });
  const filmstrip = page.locator('.filmstrip');
  await filmstrip.evaluate((element) => { element.scrollLeft = element.scrollWidth; });
  await expect(page.getByRole('button', { name: /更多|加载中/ })).toHaveCount(0);

  await filmstrip.evaluate((element) => { element.scrollLeft = element.scrollWidth; });
  await expect(page.getByRole('option').filter({ hasText: 'PAGE_204.jpg' })).toBeVisible();
  expect(await options.count()).toBeLessThan(30);
});
