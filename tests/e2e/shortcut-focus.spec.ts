import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { _electron as electron, expect, test, type Locator } from '@playwright/test';

test('select all follows text and photo-list focus', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'photoallisai-shortcut-focus-'));
  const app = await electron.launch({
    args: [path.resolve('apps/desktop/out/main/index.js')],
    env: { ...process.env, PHOTOALLISAI_USER_DATA: directory, PHOTOALLISAI_E2E_DEMO: '1' }
  });
  try {
    const page = await app.firstWindow();
    const invokeSelectAll = async () => {
      await app.evaluate(({ Menu, BrowserWindow }) => {
        const item = Menu.getApplicationMenu()!.items.flatMap((entry) => entry.submenu?.items ?? [])
          .find((entry) => entry.accelerator === 'CmdOrCtrl+A')!;
        if (!item.enabled) throw new Error('Select all is disabled');
        item.click({}, BrowserWindow.getAllWindows()[0]);
      });
    };
    const assertTextSelection = async (field: Locator) => {
      await field.fill('select this text');
      for (const shortcut of ['Control+A', ...(process.platform === 'darwin' ? ['Meta+A'] : [])]) {
        await field.focus();
        await page.keyboard.press('ArrowRight');
        await page.keyboard.press(shortcut);
        await expect.poll(() => field.evaluate((element) => {
          const input = element as HTMLInputElement | HTMLTextAreaElement;
          return [input.selectionStart, input.selectionEnd];
        })).toEqual([0, 'select this text'.length]);
      }
      await page.keyboard.press('ArrowRight');
      await invokeSelectAll();
      await expect.poll(() => field.evaluate((element) => {
        const input = element as HTMLInputElement | HTMLTextAreaElement;
        return [input.selectionStart, input.selectionEnd];
      })).toEqual([0, 'select this text'.length]);
    };
    const cards = page.locator('.catalog-card');
    await cards.first().click();
    const selectedCards = page.locator('.catalog-card[aria-selected="true"]');
    await expect(selectedCards).toHaveCount(1);
    const search = page.getByRole('textbox', { name: '搜索图库', exact: true });
    await assertTextSelection(search);
    await search.fill('');
    await expect(selectedCards).toHaveCount(1);
    await cards.first().focus();
    await invokeSelectAll();
    await expect(selectedCards).toHaveCount(await cards.count());
    await page.getByRole('button', { name: '配置图库工具栏', exact: true }).click();
    await page.getByRole('checkbox', { name: '视图', exact: true }).check();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: '列表视图', exact: true }).click();
    const header = page.getByRole('checkbox', { name: '全选当前列表', exact: true });
    await header.uncheck();
    await page.locator('.catalog-list-view').focus();
    await page.keyboard.press('Control+A');
    await expect(header).toBeChecked();
    await header.uncheck();
    await page.getByRole('button', { name: 'AI', exact: true }).focus();
    await invokeSelectAll();
    await expect(header).not.toBeChecked();
    await page.getByRole('button', { name: 'Agent', exact: true }).click();
    await assertTextSelection(page.getByRole('textbox', { name: 'Agent 输入', exact: true }));
    await expect(header).not.toBeChecked();
    await page.locator('.catalog-list-row').first().dblclick();
    const filmstrip = page.locator('.filmstrip');
    await filmstrip.focus();
    await invokeSelectAll();
    await expect(filmstrip.locator('[aria-selected="true"]')).toHaveCount(await filmstrip.locator('[role="option"]').count());
    await page.getByRole('button', { name: '打开工作区', exact: true }).click();
    await page.getByRole('menuitem', { name: '设置', exact: true }).click();
    for (const field of [
      page.getByRole('textbox', { name: '配置名称', exact: true }),
      page.locator('.provider-form input[type="url"]'),
      page.getByRole('textbox', { name: 'Model ID', exact: true }),
      page.locator('.provider-form input[type="password"]'),
      page.getByRole('textbox', { name: '模型自定义请求头', exact: true })
    ]) await assertTextSelection(field);
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('default library and viewer shortcuts follow focus', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'photoallisai-default-shortcuts-'));
  const app = await electron.launch({
    args: [path.resolve('apps/desktop/out/main/index.js')],
    env: { ...process.env, PHOTOALLISAI_USER_DATA: directory, PHOTOALLISAI_E2E_DEMO: '1' }
  });
  try {
    const page = await app.firstWindow();
    const catalog = page.getByRole('listbox', { name: '图库照片' });
    await expect(catalog).toBeVisible();
    await catalog.focus();
    await page.keyboard.press('E');
    const list = page.getByRole('listbox', { name: '图库列表视图' });
    await expect(list).toBeVisible();
    await list.focus();
    await page.keyboard.press('G');
    await expect(catalog).toBeVisible();
    const search = page.getByRole('textbox', { name: '搜索图库' });
    await search.focus();
    await page.keyboard.press('E');
    await expect(search).toHaveValue('E');
    await expect(catalog).toBeVisible();
    await search.fill('');
    await catalog.focus();
    await page.keyboard.press('Shift+L');
    await expect(page.locator('.global-workspace-shell > .workspace-side-panel').first()).toBeHidden();
    await page.keyboard.press('Shift+L');
    await expect(page.locator('.global-workspace-shell > .workspace-side-panel').first()).toBeVisible();
    await catalog.focus();
    await page.keyboard.press('Space');
    const viewer = page.getByRole('region', { name: '看图', exact: true });
    await expect(viewer).toBeVisible();
    const canvas = viewer.locator('.canvas-wrap');
    await canvas.focus();
    await page.keyboard.press('Z');
    await expect(viewer.getByRole('button', { name: '适应窗口' })).toHaveAttribute('aria-pressed', 'false');
    await page.keyboard.press('F');
    await expect(viewer.getByRole('button', { name: '适应窗口' })).toHaveAttribute('aria-pressed', 'true');
    await page.keyboard.press('Escape');
    await expect(viewer).toHaveCount(0);
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
