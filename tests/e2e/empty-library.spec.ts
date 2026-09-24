import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';

let electronApp: ElectronApplication;
let page: Page;
let userDataDirectory: string;

test.beforeAll(async () => {
  userDataDirectory = await mkdtemp(path.join(tmpdir(), 'photoallisai-empty-library-e2e-'));
  electronApp = await electron.launch({
    args: [path.resolve('apps/desktop/out/main/index.js')],
    env: { ...process.env, PHOTOALLISAI_USER_DATA: userDataDirectory }
  });
  page = await electronApp.firstWindow();
  await page.waitForLoadState('domcontentloaded');
});

test.afterAll(async () => {
  if (electronApp) await electronApp.close();
  await rm(userDataDirectory, { recursive: true, force: true });
});

test('starts with an empty library workspace and no production demo records', async () => {
  await expect(page.getByRole('tab', { name: '图库' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tab')).toHaveCount(1);
  await expect(page.getByRole('heading', { name: '添加照片文件夹' })).toBeVisible();
  await expect(page.getByRole('button', { name: '选择文件夹' })).toBeVisible();
  await expect(page.getByText('2026 人像作品', { exact: true })).toHaveCount(0);
  await expect(page.getByText('DSC_4821.NEF', { exact: true })).toHaveCount(0);
  await expect(page.getByText('12,408')).toHaveCount(0);
  await expect(page.getByText('0 个文件夹 · 0 张照片')).toBeVisible();
});
