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
  await page.getByLabel('批次整体提示词').fill('水彩风格，保持人物身份');
  await items.first().locator('textarea').fill('FAIL_TEST 保留构图');
  await page.getByLabel('默认生成数量').fill('2');
  await page.getByRole('button', { name: '生成全部', exact: true }).click();
  const progress = page.getByRole('region', { name: '本批生成进度' });
  await expect(progress).toBeVisible();
  await expect(page.getByRole('button', { name: '生成中…', exact: true })).toBeDisabled();
  await expect(items.first()).not.toContainText('待识别');
  await expect(progress).toContainText('成功 2 / 4 个版本', { timeout: 25_000 });
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
  await expect(page.getByRole('region', { name: '本批生成进度' })).toContainText('成功 4 / 4 个版本', { timeout: 25_000 });
  await expect(page.locator('.batch-candidate')).toHaveCount(4);
  expect(requests).toHaveLength(6);
  await expect(page.getByRole('button', { name: '生成全部', exact: true })).toBeEnabled();
  await page.setViewportSize({ width: 1000, height: 760 });
  await expect(page.locator('.batch-workspace')).toBeVisible();
  await page.screenshot({ path: 'test-results/batch-generation-progress.png' });
});
