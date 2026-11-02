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

test('loads cursor pages automatically near the gallery end', async () => {
  await page.locator('.catalog-card').first().dblclick();
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-catalog-tool="count"]')).toContainText('205 张');
  await expect(page.getByRole('button', { name: /最近 30 天 0/ })).toBeVisible();
  await page.getByRole('button', { name: /最近 30 天 0/ }).click();
  await expect(page.getByText('此集合为空')).toBeVisible();
  const allPhotos = page.getByRole('button', { name: /所有照片 205/ });
  await expect(allPhotos).not.toHaveClass(/is-active/);
  await expect(page.locator('.library-summary')).toContainText('1 个文件夹 · 205 张照片');
  await allPhotos.click();
  const options = page.locator('.catalog-card');
  await expect.poll(() => options.count()).toBeGreaterThan(0);
  await options.nth(0).click();
  await options.nth(1).click({ modifiers: ['Meta'] });
  await options.nth(1).click({ button: 'right' });
  await expect(page.getByRole('menu', { name: '照片菜单 2 张' })).toBeVisible();
  await page.getByRole('menuitem', { name: '添加到收藏' }).click();
  await expect(page.locator('.operation-toast')).toContainText('已收藏 2 张照片');
  await expect(page.getByRole('button', { name: /收藏 2/ })).toBeVisible();
  await page.screenshot({ path: 'test-results/catalog-batch-favorite.png', animations: 'disabled' });
  const gallery = page.locator('.catalog-grid');
  await expect(options).toHaveCount(200);
  await gallery.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await expect(options).toHaveCount(205);
  await expect(options.filter({ hasText: 'PAGE_204.jpg' })).toHaveCount(1);
});

test('grouping keeps later pages deferred until the gallery is scrolled', async () => {
  await page.reload();
  await expect(page.locator('.catalog-card')).toHaveCount(200);
  await page.getByRole('button', { name: '配置图库工具栏', exact: true }).click();
  await page.getByRole('checkbox', { name: '分组:月份', exact: true }).click();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '按月份分组', exact: true }).click();
  await expect(page.locator('.catalog-card')).toHaveCount(200);
  await expect(page.locator('.catalog-photo-group')).toHaveCount(1);
  await expect(page.locator('.catalog-group-heading')).toContainText('1970-01');
  await page.locator('.catalog-grid').evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await expect(page.locator('.catalog-card')).toHaveCount(205);
  await page.getByRole('button', { name: '按月份分组', exact: true }).click();
});

test('loads the next page in list view without a manual button click', async () => {
  await page.reload();
  await expect(page.locator('.catalog-card')).toHaveCount(200);
  await page.getByRole('button', { name: '配置图库工具栏', exact: true }).click();
  await page.getByRole('checkbox', { name: '视图', exact: true }).check();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '列表视图', exact: true }).click();
  await expect(page.locator('.catalog-list-row')).toHaveCount(200);
  await page.locator('.catalog-list-view').evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await expect(page.locator('.catalog-list-row')).toHaveCount(205);
});
