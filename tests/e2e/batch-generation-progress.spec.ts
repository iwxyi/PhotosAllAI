import { createServer, type Server } from 'node:http';
import { copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { CatalogService } from '../../apps/desktop/src/main/catalog-service';

let app: ElectronApplication;
let page: Page;
let server: Server;
let root: string;
let fail = true;
const requests: Array<Record<string, unknown>> = [];

test.beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'photoallisai-batch-progress-'));
  const userData = path.join(root, 'user-data');
  const source = path.join(root, 'photos');
  const library = path.join(userData, 'library');
  await Promise.all([mkdir(source, { recursive: true }), mkdir(library, { recursive: true })]);
  const image = path.resolve('apps/desktop/src/renderer/public/demo/portrait.jpg');
  await Promise.all(['A.jpg', 'B.jpg'].map((name) => copyFile(image, path.join(source, name))));
  const jpeg = await readFile(image);
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString() || '{}') as Record<string, unknown>;
      requests.push(body);
      setTimeout(() => {
        if (req.url !== '/nano-banana/images') { res.writeHead(404); res.end('{}'); return; }
        if (fail && String(body.prompt).includes('FAIL_TEST')) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: { code: 'api_error' } }));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ success: true, data: [{ b64_json: jpeg.toString('base64') }] }));
      }, 1800);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const catalog = new CatalogService(path.join(library, 'catalog.sqlite'));
  await catalog.importFolders([source]);
  catalog.close();
  app = await electron.launch({ args: [path.resolve('apps/desktop/out/main/index.js')], env: { ...process.env, PHOTOALLISAI_USER_DATA: userData } });
  page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
});

test.afterAll(async () => {
  if (app) await app.close();
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  if (root) await rm(root, { recursive: true, force: true });
});

