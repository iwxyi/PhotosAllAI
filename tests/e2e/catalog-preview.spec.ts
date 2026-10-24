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
  await page.locator('.catalog-card').first().dblclick();
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
  await expect(page.locator('.analysis-head').getByRole('button', { name: '分析并给出建议' })).toBeVisible();
  await expect(page.getByText('尚未生成分析与编目数据')).toHaveCount(0);
  await expect(page.getByText('分析后将显示清除路人、移除障碍物等建议')).toHaveCount(0);
  await expect(page.locator('.inspector-section').filter({ hasText: '分析结果' })).toHaveCount(0);
  await expect(page.getByText('处理中 0')).toBeVisible();
  await expect(page.getByRole('treeitem', { name: /source 1/ })).toBeVisible();
  await page.getByRole('treeitem', { name: /source 1/ }).click();
  await expect(page.getByText('source', { exact: true }).last()).toBeVisible();
  await expect(page.getByText('1 张照片', { exact: true })).toBeVisible();
  await page.locator('.canvas-wrap').click({ button: 'right' });
  await page.getByRole('button', { name: '4 星' }).click();
  await page.reload();
  await page.locator('.catalog-card').first().dblclick();
  await expect(page.getByText('IMPORTED_PORTRAIT.jpg', { exact: true }).first()).toBeVisible();
  await page.locator('.canvas-wrap').click({ button: 'right' });
  await expect(page.getByRole('button', { name: '4 星' }).locator('svg')).toHaveAttribute('fill', 'currentColor');
  await page.getByRole('menuitem', { name: /添加标签/ }).click();
  await page.getByPlaceholder('人像, 夜景').fill('测试人像');
  await page.getByRole('button', { name: '应用' }).click();
  await expect(page.getByRole('button', { name: /测试人像.*1/ })).toBeVisible();
  await page.getByRole('button', { name: /测试人像.*1/ }).click();
  await expect(page.getByRole('button', { name: /测试人像.*1/ })).toHaveClass(/is-active/);
  await expect(page.getByText('1 张照片', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '分析并给出建议' }).click();
  await expect(page.locator('.analysis-head').getByText('请先在设置中添加并启用视觉分析模型。')).toBeVisible();
});
