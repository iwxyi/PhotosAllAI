import path from 'node:path';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { _electron as electron, expect, test } from '@playwright/test';
import { CatalogService } from '../../apps/desktop/src/main/catalog-service';

test('sidebar restores the selected folder and scroll position after reload', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'photo-sidebar-restore-'));
  const userData = path.join(root, 'user-data');
  const folders = await Promise.all(Array.from({ length: 48 }, async (_, index) => {
    const folder = path.join(root, `folder-${String(index).padStart(2, '0')}`);
    await mkdir(folder);
    return folder;
  }));
  await mkdir(path.join(userData, 'library'), { recursive: true });
  const catalog = new CatalogService(path.join(userData, 'library', 'catalog.sqlite'));
  try { await catalog.importFolders(folders); }
  finally { catalog.close(); }
  const app = await electron.launch({ args: [path.resolve('apps/desktop/out/main/index.js')], env: { ...process.env, PHOTOALLISAI_USER_DATA: userData } });
  try {
    const page = await app.firstWindow();
    const tree = page.getByRole('tree', { name: '关联文件夹' });
    await expect(tree.getByRole('treeitem')).toHaveCount(folders.length);
    await tree.getByRole('treeitem', { name: /folder-35/ }).click();
    const sidebar = page.locator('.sidebar-scroll');
    await sidebar.evaluate((element) => { element.scrollTop = 320; });
    await expect.poll(() => sidebar.evaluate((element) => element.scrollTop)).toBeGreaterThan(250);
    await expect.poll(() => page.evaluate(async () => (await window.desktopApi.getWorkspaceSession()).library.selectedFolderId)).toBe(await tree.getByRole('treeitem', { name: /folder-35/ }).getAttribute('data-folder-id'));
    await expect.poll(() => page.evaluate(() => localStorage.getItem('photoallisai.sidebar-scroll.v1'))).toBe('320');
    await page.reload();
    await expect(tree.getByRole('treeitem')).toHaveCount(folders.length);
    await expect(tree.getByRole('treeitem', { name: /folder-35/ })).toHaveAttribute('aria-selected', 'true');
    await expect.poll(() => sidebar.evaluate((element) => element.scrollTop)).toBeGreaterThan(250);
    await sidebar.hover();
    await page.mouse.wheel(0, -180);
    await expect.poll(() => sidebar.evaluate((element) => element.scrollTop)).toBeLessThan(250);
    await expect.poll(() => page.evaluate(() => Number(localStorage.getItem('photoallisai.sidebar-scroll.v1')))).toBeLessThan(250);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
