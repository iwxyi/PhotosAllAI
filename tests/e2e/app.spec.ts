import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';

let electronApp: ElectronApplication;
let page: Page;
let userDataDirectory: string;

test.beforeAll(async () => {
  userDataDirectory = await mkdtemp(path.join(tmpdir(), 'photoallisai-e2e-'));
  electronApp = await electron.launch({
    args: [path.resolve('apps/desktop/out/main/index.js')],
    env: { ...process.env, PHOTOALLISAI_USER_DATA: userDataDirectory }
  });
  page = await electronApp.firstWindow();
  await page.waitForLoadState('domcontentloaded');
});

test.afterAll(async () => {
  await electronApp.close();
  await rm(userDataDirectory, { recursive: true, force: true });
});

test('starts with the secure library workspace', async () => {
  await expect(page.getByText('PhotoAllIsAI')).toBeVisible();
  await expect(page.getByRole('tab', { name: '图库' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByText('2026 人像作品', { exact: true }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: /加入生成队列/ })).toBeVisible();

  const security = await page.evaluate(() => ({
    hasDesktopApi: typeof window.desktopApi === 'object',
    hasNodeProcess: typeof (window as unknown as { process?: unknown }).process !== 'undefined'
  }));
  expect(security).toEqual({ hasDesktopApi: true, hasNodeProcess: false });

  await expect.poll(async () =>
    page.locator('img').evaluateAll((images) => images.every((image) => image.complete && image.naturalWidth > 0))
  ).toBe(true);

  const canvas = await page.locator('.photo-canvas').boundingBox();
  expect(canvas?.width).toBeGreaterThan(500);
});

test('switches photos and comparison modes', async () => {
  await page.getByRole('option', { name: '' }).nth(1).click();
  await expect(page.getByText('DSC_4837.NEF', { exact: true }).last()).toBeVisible();

  await page.getByRole('button', { name: /对比/ }).click();
  await expect(page.getByLabel('调整原图和生成图分割线')).toBeVisible();
});

test('opens the task drawer and application tabs', async () => {
  await page.getByRole('button', { name: /生成中 1/ }).click();
  await expect(page.getByText('当前任务')).toBeVisible();
  await expect(page.getByText('正在生成 · 64%')).toBeVisible();

  await page.getByRole('tab', { name: /设置/ }).click();
  await expect(page.getByRole('heading', { name: '设置', exact: true })).toBeVisible();
  await page.getByRole('tab', { name: /图库/ }).click();
});

test('captures the primary workspace for visual inspection', async () => {
  await page.screenshot({
    path: 'test-results/library-workspace.png',
    animations: 'disabled'
  });
});
