import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';

import { CatalogService } from '../../apps/desktop/src/main/catalog-service';

const visibleFixtureRoot = path.resolve('apps/desktop/src/renderer/public/demo');

let application: ElectronApplication;
let page: Page;
let root: string;

test.beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'photoallisai-list-window-'));
  const userData = path.join(root, 'user-data');
  const library = path.join(userData, 'library');
  await mkdir(library, { recursive: true });
  const databasePath = path.join(library, 'catalog.sqlite');
  new CatalogService(databasePath).close();
  const database = new DatabaseSync(databasePath);
  database.prepare('INSERT INTO folders (id, path, name, imported_at) VALUES (?, ?, ?, ?)')
    .run('many-list-photos', visibleFixtureRoot, 'Many Photos', 1);
  const insert = database.prepare(`
    INSERT INTO assets (id, folder_id, path, file_name, extension, size_bytes, modified_at, imported_at)
    VALUES (?, 'many-list-photos', ?, ?, '.jpg', 1024, ?, 1)
  `);
  database.exec('BEGIN IMMEDIATE');
  for (let index = 0; index < 1_200; index += 1) {
    const name = `PHOTO_${String(index).padStart(4, '0')}.jpg`;
    insert.run(`window-photo-${index}`, path.join(visibleFixtureRoot, name), name, Date.UTC(2020, 0, 1) + (1_200 - index) * 86_400_000);
  }
  database.exec('COMMIT');
  database.close();
  application = await electron.launch({ args: [path.resolve('apps/desktop/out/main/index.js')], env: { ...process.env, PHOTOALLISAI_USER_DATA: userData } });
  page = await application.firstWindow();
  await page.waitForLoadState('domcontentloaded');
});

test.afterAll(async () => {
  if (application) await application.close();
  if (root) await rm(root, { recursive: true, force: true });
});

async function showView(mode: '列表视图' | '网格视图' | '瀑布流视图') {
  const button = page.getByRole('button', { name: mode, exact: true });
  if (!(await button.isVisible())) {
    await page.getByRole('button', { name: '配置图库工具栏', exact: true }).click();
    await page.getByRole('checkbox', { name: '视图', exact: true }).check();
    await page.keyboard.press('Escape');
  }
  await button.click();
}

test('keeps a bounded list DOM after loading and jumping through 1200 photos', async () => {
  await expect(page.locator('.catalog-card').first()).toBeVisible();
  await showView('列表视图');
  const list = page.locator('.catalog-list-view');
  for (let pageIndex = 0; pageIndex < 12; pageIndex += 1) {
    await list.evaluate((element) => { element.scrollTop = element.scrollHeight; });
    await expect.poll(() => page.locator('.catalog-toolbar-count').textContent()).toContain('1200');
    await page.waitForTimeout(120);
    if (await page.locator('.catalog-load-more').count() === 0) break;
  }
  await expect.poll(() => list.evaluate((element) => element.scrollHeight)).toBeGreaterThan(50_000);
  expect(await page.locator('.catalog-list-row').count()).toBeLessThan(100);
  await list.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await expect(page.locator('.catalog-list-row').last()).toContainText('PHOTO_1199.jpg');
  await page.locator('.catalog-list-row').last().click();
  await expect(page.locator('.catalog-list-row.is-selected')).toContainText('PHOTO_1199.jpg');
});

test('keeps analysis and tags columns windowed while jumping through the catalog', async () => {
  await showView('列表视图');
  const list = page.locator('.catalog-list-view');
  await expect(list).toBeVisible();
  await list.locator('.catalog-list-header').click({ button: 'right' });
  await page.getByRole('menuitemcheckbox', { name: '分析' }).click();
  await list.locator('.catalog-list-header').click({ button: 'right' });
  await page.getByRole('menuitemcheckbox', { name: '标签' }).click();
  await list.locator('.catalog-list-header').click({ button: 'right' });
  await page.getByRole('menuitemcheckbox', { name: '建议' }).click();
  for (let pageIndex = 0; pageIndex < 12; pageIndex += 1) {
    await list.evaluate((element) => { element.scrollTop = element.scrollHeight; });
    if (await page.locator('.catalog-load-more').count() === 0) break;
    await expect.poll(() => page.locator('.catalog-toolbar-count').textContent()).toContain('1200');
  }
  await expect(list.locator('.catalog-list-row').last()).toContainText('PHOTO_1199.jpg');
  expect(await list.locator('.catalog-list-row').count()).toBeLessThan(100);
  await list.evaluate((element) => { element.scrollTop = 0; });
  await expect(list.locator('.catalog-list-row').first()).toContainText('PHOTO_0000.jpg');
  expect(await list.locator('.catalog-list-row').count()).toBeLessThan(100);
  await expect(list.locator('.catalog-list-row').first().locator('.catalog-list-cell-analysis')).toBeVisible();
});

