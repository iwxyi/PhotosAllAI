import path from 'node:path';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { _electron as electron, expect, test } from '@playwright/test';
import { CatalogService } from '../../apps/desktop/src/main/catalog-service';

test('creates and edits a smart collection with a selected directory and condition', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'photo-smart-editor-'));
  const userData = path.join(root, 'user-data');
  const source = path.join(root, 'photos');
  await mkdir(path.join(userData, 'library'), { recursive: true });
  await mkdir(path.join(source, 'A'), { recursive: true });
  await mkdir(path.join(source, 'B'), { recursive: true });
  await writeFile(path.join(source, 'A', 'keep.jpg'), 'keep');
  await writeFile(path.join(source, 'B', 'other.jpg'), 'other');
  const catalog = new CatalogService(path.join(userData, 'library', 'catalog.sqlite'));
  await catalog.importFolders([source]);
  catalog.close();
  const app = await electron.launch({ args: [path.resolve('apps/desktop/out/main/index.js')], env: { ...process.env, PHOTOALLISAI_USER_DATA: userData } });
  try {
    const page = await app.firstWindow();
    await page.getByRole('button', { name: '创建智能集合' }).click();
    const dialog = page.getByRole('dialog', { name: '创建智能集合' });
    await dialog.getByRole('textbox', { name: '名称' }).fill('待交付');
    await dialog.getByRole('checkbox', { name: '所有照片' }).uncheck();
    await dialog.getByRole('checkbox', { name: 'A' }).check();
    await dialog.getByRole('button', { name: '添加条件' }).click();
    await dialog.getByRole('combobox', { name: '条件 1 字段' }).selectOption('fileName');
    await dialog.getByRole('combobox', { name: '条件 1 运算' }).selectOption('contains');
    await dialog.getByRole('textbox', { name: '条件 1 值' }).fill('keep');
    await page.screenshot({ path: 'test-results/smart-collection-editor.png', animations: 'disabled' });
    await dialog.getByRole('button', { name: '保存集合' }).click();
    await expect(page.getByRole('button', { name: /待交付 1/ })).toBeVisible();
    await expect(page.locator('.catalog-card')).toHaveCount(1);
    await page.getByRole('button', { name: /待交付 1/ }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: '编辑智能集合…' }).click();
    const editor = page.getByRole('dialog', { name: '编辑智能集合' });
    await expect(editor.getByRole('checkbox', { name: 'A' })).toBeChecked();
    await editor.getByRole('textbox', { name: '名称' }).fill('精选交付');
    await editor.getByRole('button', { name: '保存集合' }).click();
    await expect(page.getByRole('button', { name: /精选交付 1/ })).toBeVisible();
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});