test('direct generation shows batch and image progress, retains candidates and retries only failures', async () => {
  test.setTimeout(90_000);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No fixture server');
  await page.evaluate(async (baseUrl) => {
    await window.desktopApi.saveProviderProfile({ name: 'ACE Fixture', kind: 'acedata-nano-banana', purpose: 'generation', baseUrl, modelId: 'nano-banana-pro', apiKey: 'fixture-key', enabled: true, isDefault: true, requestTimeoutMs: 300000, retryCount: 0, customHeaders: {} });
  }, `http://127.0.0.1:${address.port}`);
  await expect(page.locator('.catalog-card')).toHaveCount(2);
  await page.locator('.catalog-card').first().dblclick();
  await page.getByRole('button', { name: '添加到 AI 修图', exact: true }).click();
  await page.keyboard.press('Escape');
  await page.locator('.catalog-card').nth(1).dblclick();
  await page.getByRole('button', { name: '添加到 AI 修图', exact: true }).click();
  await page.getByRole('button', { name: '打开批量修图' }).click();
  const items = page.locator('.batch-queue-item');
  await expect(items).toHaveCount(2);
  await expect(items.first().getByPlaceholder('补充这张图片的独立要求')).toBeVisible();
  await expect(items.first().getByRole('button', { name: '运行 A.jpg' })).toBeVisible();
  await expect(items.first().getByText('本图补充要求')).toHaveCount(0);
  await expect(items.first().getByRole('spinbutton')).toHaveCount(0);
  await page.getByLabel('批次整体提示词').fill('水彩风格，保持人物身份');
  await items.first().locator('textarea').fill('FAIL_TEST 保留构图');
  await page.getByLabel('默认生成数量').fill('2');
  await page.getByRole('button', { name: '生成全部', exact: true }).click();
  const progress = page.getByRole('region', { name: '本批生成进度' });
  await expect(progress).toBeVisible();
  await expect(page.getByRole('button', { name: '全部运行中…', exact: true })).toBeDisabled();
  await page.getByRole('tab', { name: '图库', exact: true }).click();
  await expect(page.locator('.catalog-card')).toHaveCount(2);
  await page.locator('.catalog-card').first().dblclick();
  await expect(page.getByRole('region', { name: '看图', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByRole('tab', { name: '图片生成', exact: true }).click();
  await expect(progress).toBeVisible();
  await expect(items.first()).not.toContainText('待识别');
  await expect(progress).toContainText('完成 2/4 · 失败 2', { timeout: 25_000 });
  await expect(progress).toContainText('失败 2');
  await expect(items.first()).toContainText('生图请求被拒绝');
  await expect(items.first().getByRole('button', { name: '复制生成错误' })).toBeVisible();
  await expect(page.locator('.batch-candidate')).toHaveCount(2);
  expect(requests).toHaveLength(4);
  expect(requests.every((request) => request.action === 'edit' && Array.isArray(request.image_urls))).toBe(true);
  expect(requests.every((request) => String(request.prompt).includes('水彩风格'))).toBe(true);
  await page.reload();
  await expect(page.getByRole('region', { name: '本批生成进度' })).toContainText('失败 2');
  await expect(page.locator('.batch-candidate')).toHaveCount(2);
  fail = false;
  await page.getByRole('button', { name: '重试失败', exact: true }).click();
  await expect(page.getByRole('region', { name: '本批生成进度' })).toContainText('完成 4/4', { timeout: 25_000 });
  await expect(page.getByRole('region', { name: '本批生成进度' }).getByRole('progressbar')).toHaveCount(0);
  await expect(page.locator('.batch-candidate')).toHaveCount(4);
  await expect(items.first().getByRole('button', { name: '运行 A.jpg' })).toBeEnabled();
  expect(requests).toHaveLength(6);
  await expect(page.getByRole('button', { name: '生成全部', exact: true })).toBeEnabled();
  await page.setViewportSize({ width: 1000, height: 760 });
  await expect(page.locator('.batch-workspace')).toBeVisible();
  await page.screenshot({ path: 'test-results/batch-generation-progress.png' });
});

test('viewer remembers one target, temporarily overrides task originals and navigates batch results', async () => {
  test.setTimeout(90_000);
  await page.getByLabel('默认生成数量').fill('2');
  await page.getByRole('button', { name: '生成全部', exact: true }).click();
  await expect.poll(async () => page.evaluate(async () => {
    const assets = await window.desktopApi.listCatalogAssets();
    return (await Promise.all(assets.map((asset) => window.desktopApi.listGenerationResults(asset.id)))).flat().length;
  }), { timeout: 25_000 }).toBeGreaterThanOrEqual(8);
  await expect(page.locator('.batch-candidate')).toHaveCount(8);

  await page.getByRole('tab', { name: '图库', exact: true }).click();
  const card = page.locator('.catalog-card').first();
  const assetId = await card.getAttribute('data-asset-id');
  const results = await page.evaluate((id) => window.desktopApi.listGenerationResults(id!), assetId);
  const latest = [...results].sort((a, b) => b.createdAt - a.createdAt || b.version - a.version)[0]!;
  const firstInLatestBatch = results.filter((result) => result.batchId === latest.batchId).sort((a, b) => a.version - b.version)[0]!;
  const catalogTarget = page.getByLabel('图库流程版本', { exact: true });
  await catalogTarget.selectOption('no-ai');
  await expect(card.locator('img:not(.catalog-image-previous)')).not.toHaveAttribute('src', firstInLatestBatch.resultUrl);
  await catalogTarget.selectOption('latest-ai');
  await expect(card.locator('img:not(.catalog-image-previous)')).toHaveAttribute('src', firstInLatestBatch.resultUrl);
  await page.getByRole('button', { name: '配置图库工具栏', exact: true }).click();
  await page.getByRole('checkbox', { name: '视图', exact: true }).check();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '列表视图', exact: true }).click();
  await expect(page.locator(`.catalog-list-row[data-asset-id="${assetId}"] img:not(.catalog-image-previous)`)).toHaveAttribute('src', firstInLatestBatch.resultUrl);
  await page.getByRole('button', { name: '网格视图', exact: true }).click();
  await expect(card.locator('img:not(.catalog-image-previous)')).toHaveAttribute('src', firstInLatestBatch.resultUrl);
  await page.screenshot({ path: 'test-results/catalog-version-target.png' });
  await card.dblclick();
  const target = page.getByLabel('切换目标版本');
  await expect(target).toHaveValue('latest-ai');
  await expect(page.getByLabel('看图流程版本', { exact: true })).toHaveCount(0);
  await expect(page.locator('.viewer-actual-version, .viewer-target-label')).toHaveCount(0);
  await page.locator('.viewer-footer').click({ button: 'right' });
  await expect(page.getByRole('dialog', { name: '自定义看图工具栏' }).getByRole('checkbox', { name: '流程版本' })).toHaveCount(0);
  await page.getByRole('button', { name: '关闭工具栏设置' }).click();
  await target.selectOption('no-ai');
  await expect(target).toHaveValue('no-ai');
  await expect(catalogTarget).toHaveValue('no-ai');
  await target.selectOption('latest-ai');
  await expect(page.locator('.generated-layer img')).toHaveAttribute('src', firstInLatestBatch.resultUrl);
  await page.getByRole('button', { name: '详情', exact: true }).click();
  const fileInfo = page.locator('.inspector-info > .inspector-section').first();
  const fileValue = (label: string) => fileInfo.locator('.metadata-list > div').filter({ hasText: new RegExp(`^${label}`) }).locator('strong');
  const resultDetails = await page.evaluate((id) => window.desktopApi.getGenerationResultDetails(id), firstInLatestBatch.id);
  const originalDetails = await page.evaluate((id) => window.desktopApi.getFileDetails(id!), assetId);
  await expect(fileValue('文件名')).toHaveText(firstInLatestBatch.fileName);
  await expect(fileValue('尺寸')).toHaveText(`${resultDetails.width} × ${resultDetails.height}`);
  await expect(fileValue('文件大小')).toHaveText(/\S/);
  await expect(fileInfo.getByRole('button', { name: '复制文件路径' })).toHaveCount(0);
  await page.locator('.canvas-wrap').focus();
  await page.keyboard.down('Space');
  await expect(page.locator('.generated-layer img')).toHaveCount(0);
  await expect(fileValue('文件名')).toHaveText(path.basename(originalDetails.path));
  await expect(fileValue('尺寸')).toHaveText(`${originalDetails.width} × ${originalDetails.height}`);
  await expect(target).toHaveValue('latest-ai');
  await page.keyboard.up('Space');
  await expect(page.locator('.generated-layer img')).toHaveAttribute('src', firstInLatestBatch.resultUrl);
  await expect(fileValue('文件名')).toHaveText(firstInLatestBatch.fileName);
  await expect(page.locator(`.filmstrip .thumb[data-asset-id="${assetId}"] img:not(.catalog-image-previous)`)).toHaveAttribute('src', firstInLatestBatch.resultUrl);
  const stripIds = await page.locator('.filmstrip .thumb').evaluateAll((elements) => elements.map((element) => element.getAttribute('data-asset-id')!));
  for (const id of stripIds) {
    const candidates = await page.evaluate((assetId) => window.desktopApi.listGenerationResults(assetId), id);
    const newest = [...candidates].sort((a, b) => b.createdAt - a.createdAt || b.version - a.version)[0]!;
    const expected = candidates.filter((result) => result.batchId === newest.batchId).sort((a, b) => a.version - b.version)[0]!;
    await expect(page.locator(`.filmstrip .thumb[data-asset-id="${id}"] img:not(.catalog-image-previous)`)).toHaveAttribute('src', expected.resultUrl);
  }
  const otherId = stripIds.find((id) => id !== assetId)!;
  const otherResults = await page.evaluate((id) => window.desktopApi.listGenerationResults(id), otherId);
  const otherLatest = [...otherResults].sort((a, b) => b.createdAt - a.createdAt || b.version - a.version)[0]!;
  const otherFirst = otherResults.filter((result) => result.batchId === otherLatest.batchId).sort((a, b) => a.version - b.version)[0]!;
  await page.evaluate(() => {
    const state = { missingAiFrames: 0, running: true };
    Object.assign(window, { aiSwitchFrames: state });
    const sample = () => {
      if (!document.querySelector('.generated-layer img')) state.missingAiFrames++;
      if (state.running) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  for (let index = 0; index < 3; index++) {
    await page.locator(`.filmstrip .thumb[data-asset-id="${otherId}"]`).click();
    await expect(page.locator('.generated-layer img')).toHaveAttribute('src', otherFirst.resultUrl);
    await page.locator(`.filmstrip .thumb[data-asset-id="${assetId}"]`).click();
    await expect(page.locator('.generated-layer img')).toHaveAttribute('src', firstInLatestBatch.resultUrl);
  }
  expect(await page.evaluate(() => {
    const state = (window as unknown as { aiSwitchFrames: { running: boolean; missingAiFrames: number } }).aiSwitchFrames;
    state.running = false;
    return state.missingAiFrames;
  })).toBe(0);
  await page.keyboard.press('Escape');
  await card.dblclick();
  await expect(page.locator('.generated-layer img')).toHaveAttribute('src', firstInLatestBatch.resultUrl);
  await target.selectOption('no-ai');
  await expect(page.locator('.generated-layer img')).toHaveCount(0);
  await expect(page.locator(`.filmstrip .thumb[data-asset-id="${assetId}"] img:not(.catalog-image-previous)`)).not.toHaveAttribute('src', firstInLatestBatch.resultUrl);
  await page.keyboard.press('Escape');

  await page.getByRole('tab', { name: '图片生成', exact: true }).click();
  await page.locator(`.batch-queue-item[data-workflow-asset-id="${assetId}"] .batch-reference-preview`).first().click();
  await expect(target).toHaveValue('latest-ai');
  await expect(page.locator('.generated-layer img')).toHaveAttribute('src', firstInLatestBatch.resultUrl);
  expect(await page.evaluate(() => localStorage.getItem('photoallisai.viewer-version-target'))).toBe('no-ai');
  if (await page.getByRole('region', { name: '看图', exact: true }).isVisible()) {
    await page.locator('.canvas-wrap').focus();
    await page.keyboard.press('Escape');
  }
  await page.getByRole('tab', { name: '图库', exact: true }).click();
  await card.dblclick();
  await expect(target).toHaveValue('no-ai');
  await expect(page.locator('.generated-layer img')).toHaveCount(0);
  await page.keyboard.press('Escape');

  await page.getByRole('tab', { name: '图片生成', exact: true }).click();
  const candidates = page.locator('.batch-candidate');
  const reviewsBefore = await page.evaluate(async () => {
    const assets = await window.desktopApi.listCatalogAssets();
    return (await Promise.all(assets.map((asset) => window.desktopApi.listGenerationResults(asset.id)))).flat().map(({ id, reviewState }) => ({ id, reviewState }));
  });
  await candidates.nth(1).click();
  const reviewsAfter = await page.evaluate(async () => {
    const assets = await window.desktopApi.listCatalogAssets();
    return (await Promise.all(assets.map((asset) => window.desktopApi.listGenerationResults(asset.id)))).flat().map(({ id, reviewState }) => ({ id, reviewState }));
  });
  expect(reviewsAfter).toEqual(reviewsBefore);
  await page.locator('.canvas-wrap').focus();
  await page.keyboard.press('Escape');
  await candidates.nth(1).click({ button: 'right' });
  const batchMenu = page.getByRole('menu', { name: '批量修图操作' });
  await expect(batchMenu).toBeVisible();
  await expect(batchMenu.getByRole('menuitem', { name: '取消', exact: true })).toHaveCount(0);
  await expect(batchMenu.getByRole('menuitem', { name: '打开生成图位置' })).toBeVisible();
  await page.getByLabel('批次整体提示词', { exact: true }).click();
  await expect(batchMenu).toHaveCount(0);
  await candidates.first().click({ button: 'right' });
  await page.keyboard.press('Escape');
  await expect(batchMenu).toHaveCount(0);
  const candidateSources = await candidates.locator('img').evaluateAll((images) => images.map((image) => image.getAttribute('src')));
  for (let index = 0; index < 8; index++) {
    const expectedSource = await candidates.nth(index).locator('img').getAttribute('src');
    await candidates.nth(index).dblclick();
    const resultStrip = page.getByRole('listbox', { name: '本批 AI 图片' });
    await expect(resultStrip.getByRole('option')).toHaveCount(candidateSources.length);
    expect(new Set(await resultStrip.getByRole('option').evaluateAll((items) => items.map((item) => `photoresult://result/${item.getAttribute('data-result-id')}`)))).toEqual(new Set(candidateSources));
    await expect(page.locator('.generated-layer img')).toHaveAttribute('src', expectedSource!);
    await expect(page.locator('.viewer-result-position')).toContainText('AI 结果 ·');
    await page.locator('.canvas-wrap').focus();
    await page.keyboard.press('Escape');
  }
  await page.evaluate(() => {
    const state = { running: true, uncoveredFrames: 0 };
    Object.assign(window, { openingResultFrames: state });
    const sample = () => {
      const canvas = document.querySelector('.inline-photo-viewer .photo-canvas');
      if (canvas && !canvas.classList.contains('is-showing-generated')) state.uncoveredFrames++;
      if (state.running) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  await page.locator('.batch-queue-item').first().locator('.batch-candidate').last().dblclick();
  await expect(page.locator('.photo-canvas')).toHaveClass(/is-showing-generated/);
  await expect(page.locator('.generated-layer')).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  expect(await page.evaluate(() => {
    const state = (window as unknown as { openingResultFrames: { running: boolean; uncoveredFrames: number } }).openingResultFrames;
    state.running = false;
    return state.uncoveredFrames;
  })).toBe(0);
  const strip = page.getByRole('listbox', { name: '本批 AI 图片' });
  await expect(strip.getByRole('option')).toHaveCount(8);
  const resultIds = await strip.getByRole('option').evaluateAll((elements) => elements.map((element) => element.getAttribute('data-result-id')));
  for (let index = 0; index < resultIds.length; index++) {
    if (index === 0) await strip.getByRole('option').first().click();
    else { await page.locator('.canvas-wrap').focus(); await page.keyboard.press('ArrowRight'); }
    await expect(strip.getByRole('option').nth(index)).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('.generated-layer img')).toHaveAttribute('src', `photoresult://result/${resultIds[index]}`);
  }
  await strip.getByRole('option').nth(3).click();
  await strip.focus();
  await page.keyboard.press('ArrowLeft');
  await expect(strip.getByRole('option').nth(2)).toHaveAttribute('aria-selected', 'true');
  await expect(strip.getByRole('option').nth(2).locator('img')).toHaveCSS('opacity', '1');
  await expect.poll(() => strip.getByRole('option').nth(2).locator('img').evaluate((image) => image.naturalWidth)).toBeGreaterThan(0);
  expect(await page.evaluate(() => localStorage.getItem('photoallisai.viewer-version-target'))).toBe('no-ai');
  await page.screenshot({ path: 'test-results/viewer-task-result-filmstrip.png' });
  await page.locator('.canvas-wrap').focus();
  await page.keyboard.press('ArrowRight');
  await expect(strip.getByRole('option').nth(3)).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.generated-layer img')).toHaveAttribute('src', `photoresult://result/${resultIds[3]}`);
  await page.locator('.canvas-wrap').focus();
  await page.keyboard.press('ArrowLeft');
  await expect(strip.getByRole('option').nth(2)).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.generated-layer img')).toHaveAttribute('src', `photoresult://result/${resultIds[2]}`);
  await page.getByRole('button', { name: '拒绝当前版本' }).click();
  await expect(strip.getByRole('option')).toHaveCount(7);
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  await expect(page.locator('.generated-layer img')).toHaveAttribute('src', `photoresult://result/${resultIds[3]}`);
  await page.keyboard.press('Escape');

  await page.getByRole('button', { name: '打开工作区' }).click();
  await page.getByRole('menuitem', { name: '任务中心', exact: true }).click();
  const taskBatch = page.locator('.task-batch-group').filter({ has: page.locator('.task-batch-summary').filter({ hasText: '生成:' }) }).first();
  await taskBatch.locator(':scope > summary').click();
  await taskBatch.locator('.task-analysis-result').filter({ has: page.locator('summary', { hasText: '生成详情' }) }).first().locator('summary').click();
  await taskBatch.getByRole('button', { name: /^查看生成图片/ }).first().click();
  await expect(strip.getByRole('option')).toHaveCount(4);
  await expect(page.locator('.generated-layer img')).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('photoallisai.viewer-version-target'))).toBe('no-ai');
});

test('branches from a selected AI result and keeps the source relationship', async () => {
  test.setTimeout(60_000);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No fixture server');
  fail = false;
  await page.evaluate(async (baseUrl) => {
    await window.desktopApi.saveProviderProfile({ name: 'ACE Fixture', kind: 'acedata-nano-banana', purpose: 'generation', baseUrl, modelId: 'nano-banana-pro', apiKey: 'fixture-key', enabled: true, isDefault: true, requestTimeoutMs: 300000, retryCount: 0, customHeaders: {} });
  }, `http://127.0.0.1:${address.port}`);
  await page.reload();
  if (await page.getByRole('tab', { name: '图片生成', exact: true }).count() === 0) {
    await page.locator('.catalog-card').first().dblclick();
    await page.getByRole('button', { name: '添加到 AI 修图', exact: true }).click();
    await page.getByRole('button', { name: '打开批量修图' }).click();
  }
  await page.getByRole('tab', { name: '图片生成', exact: true }).click();
  await page.getByLabel('批次整体提示词').fill('自然修图');
  await page.getByLabel('默认生成数量').fill('1');
  if (await page.locator('.batch-candidate').count() === 0) {
    await page.getByRole('button', { name: '生成全部', exact: true }).click();
    await expect(page.locator('.batch-candidate')).toHaveCount(1);
  }
  const item = page.locator('.batch-queue-item').first();
  const assetId = (await item.getAttribute('data-workflow-asset-id'))!;
  const waitForGenerationIdle = async () => {
    await expect.poll(async () => page.evaluate(async (id) => {
      const taskPage = await window.desktopApi.listTaskPage({ includeBatchMembers: true, limit: 200, cursor: null });
      return taskPage.items.filter((task) => task.kind === 'generation' && task.assetId === id && !['completed', 'failed', 'canceled'].includes(task.status)).length;
    }, assetId), { timeout: 25_000 }).toBe(0);
    await expect(item.getByRole('button', { name: /再次生成|重试失败版本/ })).toBeEnabled();
  };
  await waitForGenerationIdle();
  const source = item.locator('.batch-candidate').first();
  const sourceId = (await source.locator('img').getAttribute('src'))!.split('/').at(-1)!;
  await source.click({ button: 'right' });
  await page.getByRole('menuitem', { name: '基于此版本继续修图' }).click();
  await expect.poll(async () => page.evaluate(async (id) => {
    const results = await window.desktopApi.listGenerationResults(id);
    return results.filter((result) => result.inputSources?.[0]?.kind === 'result').length;
  }, (await item.getAttribute('data-workflow-asset-id'))!)).toBeGreaterThanOrEqual(1);
  const result = await page.evaluate(async (id) => (await window.desktopApi.listGenerationResults(id)).find((entry) => entry.inputSources?.[0]?.kind === 'result'), (await item.getAttribute('data-workflow-asset-id'))!);
  expect(result?.inputSources?.[0]).toEqual({ kind: 'result', resultId: sourceId });
  const branch = item.locator(`.batch-tree-node[data-result-id="${result!.id}"]`);
  await expect(branch).toHaveAttribute('data-parent-result-id', sourceId);
  await expect(item.locator(`.batch-tree-links path[data-parent-result-id="${sourceId}"][data-child-result-id="${result!.id}"]`)).toHaveCount(1);
  expect(Number(await branch.locator('xpath=..').getAttribute('data-depth'))).toBeGreaterThan(Number(await source.locator('xpath=../..').getAttribute('data-depth')));
  await waitForGenerationIdle();
  await branch.locator('.batch-candidate').click({ button: 'right' });
  await page.getByRole('menuitem', { name: '基于此版本继续修图' }).click();
  const grandchild = item.locator(`.batch-tree-node[data-parent-result-id="${result!.id}"]`);
  await expect(grandchild).toHaveCount(1, { timeout: 15_000 });
  await expect(item.locator(`.batch-tree-links path[data-parent-result-id="${result!.id}"]`)).toHaveCount(1);
  expect(Number(await grandchild.locator('xpath=..').getAttribute('data-depth'))).toBe(2);
  await branch.locator('.batch-candidate').click();
  await expect(page.locator('.generated-layer img')).toHaveAttribute('src', result!.resultUrl);
  await page.locator('.canvas-wrap').focus();
  await page.keyboard.down('Space');
  await expect(page.locator('.base-image')).not.toHaveAttribute('src', `photoresult://result/${sourceId}`);
  await page.keyboard.up('Space');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '打开工作区' }).click();
  await page.getByRole('menuitem', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '外观', exact: true }).click();
  const compareSetting = page.getByRole('checkbox', { name: '生成图对比' });
  await expect(compareSetting).not.toBeChecked();
  await compareSetting.check();
  await page.getByRole('tab', { name: '图片生成', exact: true }).click();
  await item.locator(`.batch-tree-node[data-result-id="${result!.id}"] .batch-candidate`).click();
  await page.locator('.canvas-wrap').focus();
  await page.keyboard.down('Space');
  await expect(page.locator('.base-image')).toHaveAttribute('src', `photoresult://result/${sourceId}`);
  await page.keyboard.up('Space');
  await expect(page.locator('.generated-layer img')).toHaveAttribute('src', result!.resultUrl);
  await page.keyboard.press('Escape');
  await page.reload();
  await page.getByRole('button', { name: '打开工作区' }).click();
  await page.getByRole('menuitem', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '外观', exact: true }).click();
  await expect(page.getByRole('checkbox', { name: '生成图对比' })).toBeChecked();
});