test('keeps grouped list headings and rows windowed across months', async () => {
  await showView('列表视图');
  await page.getByRole('button', { name: '配置图库工具栏', exact: true }).click();
  await page.getByRole('checkbox', { name: '分组:月份', exact: true }).check();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '按月份分组', exact: true }).click();
  const list = page.locator('.catalog-list-view');
  await expect(list.locator('.catalog-group-heading').first()).toBeVisible();
  expect(await list.locator('.catalog-list-row').count()).toBeLessThan(100);
  expect(await list.locator('.catalog-group-heading').count()).toBeLessThan(10);
  for (const fraction of [0.15, 0.3, 0.45, 0.6, 0.75, 0.9]) {
    await list.evaluate((element, position) => { element.scrollTop = element.scrollHeight * position; }, fraction);
    await expect.poll(() => list.locator('.catalog-list-row').first().getAttribute('data-asset-id')).not.toBe('window-photo-0');
    expect(await list.locator('.catalog-list-row').count()).toBeLessThan(100);
    expect(await list.locator('.catalog-group-heading').count()).toBeLessThan(10);
  }
  await list.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await expect(list.locator('.catalog-list-row').last()).toContainText('PHOTO_1199.jpg');
  expect(await list.locator('.catalog-list-row').count()).toBeLessThan(100);
  await list.locator('.catalog-list-row').last().click();
  await expect(list.locator('.catalog-list-row.is-selected')).toContainText('PHOTO_1199.jpg');
  await list.evaluate((element) => { element.scrollTop = 0; });
  await expect(list.locator('.catalog-list-row').first()).toContainText('PHOTO_0000.jpg');
  await page.getByRole('button', { name: '按月份分组', exact: true }).click();
});

test('keeps a high-cardinality daily grouping windowed', async () => {
  await showView('列表视图');
  await page.getByRole('button', { name: '配置图库工具栏', exact: true }).click();
  await page.getByRole('checkbox', { name: '分组:日期', exact: true }).check();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '按日期分组', exact: true }).click();
  const list = page.locator('.catalog-list-view');
  for (const fraction of [0, 0.1, 0.3, 0.5, 0.7, 0.9, 1]) {
    await list.evaluate((element, position) => { element.scrollTop = element.scrollHeight * position; }, fraction);
    await expect.poll(() => list.locator('.catalog-group-heading').count()).toBeGreaterThan(0);
    expect(await list.locator('.catalog-group-heading').count()).toBeLessThan(100);
    expect(await list.locator('.catalog-list-row').count()).toBeLessThan(100);
  }
  await expect(list.locator('.catalog-list-row').last()).toContainText('PHOTO_1199.jpg');
  await page.getByRole('button', { name: '按日期分组', exact: true }).click();
});

