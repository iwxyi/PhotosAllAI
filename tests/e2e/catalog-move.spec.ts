import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises';
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

test('moves an original through the folder chooser and persists it after reload', async () => {
  await expect(page.getByText('MOVE_ME.jpg', { exact: true }).first()).toBeVisible();
  await page.getByRole('button', { name: '移动到文件夹' }).click();

  const dialog = page.getByRole('dialog', { name: '移动 1 张照片' });
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await page.getByRole('button', { name: '移动到文件夹' }).click();
  await expect(dialog).toBeVisible();
  await page.screenshot({ path: 'test-results/catalog-move-dialog.png', animations: 'disabled' });
  await dialog.getByText('target', { exact: true }).click();
  await dialog.getByRole('button', { name: '移动', exact: true }).click();

  await expect(page.getByRole('status')).toContainText('已移动 1 张照片');
  expect(await readFile(path.join(targetDirectory, 'MOVE_ME.jpg'))).not.toHaveLength(0);
  await expect(stat(path.join(sourceDirectory, 'MOVE_ME.jpg'))).rejects.toMatchObject({ code: 'ENOENT' });

  await page.reload();
  await expect(page.getByText('MOVE_ME.jpg', { exact: true }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: /target 1/ })).toBeVisible();
  await page.getByRole('button', { name: /target 1/ }).click();
  await expect(page.getByText('1 张照片', { exact: true })).toBeVisible();
});
