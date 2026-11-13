import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { _electron as electron, expect, test } from '@playwright/test';

import { CatalogService } from '../../apps/desktop/src/main/catalog-service';

test('restores sidebar and paged gallery positions with multiselection', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'photoallisai-position-'));
  const userData = path.join(root, 'user-data');
  const library = path.join(userData, 'library');
  await mkdir(library, { recursive: true });
  const databasePath = path.join(library, 'catalog.sqlite');
  new CatalogService(databasePath).close();
  const database = new DatabaseSync(databasePath);
  const insertFolder = database.prepare('INSERT INTO folders (id, path, name, imported_at) VALUES (?, ?, ?, 1)');
  const insertAsset = database.prepare(`INSERT INTO assets (id, folder_id, path, file_name, extension, size_bytes, modified_at, imported_at)
    VALUES (?, 'folder-main', ?, ?, '.jpg', 1024, ?, 1)`);
  database.exec('BEGIN IMMEDIATE');
  insertFolder.run('folder-main', path.join(root, 'photos'), 'Photos');
  for (let index = 0; index < 65; index += 1) insertFolder.run(`folder-${index}`, path.join(root, `empty-${index}`), `Empty ${index}`);
  for (let index = 0; index < 800; index += 1) {
    const name = `PHOTO_${String(index).padStart(4, '0')}.jpg`;
    insertAsset.run(`asset-${index}`, path.join(root, 'photos', name), name, index);
  }
  database.exec('COMMIT');
  database.close();

  const app = await electron.launch({ args: [path.resolve('apps/desktop/out/main/index.js')], env: { ...process.env, PHOTOALLISAI_USER_DATA: userData } });
  try {
    const page = await app.firstWindow();
    await expect(page.locator('.catalog-card').first()).toBeVisible();
    await page.getByRole('button', { name: '配置图库工具栏', exact: true }).click();
    await page.getByRole('checkbox', { name: '视图', exact: true }).check();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: '列表视图', exact: true }).click();
    const list = page.locator('.catalog-list-view');
    await list.evaluate((element) => { element.scrollTop = element.scrollHeight; });
    await expect.poll(() => list.evaluate((element) => element.scrollHeight)).toBeGreaterThan(20_000);
    await list.evaluate((element) => { element.scrollTop = 16_000; });
    await expect.poll(() => list.evaluate((element) => element.scrollTop)).toBeGreaterThan(15_000);
    const rows = list.locator('.catalog-list-row');
    await expect.poll(async () => Number((await rows.first().getAttribute('data-asset-id'))?.replace('asset-', ''))).toBeGreaterThan(200);
    await rows.first().click();
    await rows.nth(1).click({ modifiers: ['ControlOrMeta'] });
    const selectedIds = await rows.evaluateAll((items) => items.filter((item) => item.getAttribute('aria-selected') === 'true').map((item) => item.getAttribute('data-asset-id')));
    expect(selectedIds).toHaveLength(2);
    const sidebar = page.locator('.sidebar-scroll');
    await sidebar.evaluate((element) => { element.scrollTop = 500; });
    await expect.poll(() => page.evaluate(() => Number(localStorage.getItem('photoallisai.sidebar-scroll.v1')))).toBeGreaterThan(400);
    const sidebarTop = await sidebar.evaluate((element) => element.scrollTop);
    await page.getByRole('button', { name: '收起关联文件夹区域' }).click();
    await expect.poll(() => sidebar.evaluate((element) => element.scrollTop)).toBeLessThan(sidebarTop);
    await page.getByRole('button', { name: '展开关联文件夹区域' }).click();
    await expect.poll(() => sidebar.evaluate((element) => element.scrollTop)).toBeGreaterThan(sidebarTop - 10);
    await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('photoallisai.catalog-selection.v1') ?? '{}').ids?.length)).toBe(2);
    await expect.poll(() => page.evaluate(() => Math.max(...Object.values(JSON.parse(localStorage.getItem('photoallisai.catalog-scroll.v1') ?? '{}') as Record<string, number>)))).toBeGreaterThan(10_000);
    const topBeforeReload = await list.evaluate((element) => element.scrollTop);
    expect(topBeforeReload).toBeGreaterThan(10_000);
    await page.reload();
    await expect(page.locator('.catalog-list-view')).toBeVisible();
    await expect.poll(() => page.locator('.catalog-list-view').evaluate((element) => element.scrollTop), { timeout: 20_000 }).toBeGreaterThan(topBeforeReload - 100);
    await expect.poll(() => page.locator('.sidebar-scroll').evaluate((element) => element.scrollTop)).toBeGreaterThan(400);
    for (const id of selectedIds) await expect(page.locator(`.catalog-list-row[data-asset-id="${id}"]`)).toHaveAttribute('aria-selected', 'true');
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
