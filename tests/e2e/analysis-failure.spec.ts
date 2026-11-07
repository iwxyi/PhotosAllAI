import path from 'node:path';
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import { _electron as electron, expect, test } from '@playwright/test';
import { CatalogService } from '../../apps/desktop/src/main/catalog-service';

test('model settings persist separate defaults and replace the previous default', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'photoallisai-default-model-e2e-'));
  const app = await electron.launch({
    args: [path.resolve('apps/desktop/out/main/index.js')],
    env: { ...process.env, PHOTOALLISAI_USER_DATA: directory }
  });
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    await page.evaluate(async () => {
      const base = { kind: 'openai-compatible' as const, baseUrl: 'https://example.com/v1', modelId: 'test-model', enabled: true };
      await window.desktopApi.saveProviderProfile({ ...base, purpose: 'vision', name: 'Vision One' });
      await window.desktopApi.saveProviderProfile({ ...base, purpose: 'vision', name: 'Vision Two' });
      await window.desktopApi.saveProviderProfile({ ...base, purpose: 'generation', name: 'Generation' });
    });
    await page.getByRole('button', { name: '打开工作区', exact: true }).click();
    await page.getByRole('menuitem', { name: '设置', exact: true }).click();
    await page.getByRole('button', { name: 'AI 模型', exact: true }).click();
    await expect(page.locator('.provider-item').filter({ hasText: 'Vision One' })).toContainText('默认');
    await page.locator('.provider-item').filter({ hasText: 'Vision Two' }).click();
    await page.getByRole('checkbox', { name: '设为视觉分析默认配置', exact: true }).check();
    await page.getByRole('button', { name: '保存配置', exact: true }).click();
    await expect(page.locator('.provider-item').filter({ hasText: 'Vision Two' })).toContainText('默认');
    await expect(page.locator('.provider-item').filter({ hasText: 'Vision One' })).not.toContainText('默认');
    await expect(page.locator('.provider-item').filter({ hasText: 'Generation' })).toContainText('默认');
    const profiles = await page.evaluate(() => window.desktopApi.listProviderProfiles());
    expect(profiles.find((profile) => profile.purpose === 'vision')?.name).toBe('Vision Two');
    await page.locator('.provider-item').filter({ hasText: 'Vision Two' }).click();
    await expect(page.getByRole('checkbox', { name: '设为视觉分析默认配置', exact: true })).toBeChecked();
    await page.screenshot({ path: 'test-results/model-default-settings.png' });
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('AI sidebar separates preparation from execution and task views show explicit scopes', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'photoallisai-drawer-e2e-'));
  const source = path.join(directory, 'photos');
  const library = path.join(directory, 'library');
  await Promise.all([mkdir(source), mkdir(library)]);
  for (const name of ['FIRST.jpg', 'SECOND.jpg']) await copyFile(path.resolve('apps/desktop/src/renderer/public/demo/portrait.jpg'), path.join(source, name));
  const catalog = new CatalogService(path.join(library, 'catalog.sqlite'));
  await catalog.importFolders([source]);
  const assets = catalog.listAssets();
  catalog.close();
  const app = await electron.launch({
    args: [path.resolve('apps/desktop/out/main/index.js')],
    env: { ...process.env, PHOTOALLISAI_USER_DATA: directory }
  });
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    await app.evaluate(({ ipcMain }, ids) => {
      const batchIds = ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'];
      const analysis = {
        schemaVersion: '1.0', summary: '本次分析：夜景人像', report: '主体清晰，背景有路人。',
        quality: { overallScore: 82, issues: [] }, adjustments: { global: [], local: [] }, generativeActions: [],
        catalog: { shortDescription: '城市夜景人像', longDescription: '人物位于城市街道。', scenes: [], subjects: [], objects: [], mood: [], colors: [], keywords: ['夜景人像'], ocrText: '' },
        generationRecommendation: { recommended: false, templateId: null, reason: '无需生成' }
      };
      const items = [ids[0], ids[0], ids[1], ids[1], ids[0]].map((assetId, index) => ({
        id: `task-${index}`, kind: index === 4 ? 'generation' : 'analysis', assetId,
        status: ['completed', 'failed', 'processing', 'queued', 'queued'][index],
        position: index, progress: 0, attempt: 0,
        payload: { submissionId: batchIds[index < 3 ? 0 : index - 2], prompt: index === 4 ? '动漫风' : undefined },
        result: index === 0 ? { analysisRevisionId: 'revision-1', analysis } : null,
        errorCode: index === 1 ? 'PROVIDER_RESPONSE_HTML' : null, createdAt: Date.now() + index, updatedAt: Date.now() + index
      }));
      ipcMain.removeHandler('tasks.page.v1');
      ipcMain.handle('tasks.page.v1', () => ({ items,
        nextCursor: null, totalCount: 5, queuedCount: 2, pausedCount: 0, activeCount: 1,
        failedCount: 1, failedGenerationCount: 0
      }));
      ipcMain.removeHandler('tasks.batch.v1');
      ipcMain.handle('tasks.batch.v1', (_event, input) => items.filter((task) => task.kind === input.kind && task.payload.submissionId === input.batchId));
    }, assets.map((asset) => asset.id));
    await expect(page.locator('.task-status-batch')).toHaveCount(2);
    await expect(page.getByRole('button', { name: '查看其余后台任务', exact: true })).toHaveText('+1');
    const tabCount = await page.getByRole('tab').count();
    await page.getByRole('button', { name: '后台任务', exact: true }).click();
    const firstBatch = page.locator('.task-drawer .task-batch-group').filter({ hasText: '本次分析：夜景人像' });
    await expect(page.locator('.task-drawer .task-batch-group')).toHaveCount(3);
    await firstBatch.locator(':scope > summary').click();
    await expect(firstBatch).toHaveAttribute('open', '');
    await expect(firstBatch).toContainText('成功 1');
    await expect(firstBatch.locator('progress')).toHaveAttribute('max', '3');
    await expect(firstBatch.locator('progress')).toHaveAttribute('value', '2');
    await expect(firstBatch).toContainText('本次分析：夜景人像');
    await expect(firstBatch).toContainText('82 分');
    await expect(firstBatch.locator('.task-analysis-failure')).toBeVisible();
    await firstBatch.locator(':scope > summary').click();
    await expect(firstBatch).not.toHaveAttribute('open');
    await firstBatch.locator(':scope > summary').click();
    await expect(firstBatch).toHaveAttribute('open', '');
    await expect(page.getByRole('tab')).toHaveCount(tabCount);
    await expect(page.getByRole('tab', { name: '图库', exact: true })).toHaveAttribute('aria-selected', 'true');
    await page.getByRole('button', { name: '关闭任务抽屉', exact: true }).click();
    await page.getByRole('button', { name: '打开工作区', exact: true }).click();
    await page.getByRole('menuitem', { name: '任务中心', exact: true }).click();
    await expect(page.locator('.task-table > .task-batch-group')).toHaveCount(3);
    await expect(page.locator('.task-table-row:visible')).toHaveCount(0);
    const centerBatch = page.locator('.task-table > .task-batch-group').filter({ hasText: '本次分析：夜景人像' });
    await expect(centerBatch).toContainText('成功 1');
    await expect(centerBatch).toContainText('处理中 1');
    await expect(centerBatch).toContainText('失败 1');
    await centerBatch.locator(':scope > summary').click();
    await expect(page.locator('.task-table-row:visible')).toHaveCount(3);
    await expect(centerBatch).toContainText('FIRST.jpg');
    await expect(centerBatch).toContainText('SECOND.jpg');
    await expect(centerBatch).toContainText('本次分析：夜景人像');
    await expect(centerBatch.locator('.task-analysis-failure')).toContainText('/v1');
    await page.getByRole('button', { name: '失败', exact: true }).click();
    await expect(page.locator('.task-table > .task-batch-group')).toHaveCount(1);
    if (!(await centerBatch.evaluate((element) => (element as HTMLDetailsElement).open))) await centerBatch.locator(':scope > summary').click();
    await expect(page.locator('.task-table-row:visible')).toHaveCount(3);
    await page.getByRole('button', { name: 'AI', exact: true }).click();
    const analysis = page.getByRole('region', { name: '视觉分析', exact: true });
    const batch = page.getByRole('region', { name: '批量修图', exact: true });
    await expect(analysis).toBeVisible();
    await expect(batch).toBeVisible();
    await expect(batch.getByRole('button', { name: '添加到批量修图', exact: true })).toBeVisible();
    await expect(batch).not.toContainText('等待分析');
    await batch.getByRole('button', { name: '添加到批量修图', exact: true }).click();
    await expect(batch).toContainText('1 张图片');
    await expect(page.locator('.task-statusbar')).toContainText('批任务');
    await page.getByRole('tab', { name: '图库', exact: true }).click();
    await page.locator('.catalog-card').first().click();
    await page.locator('.catalog-card').nth(1).click({ modifiers: ['Shift'] });
    await expect(analysis.getByRole('button', { name: '分析选中的 2 张', exact: true })).toBeVisible();
    await expect(batch.getByRole('button', { name: '添加选中的 2 张到批量修图', exact: true })).toBeVisible();
    for (const width of [1440, 900]) {
      await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0]!.setSize(width, 900), width);
      await page.getByRole('tab', { name: '任务中心', exact: true }).click();
      const group = page.locator('.task-table > .task-batch-group').filter({ hasText: '本次分析：夜景人像' });
      if (!(await group.evaluate((element) => (element as HTMLDetailsElement).open))) await group.locator(':scope > summary').click();
      await expect.poll(() => page.locator('.task-center-page').evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
      await expect.poll(() => batch.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
      await page.screenshot({ path: `test-results/task-hierarchy-${width}.png` });
      await expect(page.locator('.task-table-row:visible')).toHaveCount(3);
      for (const row of await page.locator('.task-table-row').all()) {
        await expect.poll(() => row.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
      }
      await page.screenshot({ path: `test-results/task-detail-${width}.png` });
    }
    await page.getByRole('tab', { name: '图库', exact: true }).click();
    await page.getByRole('textbox', { name: '搜索图库', exact: true }).fill('SECOND');
    await expect(page.locator('.catalog-card')).toHaveCount(1);
    await page.getByRole('tab', { name: '任务中心', exact: true }).click();
    const analysisGroup = page.locator('.task-table > .task-batch-group').filter({ hasText: '本次分析：夜景人像' });
    if (!(await analysisGroup.evaluate((element) => (element as HTMLDetailsElement).open))) await analysisGroup.locator(':scope > summary').click();
    const firstRow = analysisGroup.locator('.task-table-row').filter({ hasText: 'FIRST.jpg' }).first();
    const preview = firstRow.locator('.task-member-preview img');
    await expect(preview).toBeVisible();
    await expect.poll(() => preview.evaluate((image) => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
    await page.screenshot({ path: 'test-results/task-photo-preview.png' });
    await firstRow.locator('strong').dblclick();
    await expect(page.getByRole('tab', { name: '看图', exact: true })).toHaveCount(0);
    await expect(page.getByRole('tab', { name: '任务中心', exact: true })).toHaveAttribute('aria-selected', 'true');
    const firstAsset = assets.find((asset) => asset.fileName === 'FIRST.jpg')!;
    await expect(page.locator('.base-image')).toHaveAttribute('src', firstAsset.previewUrl.replace('://preview/', '://original/'));
    await expect(page.locator('.inline-photo-viewer .thumb')).toHaveCount(2);
    await page.keyboard.press('Escape');
    await expect(firstRow).toBeVisible();
    await firstRow.locator('.task-member-preview').click();
    await expect(page.locator('.base-image')).toHaveAttribute('src', firstAsset.previewUrl.replace('://preview/', '://original/'));
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: '后台任务', exact: true }).click();
    const drawerGroup = page.locator('.task-drawer .task-batch-group').filter({ hasText: '本次分析：夜景人像' });
    if (!(await drawerGroup.evaluate((element) => (element as HTMLDetailsElement).open))) await drawerGroup.locator(':scope > summary').click();
    const drawerRow = drawerGroup.locator('.task-activity-row').filter({ hasText: 'SECOND.jpg' }).first();
    await expect.poll(() => drawerRow.locator('img').evaluate((image) => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
    await drawerRow.locator('strong').dblclick();
    await expect(page.locator('.base-image')).toHaveAttribute('src', assets.find((asset) => asset.fileName === 'SECOND.jpg')!.previewUrl.replace('://preview/', '://original/'));
    await expect(page.locator('.task-drawer')).toBeHidden();
    await page.keyboard.press('Escape');
    await expect(drawerRow).toBeVisible();
    const drawerFirst = drawerGroup.locator('.task-activity-row').filter({ hasText: 'FIRST.jpg' }).first();
    await drawerFirst.locator('.task-member-preview').click();
    await expect(page.locator('.base-image')).toHaveAttribute('src', firstAsset.previewUrl.replace('://preview/', '://original/'));
    await expect(page.getByRole('button', { name: '已加入修图列表', exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(drawerFirst).toBeVisible();
    await page.getByRole('button', { name: '关闭任务抽屉', exact: true }).click();
    await app.evaluate(({ ipcMain }, asset) => {
      const results = [2, 1].map((version) => ({
        id: version === 1 ? '11111111-1111-4111-8111-111111111111' : '22222222-2222-4222-8222-222222222222',
        assetId: asset.id, batchId: '33333333-3333-4333-8333-333333333333', version,
        fileName: `candidate-${version}.jpg`, resultUrl: asset.previewUrl, prompt: '动漫风',
        providerProfileId: '44444444-4444-4444-8444-444444444444', templateId: null, templateVersion: null,
        storageMode: 'managed', reviewState: 'undecided', createdAt: Date.now()
      }));
      ipcMain.removeHandler('generation.results.list.v1');
      ipcMain.handle('generation.results.list.v1', (_event, input) => input.assetId === asset.id ? results : []);
    }, firstAsset);
    await page.getByRole('button', { name: '打开工作区', exact: true }).click();
    await page.getByRole('menuitem', { name: 'AI 批量修图', exact: true }).click();
    const queue = page.locator('.batch-queue-item').filter({ hasText: 'FIRST.jpg' });
    await expect(queue.locator('.batch-candidate')).toHaveCount(2);
    await queue.getByRole('img', { name: '生成候选 1', exact: true }).dblclick();
    await expect(page.locator('.inline-photo-viewer .version-button.is-current')).toHaveText('V1');
    await page.keyboard.press('Escape');
    await queue.locator('.batch-queue-source').dblclick();
    await expect(page.locator('.inline-photo-viewer .version-button.is-current')).toHaveText('V1');
    await page.keyboard.press('Escape');
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('failed visual analysis shows its reason and diagnostic code', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'photoallisai-failure-e2e-'));
  const app = await electron.launch({
    args: [path.resolve('apps/desktop/out/main/index.js')],
    env: { ...process.env, PHOTOALLISAI_USER_DATA: directory, PHOTOALLISAI_E2E_DEMO: '1' }
  });
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    await app.evaluate(({ ipcMain }) => {
      const items = [{ id: 'analysis-failed', kind: 'analysis', assetId: 'photo-1', status: 'failed',
        position: 0, progress: 0, attempt: 0, payload: {}, result: null,
        errorCode: 'PROVIDER_HTTP_401', createdAt: Date.now(), updatedAt: Date.now() }];
      ipcMain.removeHandler('tasks.batch.v1');
      ipcMain.handle('tasks.batch.v1', () => items);
      ipcMain.removeHandler('tasks.page.v1');
      ipcMain.handle('tasks.page.v1', () => ({ items,
        nextCursor: null, totalCount: 1, queuedCount: 0, pausedCount: 0, activeCount: 0,
        failedCount: 1, failedGenerationCount: 0
      }));
    });
    await page.getByRole('button', { name: '打开工作区', exact: true }).click();
    await page.getByRole('menuitem', { name: '任务中心', exact: true }).click();
    await page.locator('.task-table .task-batch-summary').click();
    const failure = page.locator('.task-analysis-failure');
    await expect(failure).toBeVisible();
    await expect(failure).toContainText('模型服务认证失败');
    await expect(failure).toContainText('API 密钥');
    await expect(failure).toContainText('PROVIDER_HTTP_401');
    await page.getByRole('button', { name: '复制错误信息', exact: true }).click();
    await expect(page.getByRole('button', { name: '复制错误信息', exact: true })).toHaveAttribute('title', '已复制错误信息');
    const clipboard = await app.evaluate(({ clipboard }) => clipboard.readText());
    expect(clipboard).toContain('PROVIDER_HTTP_401');
    expect(clipboard).toContain('API 密钥');
    await page.screenshot({ path: 'test-results/analysis-failure.png' });
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
