import { createServer, type Server } from 'node:http';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';

import type { AnalysisResult } from '../../packages/contracts/src';
import { CatalogService } from '../../apps/desktop/src/main/catalog-service';

let electronApp: ElectronApplication;
let page: Page;
let mockServer: Server;
let testRoot: string;
let sourcePath: string;
let originalBytes: Buffer;

const analysis: AnalysisResult = {
  schemaVersion: '1.0',
  summary: '可清理背景的人像',
  report: '主体清晰，建议移除背景路人并保持人物身份与光线方向。',
  quality: {
    overallScore: 84,
    issues: [{ type: 'background_distraction', severity: 0.8, confidence: 0.94, description: '背景路人干扰主体' }]
  },
  adjustments: { global: [], local: [] },
  generativeActions: [{
    id: 'remove-person', type: 'remove_object', target: '背景路人', region: null,
    instruction: '移除背景路人并自然补全环境', preserve: ['人物身份', '服装细节'],
    risk: 'low', confidence: 0.94, enabled: true
  }],
  catalog: {
    shortDescription: '自然光环境人像', longDescription: '人物站在户外环境中。',
    scenes: ['户外'], subjects: ['人物'], objects: ['人物', '路人'], mood: ['自然'],
    colors: ['绿色'], keywords: ['人像', '自然光'], ocrText: ''
  },
  generationRecommendation: { recommended: true, templateId: null, reason: '背景存在干扰人物' }
};

test.beforeAll(async () => {
  testRoot = await mkdtemp(path.join(tmpdir(), 'photoallisai-generation-e2e-'));
  const userData = path.join(testRoot, 'user-data');
  const sourceDirectory = path.join(testRoot, 'source');
  const libraryDirectory = path.join(userData, 'library');
  await Promise.all([mkdir(sourceDirectory, { recursive: true }), mkdir(libraryDirectory, { recursive: true })]);
  sourcePath = path.join(sourceDirectory, 'ORIGINAL.jpg');
  await copyFile(path.resolve('apps/desktop/src/renderer/public/demo/portrait.jpg'), sourcePath);
  originalBytes = await readFile(sourcePath);
  const generatedJpeg = await readFile(path.resolve('apps/desktop/src/renderer/public/demo/portrait.jpg'));

  mockServer = createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    if (request.url === '/v1/chat/completions') {
      response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(analysis) } }] }));
      return;
    }
    if (request.url === '/v1/images/edits') {
      response.end(JSON.stringify({ data: [{ b64_json: generatedJpeg.toString('base64') }] }));
      return;
    }
    response.end(JSON.stringify({ data: [] }));
  });
  await new Promise<void>((resolve) => mockServer.listen(0, '127.0.0.1', resolve));

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
  await new Promise<void>((resolve) => mockServer.close(() => resolve()));
  await rm(testRoot, { recursive: true, force: true });
});

