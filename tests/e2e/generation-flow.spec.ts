import { createServer, type Server } from 'node:http';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
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
  const generatedJpeg = await readFile(path.resolve('apps/desktop/src/renderer/public/demo/coast.jpg'));

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
  const address = mockServer.address();
  if (!address || typeof address === 'string') throw new Error('Mock server unavailable');
  const baseUrl = `http://127.0.0.1:${address.port}/v1`;

  await page.getByRole('tab', { name: /设置/ }).click();
  await page.getByLabel('配置名称').fill('Vision Mock');
  await page.getByLabel('Base URL').fill(baseUrl);
  await page.getByLabel('Model ID').fill('vision-test');
  await page.getByLabel('API Key').fill('test-key');
  await page.getByRole('button', { name: '保存配置' }).click();
  await expect(page.getByText('配置已安全保存')).toBeVisible();

  await page.getByLabel('用途').selectOption('generation');
  await page.getByLabel('接口类型').selectOption('nanobanana-compatible');
  await page.getByLabel('配置名称').fill('Generation Mock');
  await page.getByLabel('Base URL').fill(baseUrl);
  await page.getByLabel('Model ID').fill('image-test');
  await page.getByLabel('API Key').fill('test-key');
  await page.getByRole('button', { name: '保存配置' }).click();
  await expect(page.getByText('Generation Mock')).toBeVisible();

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

  await page.getByRole('button', { name: '关闭任务抽屉' }).click();
  await page.getByRole('button', { name: '标记为首选' }).click();
  await expect(page.getByRole('status')).toContainText('已标记为首选版本');
  await page.reload();
  await expect(page.getByRole('button', { name: '标记为首选' })).toBeVisible();
  await expect(page.locator('.version-button.is-preferred')).toBeVisible();

  await page.getByRole('tab', { name: /设置/ }).click();
  const storageSection = page.locator('.storage-section');
  await storageSection.getByRole('radio', { name: /原图旁便携目录/ }).check();
  await expect(storageSection.getByRole('status')).toContainText('存储策略已保存');
  await page.getByRole('tab', { name: '图库' }).click();
  await page.getByRole('button', { name: /加入生成队列/ }).click();
  await expect(page.getByText('V2', { exact: true })).toBeVisible({ timeout: 10_000 });

  const exportDirectory = path.join(testRoot, 'exported');
  await mkdir(exportDirectory, { recursive: true });
  await electronApp.evaluate(({ dialog }, directory) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory], bookmarks: [] });
  }, exportDirectory);
  await page.getByRole('button', { name: '关闭任务抽屉' }).click();
  await page.getByRole('button', { name: '导出当前版本' }).click();
  await expect(page.getByText('已导出 1 个文件')).toBeVisible();
  expect((await readdir(exportDirectory)).filter((name) => name.endsWith('.jpg'))).toHaveLength(1);
  expect(await readFile(sourcePath)).toEqual(originalBytes);

  const generatedRoot = path.join(testRoot, 'user-data', 'library', 'generated');
  const firstLevel = await readdir(generatedRoot);
  expect(firstLevel).toHaveLength(1);
  const portableRoot = path.join(path.dirname(sourcePath), '_PhotoAllIsAI');
  const portableFiles = await readdir(portableRoot, { recursive: true });
  expect(portableFiles.some((file) => file.endsWith('.jpg'))).toBe(true);
  expect(portableFiles.some((file) => file.endsWith('manifest.json'))).toBe(true);
});
