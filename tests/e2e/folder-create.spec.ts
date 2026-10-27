import path from 'node:path';
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { _electron as electron, expect, test } from '@playwright/test';
import { CatalogService } from '../../apps/desktop/src/main/catalog-service';

test('creates children at the selected folder and focuses inline rename', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'photo-folder-create-'));
  const userData = path.join(root, 'user-data');
  const source = path.join(root, 'photos');
  await mkdir(path.join(userData, 'library'), { recursive: true });
  await mkdir(source);
  const catalog = new CatalogService(path.join(userData, 'library', 'catalog.sqlite'));
  await catalog.importFolders([source]);
  catalog.close();
  const app = await electron.launch({ args: [path.resolve('apps/desktop/out/main/index.js')], env: { ...process.env, PHOTOALLISAI_USER_DATA: userData } });
  try {
    const page = await app.firstWindow();
    await expect(page.getByRole('button', { name: '创建子文件夹', exact: true })).toBeDisabled();
    await page.getByRole('treeitem', { name: /^photos 0/ }).click();
    await page.getByRole('button', { name: '创建子文件夹', exact: true }).click();
    const input = page.getByRole('textbox', { name: '文件夹名称', exact: true });
    await expect(input).toBeFocused();
    await expect(input).toHaveValue('新建文件夹');
    expect(await input.evaluate((element: HTMLInputElement) => element.selectionEnd! - element.selectionStart!)).toBe(5);
    await input.fill('输出');
    await input.press('Enter');
    await expect(input).toHaveCount(0);
    await expect(page.getByRole('treeitem', { name: /^输出 0/ })).toHaveAttribute('aria-selected', 'true');
    expect((await stat(path.join(source, '输出'))).isDirectory()).toBe(true);
    await page.getByRole('treeitem', { name: /^输出 0/ }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: '创建子文件夹', exact: true }).click();
    await expect(input).toBeFocused();
    await input.press('Escape');
    await expect(input).toHaveCount(0);
    expect((await stat(path.join(source, '输出', '新建文件夹'))).isDirectory()).toBe(true);
    await page.reload();
    await expect(page.getByRole('treeitem', { name: /^输出 0/ })).toBeVisible();
    await expect(page.getByRole('treeitem', { name: /^新建文件夹 0/ })).toBeVisible();
    await page.screenshot({ path: 'test-results/folder-create.png' });
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});
