import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';

import { CatalogService } from '../../apps/desktop/src/main/catalog-service';

let app: ElectronApplication;
let page: Page;
let testRoot: string;
let sourceDirectory: string;
let targetDirectory: string;

test.beforeAll(async () => {
  testRoot = await mkdtemp(path.join(tmpdir(), 'photoallisai-folder-drop-'));
  const sourceLink = path.join(testRoot, 'source');
  const targetLink = path.join(testRoot, 'target');
  const libraryDirectory = path.join(testRoot, 'user-data', 'library');
  await Promise.all([mkdir(sourceLink), mkdir(targetLink), mkdir(libraryDirectory, { recursive: true })]);
  [sourceDirectory, targetDirectory] = await Promise.all([realpath(sourceLink), realpath(targetLink)]);
  const fixture = path.resolve('apps/desktop/src/renderer/public/demo/portrait.jpg');
  await Promise.all([
    copyFile(fixture, path.join(sourceDirectory, 'MOVE.jpg')),
    copyFile(fixture, path.join(sourceDirectory, 'COPY.jpg'))
  ]);
  const catalog = new CatalogService(path.join(libraryDirectory, 'catalog.sqlite'));
  await catalog.importFolders([sourceDirectory, targetDirectory]);
  catalog.close();
  app = await electron.launch({
    args: [path.resolve('apps/desktop/out/main/index.js')],
    env: { ...process.env, PHOTOALLISAI_USER_DATA: path.join(testRoot, 'user-data') }
  });
  page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
});

test.afterAll(async () => {
  if (app) await app.close();
  if (testRoot) await rm(testRoot, { recursive: true, force: true });
});

test('moves by default and copies with the platform copy modifier when dropped on a linked folder', async () => {
  await page.getByRole('treeitem', { name: /source/ }).click();
  const target = page.getByRole('treeitem', { name: /target/ });
  await page.getByRole('option', { name: /MOVE.jpg/ }).dragTo(target);
  await expect(page.getByRole('status')).toContainText('已移动 1 张照片');
  expect(await readFile(path.join(targetDirectory, 'MOVE.jpg'))).not.toHaveLength(0);
  await expect(stat(path.join(sourceDirectory, 'MOVE.jpg'))).rejects.toMatchObject({ code: 'ENOENT' });

  await page.getByRole('button', { name: /所有照片/ }).click();
  const copyCard = page.getByRole('option', { name: /COPY.jpg/ });
  const assetId = await copyCard.getAttribute('data-asset-id');
  expect(assetId).toBeTruthy();
  // Playwright's high-level dragTo does not preserve modifier flags on Chromium's
  // drop event, so dispatch a real DataTransfer event to verify Ctrl-copy semantics.
  await target.evaluate((element, id) => {
    const transfer = new DataTransfer();
    transfer.setData('application/x-photoallisai-assets', JSON.stringify([id]));
    element.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, ctrlKey: true, dataTransfer: transfer }));
    element.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, ctrlKey: true, dataTransfer: transfer }));
  }, assetId!);
  await expect(page.getByRole('status')).toContainText('已复制 1 张照片');
  expect(await readFile(path.join(sourceDirectory, 'COPY.jpg'))).not.toHaveLength(0);
  expect(await readFile(path.join(targetDirectory, 'COPY.jpg'))).not.toHaveLength(0);
});
