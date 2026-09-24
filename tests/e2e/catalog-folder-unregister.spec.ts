import { copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';

import { CatalogService } from '../../apps/desktop/src/main/catalog-service';

let electronApp: ElectronApplication;
let page: Page;
let testRoot: string;
let sourceDirectory: string;
let databasePath: string;
let assetId: string;
let folderId: string;
let tagId: string;
let albumId: string;

test.beforeAll(async () => {
  testRoot = await mkdtemp(path.join(tmpdir(), 'photoallisai-folder-unregister-e2e-'));
  const userData = path.join(testRoot, 'user-data');
  sourceDirectory = path.join(testRoot, 'source');
  const libraryDirectory = path.join(userData, 'library');
  await Promise.all([mkdir(sourceDirectory), mkdir(libraryDirectory, { recursive: true })]);
  await copyFile(
    path.resolve('apps/desktop/src/renderer/public/demo/portrait.jpg'),
    path.join(sourceDirectory, 'KEEP_ME.jpg')
  );
  databasePath = path.join(libraryDirectory, 'catalog.sqlite');
  const catalog = new CatalogService(databasePath);
  await catalog.importFolders([sourceDirectory]);
  const asset = catalog.listAssets()[0]!;
  assetId = asset.id;
  folderId = asset.folderId;
  catalog.updateMetadata({ assetIds: [assetId], rating: 5, favorite: true });
  tagId = catalog.updateTags({ assetIds: [assetId], addTags: ['保留标签'], removeTagIds: [] })[0]!.id;
  albumId = catalog.saveAlbum({ name: '保留相册' }).id;
  catalog.updateAlbumAssets({ albumId, assetIds: [assetId], mode: 'add' });
  catalog.close();

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

test('unregisters a source folder without touching files and restores its catalog identity', async () => {
  await page.locator('.catalog-card').first().dblclick();
  await page.getByRole('button', { name: /source 1/ }).click();
  await page.locator('.canvas-wrap').click({ button: 'right' });
  const photoMenu = page.getByRole('menu', { name: /照片菜单 1 张/ });
  await expect(photoMenu.getByText('取消首选')).toBeVisible();
  await photoMenu.getByRole('menuitem', { name: '取消首选' }).click();
  await expect(page.getByRole('status')).toContainText('已取消收藏 1 张照片');
  await expect(page.getByRole('button', { name: /首选 0/ })).toBeVisible();
  await page.locator('.canvas-wrap').click({ button: 'right' });
  await page.getByRole('menuitem', { name: '标记为首选' }).click();
  await expect(page.getByRole('status')).toContainText('已收藏 1 张照片');
  await expect(page.getByRole('button', { name: /首选 1/ })).toBeVisible();
  await page.getByRole('button', { name: /source 1/ }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: /从图库移除/ }).click();
  const dialog = page.getByRole('alertdialog', { name: '从图库移除文件夹「source」？' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('不会删除、移动或修改磁盘上的任何文件');
  await expect(dialog).toContainText('AI 分析、生成版本、评分、标签和相册关系都会保留');
  await page.screenshot({ path: 'test-results/catalog-folder-unregister-dialog.png', animations: 'disabled' });
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();

  await page.getByRole('button', { name: /source 1/ }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: /从图库移除/ }).click();
  await dialog.getByRole('button', { name: '仅从图库移除' }).click();
  await expect(page.getByRole('status')).toContainText('磁盘文件和已有元数据保持不变');
  await expect(page.getByRole('button', { name: /source 1/ })).toHaveCount(0);
  expect(await readFile(path.join(sourceDirectory, 'KEEP_ME.jpg'))).not.toHaveLength(0);

  const removedDatabase = new DatabaseSync(databasePath, { readOnly: true });
  expect(removedDatabase.prepare('SELECT removed_at FROM folders WHERE id = ?').get(folderId))
    .toMatchObject({ removed_at: expect.any(Number) });
  expect(removedDatabase.prepare('SELECT removed_at FROM assets WHERE id = ?').get(assetId))
    .toMatchObject({ removed_at: expect.any(Number) });
  removedDatabase.close();

  await electronApp.evaluate(({ dialog: electronDialog }, directory) => {
    electronDialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory], bookmarks: [] });
  }, sourceDirectory);
  await page.getByRole('button', { name: '导入文件夹' }).click();
  await expect(page.getByRole('button', { name: /source 1/ })).toBeVisible();

  await expect.poll(() => {
    const restoredDatabase = new DatabaseSync(databasePath, { readOnly: true });
    const asset = restoredDatabase.prepare(`
      SELECT id, folder_id, rating, favorite, removed_at FROM assets WHERE id = ?
    `).get(assetId);
    const tag = restoredDatabase.prepare('SELECT COUNT(*) AS value FROM asset_tags WHERE asset_id = ? AND tag_id = ?')
      .get(assetId, tagId);
    const album = restoredDatabase.prepare('SELECT COUNT(*) AS value FROM album_assets WHERE asset_id = ? AND album_id = ?')
      .get(assetId, albumId);
    restoredDatabase.close();
    return { asset, tag, album };
  }).toEqual({
    asset: { id: assetId, folder_id: folderId, rating: 5, favorite: 1, removed_at: null },
    tag: { value: 1 },
    album: { value: 1 }
  });
});
