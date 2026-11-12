import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';

let app: ElectronApplication;
let page: Page;
let userData: string;

async function openTab(label: string): Promise<void> {
  const tab = page.getByRole('tab', { name: label, exact: true });
  if (await tab.count()) { await tab.click(); return; }
  await page.getByRole('button', { name: '打开工作区' }).click();
  await page.getByRole('menuitem', { name: label, exact: true }).click();
}

test.beforeAll(async () => {
  userData = await mkdtemp(path.join(tmpdir(), 'photoallisai-e2e-app-'));
  app = await electron.launch({ args: [path.resolve('apps/desktop/out/main/index.js')], env: { ...process.env, PHOTOALLISAI_USER_DATA: userData, PHOTOALLISAI_E2E_DEMO: '1' } });
  page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
});

test.afterAll(async () => {
  if (app) await app.close();
  if (userData) await rm(userData, { recursive: true, force: true });
});

test('starts in a secure library with catalog selection', async () => {
  await expect(page.getByRole('tab', { name: '图库', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.catalog-card')).toHaveCount(6);
  await expect(page.getByLabel('添加关联文件夹')).toBeVisible();
  expect(await page.evaluate(() => ({ api: typeof window.desktopApi, node: typeof (window as unknown as { process?: unknown }).process }))).toEqual({ api: 'object', node: 'undefined' });
  await page.getByRole('button', { name: '配置图库工具栏', exact: true }).click();
  await page.getByRole('checkbox', { name: '视图', exact: true }).check();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '列表视图', exact: true }).click();
  const all = page.getByRole('checkbox', { name: '全选当前列表', exact: true });
  await all.check();
  await expect(page.locator('.catalog-list-row input[type="checkbox"]:checked')).toHaveCount(6);
  await all.uncheck();
  await expect(page.locator('.catalog-list-row input[type="checkbox"]:checked')).toHaveCount(0);
  await page.getByRole('button', { name: '网格视图', exact: true }).click();
});

test('keeps both docks mounted and opens the viewer in place', async () => {
  await openTab('图库');
  await page.getByRole('button', { name: '详情', exact: true }).click();
  await page.locator('.catalog-card').first().click();
  const navigation = page.locator('.global-workspace-shell > .workspace-side-panel').first();
  const inspector = page.locator('.right-dock-stack');
  await navigation.evaluate((element) => { (element as HTMLElement).dataset.retained = 'yes'; });
  await inspector.evaluate((element) => { (element as HTMLElement).dataset.retained = 'yes'; });
  const before = await page.getByRole('tab').count();
  await page.locator('.catalog-card').first().dblclick();
  const viewer = page.getByRole('region', { name: '看图', exact: true });
  await expect(viewer).toBeVisible();
  await expect(page.getByRole('tab')).toHaveCount(before);
  await expect(navigation).toHaveAttribute('data-retained', 'yes');
  await expect(inspector).toHaveAttribute('data-retained', 'yes');
  await expect(page.locator('.inspector-info')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(viewer).toHaveCount(0);
  await expect(page.locator('.catalog-card').first()).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('button', { name: 'AI', exact: true }).click();
  await openTab('任务中心');
  await expect(navigation).toHaveAttribute('data-retained', 'yes');
  await expect(inspector).toHaveAttribute('data-retained', 'yes');
});

test('adds selected images to the batch queue and edits each prompt', async () => {
  await openTab('图库');
  const cards = page.locator('.catalog-card');
  await cards.first().click();
  await cards.first().click({ button: 'right' });
  await page.getByRole('menuitem', { name: /加入 AI 批量修图/ }).click();
  await openTab('图库');
  await cards.nth(1).click();
  await cards.nth(1).click({ button: 'right' });
  await page.getByRole('menuitem', { name: /加入 AI 批量修图/ }).click();
  await openTab('图片生成');
  await expect(page.locator('.batch-queue-item')).toHaveCount(2);
  await page.getByRole('textbox', { name: '批次整体提示词' }).fill('统一自然色调');
  const first = page.locator('.batch-queue-item').first();
  await first.locator('textarea').fill('仅本图去除背景杂物');
  await expect(page.locator('.batch-queue-item').nth(1).locator('textarea')).toHaveValue('');
  await first.locator('.batch-queue-source').dblclick();
  await expect(page.getByRole('region', { name: '看图', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(first.locator('textarea')).toHaveValue('仅本图去除背景杂物');
  await first.getByRole('button', { name: /移除/ }).click();
  await expect(page.locator('.batch-queue-item')).toHaveCount(1);
});

test('keeps settings distinct and preserves text editing shortcuts', async () => {
  await openTab('设置');
  await expect(page.getByRole('button', { name: 'AI 模型' })).toHaveAttribute('aria-current', 'page');
  await expect(page.getByLabel('Base URL')).toBeVisible();
  await expect(page.getByRole('heading', { name: '导出预设', exact: true })).toHaveCount(0);
  const url = page.getByLabel('Base URL');
  await url.fill('https://example.com/v1');
  await url.focus();
  await page.keyboard.press('Meta+A');
  await expect.poll(() => url.evaluate((element) => ({ start: (element as HTMLInputElement).selectionStart, end: (element as HTMLInputElement).selectionEnd }))).toEqual({ start: 0, end: 'https://example.com/v1'.length });
  await page.getByRole('button', { name: '外观' }).click();
  const centerNames = page.getByRole('checkbox', { name: '文件名居中' });
  await expect(centerNames).toBeChecked();
  await centerNames.uncheck();
  await expect(page.locator('html')).toHaveAttribute('data-catalog-file-name-centered', 'false');
  await centerNames.check();
  await expect(page.locator('html')).toHaveAttribute('data-catalog-file-name-centered', 'true');
  await page.getByRole('radio', { name: /浅色/ }).check();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.getByRole('radio', { name: /深色/ }).check();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.getByRole('button', { name: '导出' }).click();
  await expect(page.getByRole('heading', { name: '导出预设', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '图库与存储' }).click();
  await expect(page.getByRole('heading', { name: '图库备份' })).toBeVisible();
});

test('restores workspace state without creating viewer tabs', async () => {
  await openTab('图库');
  await page.locator('.catalog-card').nth(2).click();
  await openTab('任务中心');
  await expect.poll(() => page.evaluate(async () => (await window.desktopApi.getWorkspaceSession()).activeTab)).toBe('tasks');
  await page.reload();
  await expect(page.getByRole('tab', { name: /任务中心/ })).toHaveAttribute('aria-selected', 'true');
  await openTab('图库');
  await expect(page.locator('.catalog-card').nth(2)).toHaveAttribute('aria-selected', 'true');
  await page.locator('.catalog-card').nth(2).dblclick();
  await expect(page.getByRole('region', { name: '看图', exact: true })).toBeVisible();
  await expect(page.getByRole('tab', { name: '看图', exact: true })).toHaveCount(0);
});