test('adds a text-to-image item to the batch queue and lists its results in the selected folder', async () => {
  test.setTimeout(60_000);
  fail = false;
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No fixture server');
  await page.evaluate(async (baseUrl) => {
    await window.desktopApi.saveProviderProfile({ name: 'ACE Fixture', kind: 'acedata-nano-banana', purpose: 'generation', baseUrl, modelId: 'nano-banana-pro', apiKey: 'fixture-key', enabled: true, isDefault: true, requestTimeoutMs: 300000, retryCount: 0, customHeaders: {} });
  }, `http://127.0.0.1:${address.port}`);
  await page.reload();
  await page.getByRole('tab', { name: '图库', exact: true }).click();
  const folderId = await page.evaluate(async () => (await window.desktopApi.listCatalogFolders())[0]!.id);
  await page.locator(`[data-folder-id="${folderId}"]`).click();
  await page.getByRole('button', { name: 'AI', exact: true }).click();
  await page.getByRole('button', { name: '打开批量修图' }).click();
  await page.getByRole('button', { name: '添加生图队列项', exact: true }).click();
  const item = page.locator('[data-prompt-generation-item]').last();
  await expect(item.locator('.batch-queue-source')).toHaveCount(0);
  await expect(item.getByRole('button', { name: '添加参考图' })).toBeVisible();
  await expect(item.getByRole('textbox', { name: '生图提示词' })).toBeVisible();
  const compactLayout = await item.evaluate((element) => {
    const strip = element.querySelector('.batch-reference-strip')!.getBoundingClientRect();
    const prompt = element.querySelector('.batch-item-settings')!.getBoundingClientRect();
    return { stripWidth: strip.width, gap: prompt.left - strip.right };
  });
  expect(compactLayout.stripWidth).toBeLessThan(100);
  expect(compactLayout.gap).toBeGreaterThanOrEqual(0);
  expect(compactLayout.gap).toBeLessThan(20);
  await item.getByRole('textbox').fill('雨夜街头，霓虹倒映在湿润路面，电影感构图');
  await page.getByLabel('批次整体提示词').fill('高品质电影概念图');
  await page.getByLabel('默认生成数量').fill('2');
  const previousRequests = requests.length;
  await page.getByRole('button', { name: '生成全部', exact: true }).click();
  const itemId = (await item.getAttribute('data-prompt-generation-item'))!;
  await expect.poll(() => page.evaluate((id) => window.desktopApi.listTaskBatch({ kind: 'generation', batchId: id }).then((tasks) => tasks.length), itemId), { timeout: 25_000 }).toBe(2);
  await expect(item.locator('.batch-candidate')).toHaveCount(2, { timeout: 25_000 });
  await expect(item).toContainText('已生成 2 张');
  const textRequests = requests.slice(previousRequests).filter((request) => String(request.prompt).includes('雨夜街头'));
  expect(textRequests).toHaveLength(2);
  expect(textRequests.every((request) => request.action === 'generate' && Array.isArray(request.image_urls) && request.image_urls.length === 0)).toBe(true);
  expect(textRequests.every((request) => String(request.prompt).includes('高品质电影概念图'))).toBe(true);
  await item.locator('.batch-candidate').first().click();
  await expect(page.locator('.canvas-wrap')).toBeVisible();
  await page.keyboard.press('Escape');
});

