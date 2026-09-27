import { copyFile, mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';

import { CatalogService } from '../../apps/desktop/src/main/catalog-service';

let app: ElectronApplication;
let page: Page;
let testRoot: string;

test.beforeAll(async () => {
  testRoot = await mkdtemp(path.join(tmpdir(), 'photoallisai-tree-e2e-'));
  const source = path.join(testRoot, 'source');
  await mkdir(path.join(source, 'parent', 'child'), { recursive: true });
  await mkdir(path.join(source, 'target'), { recursive: true });
  const fixture = path.resolve('apps/desktop/src/renderer/public/demo/portrait.jpg');
  await copyFile(fixture, path.join(source, 'parent', 'parent.jpg'));
  await copyFile(fixture, path.join(source, 'parent', 'child', 'child.jpg'));
  await copyFile(fixture, path.join(source, 'target', 'target.jpg'));
  const userData = path.join(testRoot, 'user-data');
  const library = path.join(userData, 'library');
  await mkdir(library, { recursive: true });
  const catalog = new CatalogService(path.join(library, 'catalog.sqlite'));
  await catalog.importFolders([source]);
  catalog.close();
  app = await electron.launch({ args: [path.resolve('apps/desktop/out/main/index.js')], env: { ...process.env, PHOTOALLISAI_USER_DATA: userData } });
  page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
});

test.afterAll(async () => {
  if (app) await app.close();
  if (testRoot) await rm(testRoot, { recursive: true, force: true });
});

test('expands nested folders and keeps icon colors independent', async () => {
  await expect(page.getByRole('tree', { name: '关联文件夹' })).toBeVisible();
  const root = page.locator('.folder-entry').filter({ has: page.locator('.folder-row', { hasText: 'source' }) });
  await expect(root).toBeVisible();
  await root.locator('.folder-row').click({ button: 'right' });
  const rootMenu = page.getByRole('menu', { name: /文件夹菜单 source/ });
  await expect(rootMenu.getByRole('menuitem', { name: /更新关联路径/ })).toBeVisible();
  await expect(rootMenu.getByRole('menuitem', { name: /取消关联/ })).toBeVisible();
  await page.keyboard.press('Escape');
  await root.getByRole('button', { name: '展开 source' }).click();
  const parent = page.locator('.folder-entry').filter({ has: page.locator('.folder-row', { hasText: 'parent' }) });
  await expect(parent).toBeVisible();
  await parent.getByRole('button', { name: '展开 parent' }).click();
  const child = page.locator('.folder-entry').filter({ has: page.locator('.folder-row', { hasText: 'child' }) });
  await expect(child).toBeVisible();
  await parent.locator('.folder-row').click({ button: 'right' });
  const childMenu = page.getByRole('menu', { name: /文件夹菜单 parent/ });
  await expect(childMenu.getByRole('menuitem', { name: '在图库中显示' })).toBeVisible();
  await expect(childMenu.getByRole('menuitem', { name: '同步文件夹' })).toBeVisible();
  await expect(childMenu.getByRole('menuitem', { name: /更新关联路径/ })).toHaveCount(0);
  await expect(childMenu.getByRole('menuitem', { name: /取消关联/ })).toHaveCount(0);
  await childMenu.getByRole('menuitem', { name: '同步文件夹' }).click();
  await expect(page.getByRole('status')).toContainText('同步完成：新增 0 张，离线 0 张');
  await parent.locator('.folder-row').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'red 色' }).click();
  await expect(parent).toHaveClass(/color-red/);
  await expect(child).toHaveClass(/color-none/);
  await child.locator('.folder-row').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'blue 色' }).click();
  await expect(parent).toHaveClass(/color-red/);
  await expect(child).toHaveClass(/color-blue/);
  await child.locator('.folder-row').click();
  await expect(page.locator('.catalog-card')).toHaveCount(1);
  await expect(page.locator('.catalog-card')).toContainText('child.jpg');
  await child.locator('.folder-row').focus();
  await page.keyboard.press('ArrowUp');
  await expect(parent.locator('.folder-row')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('option', { name: /parent.jpg/ })).toBeVisible();
  await page.keyboard.press('ArrowDown');
  await expect(child.locator('.folder-row')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.catalog-card-image > img').first()).toHaveClass(/is-ready/);
  await expect(page.locator('.catalog-card-image > img').first()).toHaveCSS('opacity', '1');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu', { name: /文件夹菜单/ })).toHaveCount(0);
});

test('drags a nested folder into another folder', async () => {
  const sourceEntry = page.locator('.folder-entry').filter({ has: page.locator('.folder-row', { hasText: 'source' }) });
  const sourceDisclosure = sourceEntry.getByRole('button', { name: '展开 source' });
  if (await sourceDisclosure.count()) await sourceDisclosure.click();
  const parentEntry = page.locator('.folder-entry').filter({ has: page.locator('.folder-row', { hasText: 'parent' }) });
  const parentDisclosure = parentEntry.getByRole('button', { name: '展开 parent' });
  if (await parentDisclosure.count()) await parentDisclosure.click();
  const childRow = page.locator('.folder-row[data-folder-id]').filter({ hasText: 'child' });
  const targetRow = page.locator('.folder-row[data-folder-id]').filter({ hasText: 'target' });
  await childRow.dragTo(targetRow);
  await expect(page.getByRole('status')).toContainText('已将文件夹移入「target」');
  await expect.poll(async () => stat(path.join(testRoot, 'source', 'target', 'child', 'child.jpg')).then(() => true, () => false)).toBe(true);
  const movedChild = page.locator('.folder-entry').filter({ has: page.locator('.folder-row', { hasText: 'child' }) });
  await expect(movedChild).toBeVisible();
  await movedChild.locator('.folder-row').click();
  await expect(page.locator('.catalog-card')).toContainText('child.jpg');
});