test('analyzes, generates, compares, and persists managed and portable results', async () => {
  test.setTimeout(60_000);
  const address = mockServer.address();
  if (!address || typeof address === 'string') throw new Error('Mock server unavailable');
  const baseUrl = `http://127.0.0.1:${address.port}/v1`;

  await page.getByRole('tab', { name: /设置/ }).click();
  await page.getByLabel('配置名称').fill('Vision Mock');
  await page.getByLabel('Base URL').fill(baseUrl);
  await page.getByLabel('Model ID').fill('vision-test');
  await page.getByLabel('模型请求超时').selectOption('120000');
  await page.getByLabel('模型自动重试次数').selectOption('3');
  await page.getByLabel('模型自定义请求头').fill('{"OpenAI-Organization":"org-e2e"}');
  await page.getByLabel('API Key').fill('test-key');
  await page.getByRole('button', { name: '保存配置' }).click();
  await expect(page.getByText('配置已安全保存')).toBeVisible();

  await page.getByLabel('用途').selectOption('generation');
  await page.getByLabel('接口类型').selectOption('nanobanana-compatible');
  await page.getByLabel('配置名称').fill('Generation Mock');
  await page.getByLabel('Base URL').fill(baseUrl);
  await page.getByLabel('Model ID').fill('image-test');
  await page.getByLabel('模型请求超时').selectOption('300000');
  await page.getByLabel('模型自动重试次数').selectOption('2');
  await page.getByLabel('API Key').fill('test-key');
  await page.getByRole('button', { name: '保存配置' }).click();
  await expect(page.getByText('Generation Mock')).toBeVisible();
  const savedProfiles = await page.evaluate(() => window.desktopApi.listProviderProfiles());
  expect(savedProfiles.find((profile) => profile.name === 'Vision Mock')).toMatchObject({
    requestTimeoutMs: 120_000, retryCount: 3, customHeaders: { 'OpenAI-Organization': 'org-e2e' }
  });
  expect(savedProfiles.find((profile) => profile.name === 'Generation Mock')).toMatchObject({
    requestTimeoutMs: 300_000, retryCount: 2, customHeaders: {}
  });

  await page.getByLabel('导出预设名称').fill('PNG 交付');
  await page.getByLabel('导出格式').selectOption('png');
  await page.getByLabel('导出尺寸').selectOption('2048');
  await page.getByRole('button', { name: '保存预设' }).click();
  await expect(page.getByText('预设已保存', { exact: true })).toBeVisible();

  await page.getByRole('tab', { name: '图库' }).click();
  await page.getByRole('button', { name: '开始分析' }).click();
  await expect(page.getByText('可清理背景的人像')).toBeVisible({ timeout: 10_000 });
  await page.getByLabel('搜索图库').fill('自然光');
  await expect(page.getByText('搜索：自然光')).toBeVisible();
  await expect(page.getByText('ORIGINAL.jpg', { exact: true }).first()).toBeVisible();
  await page.getByLabel('搜索图库').fill('');
  await expect(page.getByText('所有照片', { exact: true }).first()).toBeVisible();

  await page.getByRole('button', { name: '减少生成数量' }).click();
  await page.getByRole('button', { name: '减少生成数量' }).click();
  await page.getByRole('button', { name: /加入生成队列/ }).click();
  await expect(page.getByText('V1', { exact: true })).toBeVisible({ timeout: 10_000 });

  const generated = page.locator('.generated-layer img');
  await expect(generated).toHaveAttribute('src', /^photoresult:\/\/result\//);
  await expect.poll(() => generated.evaluate((image) => image.naturalWidth)).toBeGreaterThan(0);
  expect(await page.locator('.base-image').evaluate((image) => getComputedStyle(image).filter)).toBe('none');
  expect(await generated.evaluate((image) => getComputedStyle(image).filter)).toBe('none');

  await page.getByRole('button', { name: '关闭任务抽屉' }).click();
  await page.getByRole('button', { name: '标记为首选' }).click();
  await expect(page.getByRole('status')).toContainText('已标记为首选版本');
  await page.reload();
  await expect(page.getByRole('button', { name: '标记为首选' })).toBeVisible();
  await expect(page.locator('.version-button.is-preferred')).toBeVisible();

  await page.getByRole('tab', { name: /设置/ }).click();
  await page.getByRole('button', { name: '图库与存储' }).click();
  const storageSection = page.locator('.storage-section');
  await storageSection.getByRole('radio', { name: /原图旁便携目录/ }).check();
  await expect(storageSection.getByRole('status')).toContainText('存储策略已保存');
  await page.getByRole('tab', { name: '图库' }).click();
  await page.getByRole('button', { name: /加入生成队列/ }).click();
  await expect(page.getByText('V2', { exact: true })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole('button', { name: '在文件管理器中显示生成版本' })).toBeEnabled();

  await page.getByRole('button', { name: '关闭任务抽屉' }).click();
  const generatedRoot = path.join(testRoot, 'user-data', 'library', 'generated');
  const managedFiles = await readdir(generatedRoot, { recursive: true });
  const managedResult = managedFiles.find((file) => file.endsWith('.jpg'));
  expect(managedResult).toBeTruthy();
  const managedResultPath = path.join(generatedRoot, managedResult!);
  await page.getByRole('button', { name: '版本', exact: true }).click();
  await page.getByRole('button', { name: '回收版本 V1' }).click();
  await page.getByRole('button', { name: '确认', exact: true }).click();
  await expect(page.getByText('版本回收站')).toBeVisible();
  await expect(page.getByRole('status')).toContainText('生成版本已移到应用回收站');
  await expect(stat(managedResultPath)).rejects.toMatchObject({ code: 'ENOENT' });
  const trashRoot = path.join(testRoot, 'user-data', 'library', 'trash', 'generation');
  expect((await readdir(trashRoot, { recursive: true })).some((file) => file.endsWith('.jpg'))).toBe(true);
  await page.screenshot({ path: path.resolve('test-results/generation-version-trash.png') });

  await page.getByRole('button', { name: '恢复版本 V1' }).click();
  await expect(page.getByText('版本回收站')).toHaveCount(0);
  await expect(page.getByRole('status')).toContainText('生成版本已恢复');
  expect((await stat(managedResultPath)).isFile()).toBe(true);

  const exportDirectory = path.join(testRoot, 'exported');
  await mkdir(exportDirectory, { recursive: true });
  await electronApp.evaluate(({ dialog }, directory) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory], bookmarks: [] });
  }, exportDirectory);
  await page.getByLabel('导出预设').selectOption({ label: 'PNG 交付' });
  await page.getByRole('button', { name: '导出当前版本' }).click();
  await expect(page.getByText('已导出 1 个文件')).toBeVisible();
  const exportedFiles = (await readdir(exportDirectory)).filter((name) => name.endsWith('.png'));
  expect(exportedFiles).toHaveLength(1);
  const exportedBytes = await readFile(path.join(exportDirectory, exportedFiles[0]!));
  expect(exportedBytes.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const exportedSize = await electronApp.evaluate(({ nativeImage }, filePath) => nativeImage.createFromPath(filePath).getSize(), path.join(exportDirectory, exportedFiles[0]!));
  expect(exportedSize).toEqual({ width: 1638, height: 2048 });
  expect(await readFile(sourcePath)).toEqual(originalBytes);

  await electronApp.evaluate(({ shell }) => {
    shell.openPath = async (target) => {
      (globalThis as typeof globalThis & { openedExportDirectory?: string }).openedExportDirectory = target;
      return '';
    };
  });
  await page.getByRole('tab', { name: /任务中心/ }).click();
  const exportTask = page.locator('.task-table-row').filter({ hasText: '导出' }).first();
  await exportTask.getByRole('button', { name: '查看导出报告' }).click();
  const exportReport = page.getByRole('region', { name: '导出报告' });
  await expect(exportReport).toContainText(exportedFiles[0]!);
  await expect(exportReport).toContainText('成功 1');
  await exportReport.getByRole('button', { name: '打开导出目录' }).click();
  expect(await electronApp.evaluate(() => (globalThis as typeof globalThis & { openedExportDirectory?: string }).openedExportDirectory)).toBe(exportDirectory);
  await page.getByRole('tab', { name: '图库' }).click();

  await page.getByRole('button', { name: '版本', exact: true }).click();
  await page.getByRole('button', { name: '回收版本 V1' }).click();
  await page.getByRole('button', { name: '确认', exact: true }).click();
  await expect(page.getByText('版本回收站')).toBeVisible();
  await page.getByRole('tab', { name: /设置/ }).click();
  await page.getByRole('button', { name: '图库与存储' }).click();
  await expect(page.getByRole('heading', { name: '生成版本回收站' })).toBeVisible();
  await expect(page.getByText(/1 个版本/)).toBeVisible();
  await page.getByRole('button', { name: '清空回收站' }).click();
  const emptyTrashDialog = page.getByRole('alertdialog', { name: /永久清理 1 个生成版本/ });
  await expect(emptyTrashDialog).toBeVisible();
  await page.screenshot({ path: path.resolve('test-results/generation-trash-empty-confirmation.png'), animations: 'disabled' });
  await emptyTrashDialog.getByRole('button', { name: '永久清理' }).click();
  await expect(page.locator('.generation-trash-section').getByRole('status')).toContainText('已永久清理 1 个版本');
  await expect(page.getByText('回收站为空')).toBeVisible();
  await expect(stat(managedResultPath)).rejects.toMatchObject({ code: 'ENOENT' });
  expect((await readdir(trashRoot, { recursive: true })).some((file) => file.endsWith('.jpg'))).toBe(false);
  expect(await readFile(sourcePath)).toEqual(originalBytes);
  await expect(page.locator('.integrity-result')).toContainText('完整性正常');
  await page.getByRole('button', { name: '重新检查图库' }).click();
  await expect(page.locator('.diagnostics-section').getByRole('status')).toContainText('图库完整性检查通过');
  await page.locator('.diagnostics-section').scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.resolve('test-results/library-integrity-diagnostics.png'), animations: 'disabled' });

  const diagnosticPath = path.join(testRoot, 'diagnostics.json');
  await electronApp.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath, bookmark: '' });
  }, diagnosticPath);
  await page.getByRole('button', { name: '导出诊断文件' }).click();
  await expect(page.getByText(/诊断文件已保存/)).toBeVisible();
  const diagnosticBytes = await readFile(diagnosticPath);
  const diagnosticText = diagnosticBytes.toString('utf8');
  const diagnostic = JSON.parse(diagnosticText) as Record<string, unknown>;
  expect(Object.keys(diagnostic).sort()).toEqual(['generatedAt', 'snapshot']);
  expect(diagnosticText).not.toContain('test-key');
  expect(diagnosticText).not.toContain(baseUrl);
  expect(diagnosticText).not.toContain(sourcePath);
  expect(diagnosticText).not.toContain('移除背景路人');
  expect(diagnosticText).toContain('"integrity"');
  expect(diagnosticBytes.byteLength).toBeGreaterThan(100);

  const firstLevel = await readdir(generatedRoot);
  expect(firstLevel).toHaveLength(1);
  const portableRoot = path.join(path.dirname(sourcePath), '_PhotoAllIsAI');
  const portableFiles = await readdir(portableRoot, { recursive: true });
  expect(portableFiles.some((file) => file.endsWith('.jpg'))).toBe(true);
  expect(portableFiles.some((file) => file.endsWith('manifest.json'))).toBe(true);
});
