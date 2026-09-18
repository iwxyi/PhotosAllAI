import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';

import { CatalogService } from '../../apps/desktop/src/main/catalog-service';

let electronApp: ElectronApplication;
let page: Page;
let testRoot: string;

test.beforeAll(async () => {
  testRoot = await mkdtemp(path.join(tmpdir(), 'photoallisai-preview-e2e-'));
  const userData = path.join(testRoot, 'user-data');
  const sourceDirectory = path.join(testRoot, 'source');
  const libraryDirectory = path.join(userData, 'library');
  await Promise.all([
    mkdir(sourceDirectory, { recursive: true }),
    mkdir(libraryDirectory, { recursive: true })
  ]);
  await copyFile(
    path.resolve('apps/desktop/src/renderer/public/demo/portrait.jpg'),
    path.join(sourceDirectory, 'IMPORTED_PORTRAIT.jpg')
  );

  const catalog = new CatalogService(path.join(libraryDirectory, 'catalog.sqlite'));
  await catalog.importFolders([sourceDirectory]);
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

test('serves bounded cached images without exposing file paths', async () => {
  await expect(page.getByText('IMPORTED_PORTRAIT.jpg', { exact: true }).first()).toBeVisible();

  const thumbnail = page.locator('.thumb', { hasText: 'IMPORTED_PORTRAIT.jpg' }).locator('img');
  const preview = page.locator('.base-image');
  await expect(thumbnail).toHaveAttribute('src', /^photoasset:\/\/thumbnail\//);
  await expect(preview).toHaveAttribute('src', /^photoasset:\/\/preview\//);
  await expect.poll(() => thumbnail.evaluate((image) => image.naturalWidth)).toBeGreaterThan(0);
  await expect.poll(() => preview.evaluate((image) => image.naturalWidth)).toBeGreaterThan(0);

  expect(await thumbnail.evaluate((image) => image.naturalWidth)).toBeLessThanOrEqual(384);
  expect(await preview.evaluate((image) => image.naturalWidth)).toBeLessThanOrEqual(2560);
  await expect(page.getByText('等待视觉分析')).toBeVisible();
  await expect(page.getByText('处理中 0')).toBeVisible();
  await page.getByRole('button', { name: '开始分析' }).click();
  await expect(page.getByText('请先在设置中添加并启用视觉分析模型。')).toBeVisible();
});
