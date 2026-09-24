import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';

import { TaskService } from '../../apps/desktop/src/main/task-service';

let electronApp: ElectronApplication;
let page: Page;
let testRoot: string;
let databasePath: string;
let queuedExportTaskId: string;

test.beforeAll(async () => {
  testRoot = await mkdtemp(path.join(tmpdir(), 'photoallisai-task-controls-'));
  const userData = path.join(testRoot, 'user-data');
  const libraryDirectory = path.join(userData, 'library');
  await mkdir(libraryDirectory, { recursive: true });
  databasePath = path.join(libraryDirectory, 'catalog.sqlite');
  const tasks = new TaskService(databasePath);
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
  const queued = new TaskService(databasePath);
  queuedExportTaskId = queued.enqueue({
    kind: 'export',
    assetId: 'asset-A',
    payload: { destinationDirectory: '/private/export-target', resultIds: [] }
  }).id;
  queued.enqueue({ kind: 'export', assetId: 'asset-B', payload: {} });
  queued.close();
});

test.afterAll(async () => {
  if (electronApp) await electronApp.close();
  await rm(testRoot, { recursive: true, force: true });
});

test('reorders queued work and batch-retries failed generation tasks', async () => {
  const rendererExportTask = await page.evaluate((taskId) => window.desktopApi.getTask(taskId), queuedExportTaskId);
  expect(rendererExportTask?.payload).not.toHaveProperty('destinationDirectory');
  expect(rendererExportTask?.id).toBe(queuedExportTaskId);
  const provider = await page.evaluate(() => window.desktopApi.saveProviderProfile({
    name: 'Queue Generation', kind: 'nanobanana-compatible', purpose: 'generation',
    baseUrl: 'http://127.0.0.1:9/v1', modelId: 'queue-test', apiKey: 'queue-key', enabled: true
  }));
  const template = await page.evaluate(() => window.desktopApi.savePromptTemplate({
    name: '队列模板', description: '队列编辑测试', category: '人像', exampleId: 'none',
    body: '模板分析：{{analysis.summary}}\n用户要求：{{user_instruction}}'
  }));
  await page.getByRole('button', { name: '打开工作区' }).click();
  await page.getByRole('menuitem', { name: '任务中心' }).click();
  const rows = page.locator('.task-table-row');
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toContainText('asset-A');
  await expect(page.getByRole('button', { name: '任务上移' }).first()).toBeDisabled();

  await page.getByRole('button', { name: '任务下移' }).first().click();
  await expect(rows.nth(0)).toContainText('asset-B');
  await expect(rows.nth(1)).toContainText('asset-A');

  const exportRow = rows.filter({ hasText: 'asset-A' });
  await exportRow.getByRole('button', { name: '暂停任务' }).click();
  await expect(exportRow.getByText('已暂停')).toBeVisible();
  await expect(page.getByText('暂停 1', { exact: true })).toBeVisible();
  await exportRow.getByRole('button', { name: '恢复任务' }).click();
  await expect.poll(async () => (await page.evaluate((taskId) => window.desktopApi.getTask(taskId), queuedExportTaskId))?.status)
    .not.toBe('paused');
  await expect(exportRow.getByRole('button', { name: '恢复任务' })).toHaveCount(0);

  await page.getByRole('button', { name: '重试失败生成 (1)' }).click();
  await expect(page.getByText('已重新排队 1 个生成任务。')).toBeVisible();
  await expect.poll(async () => rows.filter({ hasText: 'asset-failed' }).getByText('失败').count()).toBe(1);

  const batchId = 'd1c701d8-3458-4686-8437-6e978b20a999';
  const analysisRevisionId = 'b70f8f56-6678-4b8e-9208-0e6ad7cbe277';
  const database = new DatabaseSync(databasePath);
  database.prepare(`INSERT INTO analysis_revisions (id, asset_id, provider_profile_id, schema_version, result_json, created_at) VALUES (?, ?, ?, '1.0', ?, ?)`)
    .run(analysisRevisionId, 'asset-edit', provider.id, JSON.stringify({
      schemaVersion: '1.0', summary: '队列测试分析', report: '测试报告',
      quality: { overallScore: 80, issues: [] }, adjustments: { global: [], local: [] }, generativeActions: [],
      catalog: { shortDescription: '测试', longDescription: '测试', scenes: [], subjects: [], objects: [], mood: [], colors: [], keywords: [], ocrText: '' },
      generationRecommendation: { recommended: true, templateId: null, reason: '测试' }
    }), Date.now());
  database.close();
  const tasks = new TaskService(databasePath);
  const basePayload = {
    providerProfileId: provider.id, batchId, prompt: 'old prompt', templateId: null,
    templateVersion: null, resultIndex: 1, storageMode: 'managed', analysisRevisionId,
    disabledActionIds: [], userInstruction: '保留真实质感'
  };
  tasks.enqueue({ kind: 'generation', assetId: 'asset-edit', payload: basePayload });
  tasks.enqueue({ kind: 'generation', assetId: 'asset-edit', payload: { ...basePayload, resultIndex: 2 } });
  tasks.close();
  const editRow = rows.filter({ hasText: 'asset-edit' }).first();
  await expect(editRow).toBeVisible();
  await editRow.getByRole('button', { name: '编辑生成提示词' }).click();
  await page.getByLabel('任务生成数量').fill('3');
  await page.getByLabel('任务提示词模板').selectOption(template.id);
  await expect(page.getByLabel('最终生成提示词')).toHaveValue(/队列测试分析/);
  await expect(page.getByLabel('最终生成提示词')).toHaveValue(/保留真实质感/);
  await page.screenshot({ path: 'test-results/task-generation-editor.png', animations: 'disabled' });
  await page.getByRole('button', { name: '保存修改' }).click();
  await expect(page.getByText('等待任务的模型、模板、提示词和生成数量已更新。')).toBeVisible();
  const verificationDatabase = new DatabaseSync(databasePath);
  const payloads = (verificationDatabase.prepare(`SELECT payload_json FROM tasks WHERE asset_id = 'asset-edit'`).all() as { payload_json: string }[])
    .map((row) => JSON.parse(row.payload_json) as { prompt: string; providerProfileId: string; resultIndex: number; templateId: string; templateVersion: number });
  verificationDatabase.close();
  expect(payloads).toHaveLength(3);
  expect(payloads.every((payload) => payload.prompt.includes('队列测试分析') && payload.prompt.includes('保留真实质感'))).toBe(true);
  expect(payloads.every((payload) => payload.providerProfileId === provider.id && payload.templateId === template.id && payload.templateVersion === template.version)).toBe(true);
  expect(payloads.map((payload) => payload.resultIndex).sort()).toEqual([1, 2, 3]);

  const historyDatabase = new DatabaseSync(databasePath);
  const insertHistory = historyDatabase.prepare(`
    INSERT INTO tasks (
      id, kind, asset_id, status, position, progress, attempt,
      payload_json, result_json, error_code, created_at, updated_at
    ) VALUES (?, 'analysis', ?, 'completed', ?, 1, 0, '{}', NULL, NULL, ?, ?)
  `);
  historyDatabase.exec('BEGIN IMMEDIATE');
  for (let index = 0; index < 60; index += 1) {
    insertHistory.run(
      `10000000-0000-4000-8000-${index.toString().padStart(12, '0')}`,
      `history-${index}`,
      index,
      index,
      index
    );
  }
  historyDatabase.exec('COMMIT');
  historyDatabase.close();
  await expect(page.getByText(/当前显示 50\/\d+ 项/)).toBeVisible();
  await page.getByRole('button', { name: '加载更多任务' }).click();
  await expect(rows).toHaveCount(66);
  await expect(page.getByText('当前显示 66/66 项')).toBeVisible();
  await page.screenshot({ path: 'test-results/task-history-pagination.png', animations: 'disabled' });
});