test('keeps grouped grid cards and headings windowed during large jumps', async () => {
  await showView('网格视图');
  const grid = page.getByRole('listbox', { name: '图库照片' });
  for (let pageIndex = 0; pageIndex < 12; pageIndex += 1) {
    await grid.evaluate((element) => { element.scrollTop = element.scrollHeight; });
    await expect.poll(() => page.locator('.catalog-toolbar-count').textContent()).toContain('1200');
    if (await page.locator('.catalog-load-more').count() === 0) break;
  }
  await page.getByRole('button', { name: '配置图库工具栏', exact: true }).click();
  await page.getByRole('checkbox', { name: '分组:日期', exact: true }).check();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '按日期分组', exact: true }).click();
  await expect(grid).toHaveClass(/is-windowed/);
  const scrollHeight = await grid.evaluate((element) => element.scrollHeight);
  for (const fraction of [0, 0.15, 0.4, 0.7, 1]) {
    await grid.evaluate((element, position) => { element.scrollTop = element.scrollHeight * position; }, fraction);
    await expect.poll(() => grid.locator('.catalog-photo-group').count()).toBeGreaterThan(0);
    await expect.poll(() => grid.evaluate((element) => {
      const viewport = element.getBoundingClientRect();
      return [...element.querySelectorAll('.catalog-card')].some((card) => {
        const rect = card.getBoundingClientRect();
        return rect.bottom > viewport.top && rect.top < viewport.bottom;
      });
    })).toBe(true);
    expect(await grid.evaluate((element) => element.scrollHeight)).toBe(scrollHeight);
    expect(await grid.locator('.catalog-photo-group').count()).toBeLessThan(30);
    expect(await grid.locator('.catalog-card').count()).toBeLessThan(150);
  }
  await expect(grid.locator('.catalog-card').last()).toContainText('PHOTO_1199.jpg');
  await grid.locator('.catalog-card').last().click();
  await expect(grid.locator('.catalog-card.is-selected')).toContainText('PHOTO_1199.jpg');
  await grid.evaluate((element) => { element.scrollTop = 0; });
  await expect(grid.locator('.catalog-card').first()).toContainText('PHOTO_0000.jpg');
  expect(await grid.locator('[data-asset-id="window-photo-1198"]').count()).toBe(0);
  await grid.focus();
  await page.keyboard.press('ArrowLeft');
  await expect(grid.locator('.catalog-card.is-focused')).toHaveAttribute('data-asset-id', 'window-photo-1198');
  await expect(grid.locator('.catalog-card.is-focused')).toBeInViewport();
  expect(await grid.evaluate((element) => element.scrollHeight)).toBe(scrollHeight);
  await page.getByRole('button', { name: '按日期分组', exact: true }).click();
});

test('keeps daily grouped masonry cards and headings windowed', async () => {
  await showView('瀑布流视图');
  const grid = page.getByRole('listbox', { name: '图库照片' });
  for (let pageIndex = 0; pageIndex < 12; pageIndex += 1) {
    await grid.evaluate((element) => { element.scrollTop = element.scrollHeight; });
    await expect.poll(() => page.locator('.catalog-toolbar-count').textContent()).toContain('1200');
    if (await page.locator('.catalog-load-more').count() === 0) break;
  }
  await page.getByRole('button', { name: '配置图库工具栏', exact: true }).click();
  await page.getByRole('checkbox', { name: '分组:日期', exact: true }).check();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '按日期分组', exact: true }).click();
  await expect(grid).toHaveClass(/is-windowed/);
  const height = await grid.evaluate((element) => element.scrollHeight);
  for (const fraction of [0, 0.2, 0.5, 0.8, 1]) {
    await grid.evaluate((element, position) => { element.scrollTop = element.scrollHeight * position; }, fraction);
    await expect.poll(() => grid.locator('.catalog-photo-group').count()).toBeGreaterThan(0);
    await expect.poll(() => grid.evaluate((element) => {
      const viewport = element.getBoundingClientRect();
      return [...element.querySelectorAll('.catalog-card')].some((card) => {
        const rect = card.getBoundingClientRect();
        return rect.bottom > viewport.top && rect.top < viewport.bottom;
      });
    })).toBe(true);
    expect(await grid.locator('.catalog-photo-group').count()).toBeLessThan(100);
    expect(await grid.locator('.catalog-card').count()).toBeLessThan(100);
    expect(await grid.evaluate((element) => element.scrollHeight)).toBe(height);
  }
  await expect(grid.locator('.catalog-card').last()).toContainText('PHOTO_1199.jpg');
  await grid.locator('.catalog-card').last().click();
  await grid.evaluate((element) => { element.scrollTop = 0; });
  await grid.focus();
  await page.keyboard.press('ArrowLeft');
  await expect(grid.locator('.catalog-card.is-focused')).toHaveAttribute('data-asset-id', 'window-photo-1198');
  await expect(grid.locator('.catalog-card.is-focused')).toBeInViewport();
  const focusedBeforeZoom = await grid.locator('.catalog-card.is-focused').boundingBox();
  await grid.locator('.catalog-card.is-focused').evaluate((card) => {
    const bounds = card.getBoundingClientRect();
    card.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, ctrlKey: true, deltaY: -160, clientX: bounds.left + bounds.width / 2, clientY: bounds.top + bounds.height / 2 }));
  });
  await expect.poll(() => grid.evaluate((element) => element.scrollHeight)).not.toBe(height);
  await expect(grid.locator('.catalog-card.is-focused')).toBeInViewport();
  expect(await grid.locator('.catalog-card').count()).toBeLessThan(100);
  const focusedAfterZoom = await grid.locator('.catalog-card.is-focused').boundingBox();
  expect(Math.abs((focusedAfterZoom?.y ?? 0) - (focusedBeforeZoom?.y ?? 0))).toBeLessThan(100);
  await page.getByRole('button', { name: '按日期分组', exact: true }).click();
});