test('adds ordered reference images to a folder generation item', async () => {
  test.setTimeout(60_000);
  fail = false;
  await page.getByRole('tab', { name: '图片生成', exact: true }).click();
  await page.getByRole('button', { name: '添加生图队列项', exact: true }).click();
  const item = page.locator('[data-prompt-generation-item]').last();
  await item.getByRole('button', { name: '添加参考图' }).click();
  const picker = page.getByRole('dialog', { name: '添加参考图' });
  await picker.getByLabel('搜索参考图').fill('A.jpg');
  await picker.getByRole('button', { name: 'A.jpg', exact: true }).click();
  await item.getByRole('button', { name: '添加参考图' }).click();
  await picker.getByLabel('搜索参考图').fill('B.jpg');
  await picker.getByRole('button', { name: 'B.jpg', exact: true }).click();
  await expect(item.locator('.batch-reference')).toHaveCount(2);
  const referenceLayout = await item.evaluate((element) => {
    const strip = element.querySelector('.batch-reference-strip')!.getBoundingClientRect();
    const prompt = element.querySelector('.batch-item-settings')!.getBoundingClientRect();
    return { stripWidth: strip.width, itemWidth: element.getBoundingClientRect().width, gap: prompt.left - strip.right };
  });
  expect(referenceLayout.stripWidth).toBeGreaterThan(200);
  expect(referenceLayout.stripWidth).toBeLessThan(referenceLayout.itemWidth / 2);
  expect(referenceLayout.gap).toBeLessThan(20);
  await item.locator('.batch-reference').nth(1).dragTo(item.locator('.batch-reference').first());
  await expect(item.locator('.batch-reference').first().getByRole('button', { name: '查看B.jpg' })).toBeVisible();
  await item.getByRole('textbox', { name: '生图提示词' }).fill('把两张参考照片融合为一张');
  const itemId = (await item.getAttribute('data-prompt-generation-item'))!;
  await item.getByRole('button', { name: '再次生成生图' }).click();
  await expect.poll(() => page.evaluate((id) => window.desktopApi.listTaskBatch({ kind: 'generation', batchId: id }).then((tasks) => tasks[0]?.status), itemId), { timeout: 25_000 }).toBe('completed');
  const task = await page.evaluate((id) => window.desktopApi.listTaskBatch({ kind: 'generation', batchId: id }).then((tasks) => tasks[0]), itemId);
  expect(task?.payload.inputSources).toHaveLength(2);
  const names = await page.evaluate(async (ids) => (await window.desktopApi.listCatalogAssetPage({ assetIds: ids, limit: 2 })).items.map((asset) => [asset.id, asset.fileName] as const), (task?.payload.inputSources as Array<{ assetId: string }>).map((source) => source.assetId));
  expect((task?.payload.inputSources as Array<{ assetId: string }>).map((source) => names.find(([id]) => id === source.assetId)?.[1])).toEqual(['B.jpg', 'A.jpg']);
  expect(requests.at(-1)?.action).toBe('edit');
  expect((requests.at(-1)?.image_urls as unknown[]).length).toBe(2);
});
