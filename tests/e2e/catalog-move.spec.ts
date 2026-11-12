import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';

import { CatalogService } from '../../apps/desktop/src/main/catalog-service';

let electronApp: ElectronApplication;
let page: Page;
let testRoot: string;
let sourceDirectory: string;
let targetDirectory: string;

test.beforeAll(async () => {
  testRoot = await mkdtemp(path.join(tmpdir(), 'photoallisai-move-e2e-'));
  const userData = path.join(testRoot, 'user-data');
  const sourceLink = path.join(testRoot, 'source');
  const targetLink = path.join(testRoot, 'target');
  const libraryDirectory = path.join(userData, 'library');
  await Promise.all([
    mkdir(sourceLink),
    mkdir(targetLink),
    mkdir(libraryDirectory, { recursive: true })
  ]);
  [sourceDirectory, targetDirectory] = await Promise.all([realpath(sourceLink), realpath(targetLink)]);
  await copyFile(
    path.resolve('apps/desktop/src/renderer/public/demo/portrait.jpg'),
    path.join(sourceDirectory, 'MOVE_ME.jpg')
  );
  await writeFile(path.join(sourceDirectory, 'MOVE_ME.xmp'), '<x:xmpmeta>fixture</x:xmpmeta>');

  const catalog = new CatalogService(path.join(libraryDirectory, 'catalog.sqlite'));
  await catalog.importFolders([sourceDirectory, targetDirectory]);
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

test('moves, copies, and renames originals through safe file dialogs', async () => {
  await page.locator('.catalog-card').first().dblclick();
  await expect(page.getByText('MOVE_ME.jpg', { exact: true }).first()).toBeVisible();
  await page.locator('.canvas-wrap').click({ button: 'right' });
  await expect(page.getByRole('menuitem', { name: /在访达中显示|在文件资源管理器中显示/ })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '新建相册' }).click();
  const albumDialog = page.getByRole('dialog', { name: '管理相册' });
  await expect(albumDialog).toBeVisible();
  await page.screenshot({ path: 'test-results/catalog-album-dialog.png', animations: 'disabled' });
  await albumDialog.getByPlaceholder('例如：客户交付').fill('客户交付');
  await albumDialog.getByRole('button', { name: '创建相册' }).click();
  await expect(albumDialog.getByText('客户交付', { exact: true })).toBeVisible();
  await albumDialog.getByRole('button', { name: '关闭相册管理' }).click();
  await page.getByRole('button', { name: /客户交付 0/ }).click();
  await expect(page.getByText('此集合为空')).toBeVisible();
  await page.getByRole('button', { name: /所有照片/ }).click();
  await page.getByRole('button', { name: /未评分 1/ }).click();
  await expect(page.getByText('MOVE_ME.jpg', { exact: true }).first()).toBeVisible();
  await page.getByRole('button', { name: /未评分 1/ }).click();
  await page.locator('.catalog-card').first().click({ button: 'right' });
  await page.getByRole('menuitem', { name: /移动到文件夹/ }).click();

  const dialog = page.getByRole('dialog', { name: '移动 1 张照片' });
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await page.locator('.catalog-card').first().click({ button: 'right' });
  await page.getByRole('menuitem', { name: /移动到文件夹/ }).click();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(/同时处理 1 个关联文件/)).toBeVisible();
  await expect(dialog.getByRole('checkbox')).not.toBeChecked();
  await page.screenshot({ path: 'test-results/catalog-move-dialog.png', animations: 'disabled' });
  await dialog.getByRole('checkbox').check();
  await dialog.getByText('target', { exact: true }).click();
  await dialog.getByRole('button', { name: '移动', exact: true }).click();

  await expect(page.locator('.operation-toast')).toContainText('已移动 1 张照片');
  expect(await readFile(path.join(targetDirectory, 'MOVE_ME.jpg'))).not.toHaveLength(0);
  expect(await readFile(path.join(targetDirectory, 'MOVE_ME.xmp'), 'utf8')).toContain('fixture');
  await expect(stat(path.join(sourceDirectory, 'MOVE_ME.jpg'))).rejects.toMatchObject({ code: 'ENOENT' });

  await page.reload();
  await expect(page.getByText('MOVE_ME.jpg', { exact: true }).first()).toBeVisible();
  await expect(page.getByRole('treeitem', { name: /target 1/ })).toBeVisible();
  await page.getByRole('treeitem', { name: /target 1/ }).click();
  await expect(page.locator('.catalog-card')).toHaveCount(1);
  await expect(page.locator('.catalog-card')).toContainText('MOVE_ME.jpg');
  await page.locator('.catalog-card').first().click({ button: 'right' });
  await page.getByRole('menuitem', { name: /复制到文件夹/ }).click();
  const copyDialog = page.getByRole('dialog', { name: '复制 1 张照片' });
  await expect(copyDialog).toBeVisible();
  await copyDialog.getByRole('checkbox').check();
  await copyDialog.getByText('source', { exact: true }).click();
  await page.screenshot({ path: 'test-results/catalog-copy-dialog.png', animations: 'disabled' });
  await copyDialog.getByRole('button', { name: '复制', exact: true }).click();
  await expect(page.locator('.operation-toast')).toContainText('已复制 1 张照片');
  expect(await readFile(path.join(sourceDirectory, 'MOVE_ME.jpg'))).not.toHaveLength(0);
  expect(await readFile(path.join(sourceDirectory, 'MOVE_ME.xmp'), 'utf8')).toContain('fixture');

  await page.locator('.catalog-card').first().click({ button: 'right' });
  await page.getByRole('menuitem', { name: /^重命名/ }).click();
  const renameDialog = page.getByRole('dialog', { name: '重命名照片' });
  await expect(renameDialog).toBeVisible();
  await renameDialog.getByLabel('新文件名').fill('RENAMED.jpg');
  await page.screenshot({ path: 'test-results/catalog-rename-dialog.png', animations: 'disabled' });
  await renameDialog.getByRole('button', { name: '重命名', exact: true }).click();
  await expect(page.locator('.operation-toast')).toContainText('已重命名为 RENAMED.jpg');
  expect(await readFile(path.join(targetDirectory, 'RENAMED.jpg'))).not.toHaveLength(0);
  await expect(stat(path.join(targetDirectory, 'MOVE_ME.jpg'))).rejects.toMatchObject({ code: 'ENOENT' });

  await page.reload();
  await expect(page.getByText('RENAMED.jpg', { exact: true }).first()).toBeVisible();
  await expect(page.getByRole('treeitem', { name: /source 1/ })).toBeVisible();
  await expect(page.getByRole('treeitem', { name: /target 1/ })).toBeVisible();

  await page.getByRole('treeitem', { name: /source 1/ }).click();
  await page.locator('.catalog-card').first().click({ button: 'right' });
  await page.getByRole('menuitem', { name: /从图库移除/ }).click();
  const removalDialog = page.getByRole('alertdialog', { name: /从图库移除 1 张照片/ });
  await expect(removalDialog).toBeVisible();
  await page.screenshot({ path: 'test-results/catalog-remove-dialog.png', animations: 'disabled' });
  await removalDialog.getByRole('button', { name: '仅从图库移除', exact: true }).click();
  expect(await readFile(path.join(sourceDirectory, 'MOVE_ME.jpg'))).not.toHaveLength(0);
  await expect(page.getByRole('treeitem', { name: /source 0/ })).toBeVisible();

  await page.getByRole('treeitem', { name: /target 1/ }).click();
  await page.locator('.catalog-card').first().click({ button: 'right' });
  await page.getByRole('menuitem', { name: /移到系统回收站/ }).click();
  const trashDialog = page.getByRole('alertdialog', { name: /移到系统回收站 1 张照片/ });
  await expect(trashDialog).toBeVisible();
  await page.screenshot({ path: 'test-results/catalog-trash-dialog.png', animations: 'disabled' });
  await page.keyboard.press('Escape');
  await expect(trashDialog).toBeHidden();
  expect(await readFile(path.join(targetDirectory, 'RENAMED.jpg'))).not.toHaveLength(0);

  await page.getByRole('button', { name: '打开工作区' }).click();
  await page.getByRole('menuitem', { name: '任务中心' }).click();
  await page.getByRole('button', { name: '文件分类' }).click();
  await expect(page.locator('.task-center-page .operation-history-row')).toHaveCount(4);
  await expect(page.getByText('从图库移除', { exact: true })).toBeVisible();
  await page.getByLabel('撤销重命名').click();
  await expect(page.locator('.task-center-page').getByRole('status')).toContainText('已撤销重命名');
  expect(await readFile(path.join(targetDirectory, 'MOVE_ME.jpg'))).not.toHaveLength(0);
  await expect(stat(path.join(targetDirectory, 'RENAMED.jpg'))).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(page.getByText('已撤销', { exact: true })).toBeVisible();
  await page.screenshot({ path: 'test-results/file-operation-undo.png', animations: 'disabled' });
});