test('keeps a bounded grid DOM while scrolling a loaded catalog', async () => {
  await showView('网格视图');
  const grid = page.getByRole('listbox', { name: '图库照片' });
  await expect(grid).toBeVisible();
  await expect.poll(() => grid.evaluate((element) => element.scrollHeight)).toBeGreaterThan(10_000);
  expect(await grid.locator('.catalog-card').count()).toBeLessThan(150);
  await grid.evaluate((element) => { element.scrollTop = element.scrollHeight / 2; });
  await expect.poll(() => grid.locator('.catalog-card').first().getAttribute('data-asset-id')).not.toBe('window-photo-0');
  expect(await grid.locator('.catalog-card').count()).toBeLessThan(150);
  for (let pageIndex = 0; pageIndex < 6; pageIndex += 1) {
    await grid.evaluate((element) => { element.scrollTop = element.scrollHeight; });
    await expect.poll(() => page.locator('.catalog-toolbar-count').textContent()).toContain('1200');
    await page.waitForTimeout(120);
  }
  await grid.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await expect(grid.locator('.catalog-card').last()).toContainText('PHOTO_1199.jpg');
  await grid.locator('.catalog-card').last().click();
  await expect(grid.locator('.catalog-card.is-selected')).toContainText('PHOTO_1199.jpg');
  await grid.focus();
  await page.keyboard.press('ArrowLeft');
  await expect(grid.locator('.catalog-card.is-focused')).toHaveAttribute('data-asset-id', 'window-photo-1198');
  await page.keyboard.press('ArrowRight');
  await expect(grid.locator('.catalog-card.is-focused')).toHaveAttribute('data-asset-id', 'window-photo-1199');
  const columns = await grid.evaluate((element) => {
    const style = getComputedStyle(element);
    const width = element.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    return Math.floor((width + 10) / (parseFloat(style.getPropertyValue('--thumbnail-size')) + 10));
  });
  for (let index = 1; index <= 12; index += 1) {
    await page.keyboard.press('ArrowUp');
    await expect(grid.locator('.catalog-card.is-focused')).toHaveAttribute('data-asset-id', `window-photo-${1199 - columns * index}`);
  }
  const scrollTop = await grid.evaluate((element) => element.scrollTop);
  await application.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.webContents.send('catalog.changed.v1');
  });
  await page.waitForTimeout(500);
  await expect.poll(() => grid.evaluate((element) => element.scrollTop)).toBeGreaterThan(scrollTop - 500);
  await expect(grid.locator('.catalog-card.is-focused')).toHaveAttribute('data-asset-id', `window-photo-${1199 - columns * 12}`);
  await grid.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await expect(grid.locator('.catalog-card').last()).toContainText('PHOTO_1199.jpg');
});

test('updates a rating while keeping the loaded catalog and scroll position', async () => {
  await showView('网格视图');
  const grid = page.getByRole('listbox', { name: '图库照片' });
  await grid.evaluate((element) => { element.scrollTop = 0; });
  const first = grid.locator('.catalog-card').first();
  await expect(first).toHaveAttribute('data-asset-id', 'window-photo-0');
  const loadedHeight = await grid.evaluate((element) => element.scrollHeight);
  await first.click();
  await grid.focus();
  await page.keyboard.press('5');
  await expect(grid.locator('.catalog-card[data-asset-id="window-photo-0"] .catalog-card-rating')).toHaveAttribute('aria-label', '5 星');
  expect(await grid.evaluate((element) => element.scrollHeight)).toBe(loadedHeight);
});
