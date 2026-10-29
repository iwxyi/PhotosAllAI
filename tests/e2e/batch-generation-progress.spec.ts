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
  await page.getByRole('button', { name: '添加本图到批量修图' }).click();
  await page.keyboard.press('Escape');
  await page.locator('.catalog-card').nth(1).dblclick();
  await page.getByRole('button', { name: '添加本图到批量修图' }).click();
  await page.getByRole('button', { name: '打开批量修图' }).click();
  const items = page.locator('.batch-queue-item');
  await expect(items).toHaveCount(2);
  await expect(items.first().getByPlaceholder('补充这张图片的独立要求')).toBeVisible();
  await expect(items.first().getByRole('spinbutton')).toHaveAttribute('placeholder', '全局 1');
  await page.getByLabel('批次整体提示词').fill('水彩风格，保持人物身份');
  await items.first().locator('textarea').fill('FAIL_TEST 保留构图');
  await page.getByLabel('默认生成数量').fill('2');
  await page.getByRole('button', { name: '生成全部', exact: true }).click();
  const progress = page.getByRole('region', { name: '本批生成进度' });
  await expect(progress).toBeVisible();
  await expect(page.getByRole('button', { name: '生成中…', exact: true })).toBeDisabled();
  await expect(items.first()).not.toContainText('待识别');
  await expect(progress).toContainText('完成 2 · 失败 2', { timeout: 25_000 });
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
  await expect(page.getByRole('region', { name: '本批生成进度' })).toContainText('完成 4 · 失败 0', { timeout: 25_000 });
  await expect(page.getByRole('region', { name: '本批生成进度' }).getByRole('progressbar')).toHaveCount(0);
  await expect(page.locator('.batch-candidate')).toHaveCount(4);
  expect(requests).toHaveLength(6);
  await expect(page.getByRole('button', { name: '生成全部', exact: true })).toBeEnabled();
  await page.setViewportSize({ width: 1000, height: 760 });
  await expect(page.locator('.batch-workspace')).toBeVisible();
  await page.screenshot({ path: 'test-results/batch-generation-progress.png' });
});

test('viewer remembers one target, temporarily overrides task originals and navigates batch results', async () => {
  test.setTimeout(90_000);
  await page.getByRole('button', { name: '生成全部', exact: true }).click();
  await expect(page.getByRole('region', { name: '本批生成进度' })).toContainText('完成 4 · 失败 0', { timeout: 25_000 });
  await expect(page.locator('.batch-candidate')).toHaveCount(8);

  await page.getByRole('tab', { name: '图库', exact: true }).click();
  const card = page.locator('.catalog-card').first();
  const assetId = await card.getAttribute('data-asset-id');
  const results = await page.evaluate((id) => window.desktopApi.listGenerationResults(id!), assetId);
  const latest = [...results].sort((a, b) => b.createdAt - a.createdAt || b.version - a.version)[0]!;
  const firstInLatestBatch = results.filter((result) => result.batchId === latest.batchId).sort((a, b) => a.version - b.version)[0]!;
  const catalogTarget = page.getByLabel('图库流程版本', { exact: true });
  await catalogTarget.selectOption('no-ai');
  await expect(card.locator('img')).not.toHaveAttribute('src', firstInLatestBatch.resultUrl);
  await catalogTarget.selectOption('latest-ai');
  await expect(card.locator('img')).toHaveAttribute('src', firstInLatestBatch.resultUrl);
  await page.getByRole('button', { name: '配置图库工具栏', exact: true }).click();
  await page.getByRole('checkbox', { name: '视图', exact: true }).check();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '列表视图', exact: true }).click();
  await expect(page.locator(`.catalog-list-row[data-asset-id="${assetId}"] img`)).toHaveAttribute('src', firstInLatestBatch.resultUrl);
  await page.getByRole('button', { name: '网格视图', exact: true }).click();
  await expect(card.locator('img')).toHaveAttribute('src', firstInLatestBatch.resultUrl);
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
  await page.locator('.canvas-wrap').focus();
  await page.keyboard.down('Space');
  await expect(page.locator('.generated-layer img')).toHaveCount(0);
  await expect(target).toHaveValue('latest-ai');
  await page.keyboard.up('Space');
  await expect(page.locator('.generated-layer img')).toHaveAttribute('src', firstInLatestBatch.resultUrl);
  await expect(page.locator(`.filmstrip .thumb[data-asset-id="${assetId}"] img`)).toHaveAttribute('src', firstInLatestBatch.resultUrl);
  const stripIds = await page.locator('.filmstrip .thumb').evaluateAll((elements) => elements.map((element) => element.getAttribute('data-asset-id')!));
  for (const id of stripIds) {
    const candidates = await page.evaluate((assetId) => window.desktopApi.listGenerationResults(assetId), id);
    const newest = [...candidates].sort((a, b) => b.createdAt - a.createdAt || b.version - a.version)[0]!;
    const expected = candidates.filter((result) => result.batchId === newest.batchId).sort((a, b) => a.version - b.version)[0]!;
    await expect(page.locator(`.filmstrip .thumb[data-asset-id="${id}"] img`)).toHaveAttribute('src', expected.resultUrl);
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
  await expect(page.locator(`.filmstrip .thumb[data-asset-id="${assetId}"] img`)).not.toHaveAttribute('src', firstInLatestBatch.resultUrl);
  await page.keyboard.press('Escape');

  await page.getByRole('tab', { name: 'AI 批量修图', exact: true }).click();
  await page.locator(`.batch-queue-item[data-workflow-asset-id="${assetId}"] .batch-queue-source`).dblclick();
  await expect(target).toHaveValue('latest-ai');
  await expect(page.locator('.generated-layer img')).toHaveAttribute('src', firstInLatestBatch.resultUrl);
  expect(await page.evaluate(() => localStorage.getItem('photoallisai.viewer-version-target'))).toBe('no-ai');
  await page.keyboard.press('Escape');
  await page.getByRole('tab', { name: '图库', exact: true }).click();
  await card.dblclick();
  await expect(target).toHaveValue('no-ai');
  await expect(page.locator('.generated-layer img')).toHaveCount(0);
  await page.keyboard.press('Escape');

  await page.getByRole('tab', { name: 'AI 批量修图', exact: true }).click();
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
    expect(await resultStrip.getByRole('option').evaluateAll((items) => items.map((item) => `photoresult://result/${item.getAttribute('data-result-id')}`))).toEqual(candidateSources);
    await expect(page.locator('.generated-layer img')).toHaveAttribute('src', expectedSource!);
    await expect(page.locator('.viewer-result-position')).toHaveText(`AI 结果 · ${index + 1}/8`);
    await page.locator('.canvas-wrap').focus();
    await page.keyboard.press('Escape');
  }
  await page.locator('.batch-queue-item').first().locator('.batch-candidate').last().dblclick();
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
  const taskBatch = page.locator('.task-batch-group').filter({ has: page.locator('.task-batch-summary').filter({ hasText: '图片生成' }) }).first();
  await taskBatch.locator(':scope > summary').click();
  await taskBatch.locator('.task-analysis-result').filter({ has: page.locator('summary', { hasText: '生成详情' }) }).first().locator('summary').click();
  await taskBatch.getByRole('button', { name: /^查看生成图片/ }).first().click();
  await expect(strip.getByRole('option')).toHaveCount(4);
  await expect(page.locator('.generated-layer img')).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('photoallisai.viewer-version-target'))).toBe('no-ai');
});
