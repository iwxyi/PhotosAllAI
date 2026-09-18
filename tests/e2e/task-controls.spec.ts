import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';

import { TaskService } from '../../apps/desktop/src/main/task-service';

let electronApp: ElectronApplication;
let page: Page;
let testRoot: string;

test.beforeAll(async () => {
  testRoot = await mkdtemp(path.join(tmpdir(), 'photoallisai-task-controls-'));
  const userData = path.join(testRoot, 'user-data');
  const libraryDirectory = path.join(userData, 'library');
  await mkdir(libraryDirectory, { recursive: true });
  const databasePath = path.join(libraryDirectory, 'catalog.sqlite');
  const tasks = new TaskService(databasePath);
  tasks.enqueue({ kind: 'export', assetId: 'asset-A', payload: {} });
  tasks.enqueue({ kind: 'export', assetId: 'asset-B', payload: {} });
  const failed = tasks.enqueue({ kind: 'generation', assetId: 'asset-failed', payload: {} });
  tasks.close();
  const database = new DatabaseSync(databasePath);
  database.prepare(`UPDATE tasks SET status = 'failed', error_code = 'TEST_FAILURE' WHERE id = ?`).run(failed.id);
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

test('reorders queued work and batch-retries failed generation tasks', async () => {
  await page.getByRole('tab', { name: /任务中心/ }).click();
  const rows = page.locator('.task-table-row');
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toContainText('asset-A');
  await expect(page.getByRole('button', { name: '任务上移' }).first()).toBeDisabled();

  await page.getByRole('button', { name: '任务下移' }).first().click();
  await expect(rows.nth(0)).toContainText('asset-B');
  await expect(rows.nth(1)).toContainText('asset-A');

  await page.getByRole('button', { name: '重试失败生成 (1)' }).click();
  await expect(page.getByText('已重新排队 1 个生成任务。')).toBeVisible();
  await expect.poll(async () => rows.filter({ hasText: 'asset-failed' }).getByText('失败').count()).toBe(1);
});
