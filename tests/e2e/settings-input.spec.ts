import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { _electron as electron, expect, test } from '@playwright/test';

test('model configuration supports native paste and fits the settings area', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'photoallisai-settings-input-'));
  const app = await electron.launch({
    args: [path.resolve('apps/desktop/out/main/index.js')],
    env: { ...process.env, PHOTOALLISAI_USER_DATA: directory, PHOTOALLISAI_E2E_DEMO: '1' }
  });
  try {
    const page = await app.firstWindow();
    const editRoles = await app.evaluate(({ Menu }) => Menu.getApplicationMenu()?.items
      .flatMap((item) => item.submenu?.items ?? [])
      .filter((item) => ['cut', 'copy', 'paste'].includes(item.role ?? ''))
      .map((item) => ({ role: item.role, enabled: item.enabled })));
    expect(editRoles).toEqual([
      { role: 'cut', enabled: true }, { role: 'copy', enabled: true }, { role: 'paste', enabled: true }
    ]);
    const search = page.getByRole('textbox', { name: '搜索图库', exact: true });
    await app.evaluate(({ clipboard }) => clipboard.writeText('paste-search-check'));
    await search.focus();
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+V' : 'Control+V');
    await expect(search).toHaveValue('paste-search-check');
    await search.fill('');
    await page.getByRole('button', { name: 'Agent', exact: true }).click();
    const agentInput = page.getByRole('textbox', { name: 'Agent 输入', exact: true });
    await app.evaluate(({ clipboard }) => clipboard.writeText('粘贴的 Agent 指令'));
    await agentInput.focus();
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+V' : 'Control+V');
    await expect(agentInput).toHaveValue('粘贴的 Agent 指令');
    await page.getByRole('button', { name: 'AI', exact: true }).click();
    await page.getByRole('button', { name: '打开工作区', exact: true }).click();
    await page.getByRole('menuitem', { name: '设置', exact: true }).click();
    await page.getByRole('button', { name: 'AI 模型', exact: true }).click();
    await expect(page.getByRole('button', { name: '添加服务', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: '导出预设', exact: true })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: '诊断摘要', exact: true })).toHaveCount(0);
    const values = ['粘贴的配置名称', 'https://example.com/v1', 'vision-model', 'test-key'];
    const fields = page.locator('.provider-form input:not([type="checkbox"])');
    for (let index = 0; index < values.length; index += 1) {
      await app.evaluate(({ clipboard }, value) => clipboard.writeText(value), values[index]!);
      await fields.nth(index).focus();
      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+V' : 'Control+V');
      await expect(fields.nth(index)).toHaveValue(values[index]!);
    }
    await app.evaluate(({ clipboard }) => clipboard.writeText('{"X-Test":"value"}'));
    const headers = page.getByRole('textbox', { name: '模型自定义请求头' });
    await headers.fill('');
    await headers.focus();
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+V' : 'Control+V');
    await expect(headers).toHaveValue('{"X-Test":"value"}');
    for (const width of [1440, 1100, 900]) {
      await app.evaluate(({ BrowserWindow }, nextWidth) => BrowserWindow.getAllWindows()[0]!.setSize(nextWidth, 900), width);
      await expect.poll(() => page.locator('.settings-content').evaluate((element) => {
        const area = element.getBoundingClientRect();
        const controls = [...element.querySelectorAll('.provider-form input, .provider-form select, .provider-form textarea, .provider-form button')];
        return controls.every((control) => {
          const box = control.getBoundingClientRect();
          return box.left >= area.left && box.right <= area.right + 1;
        }) && element.scrollWidth <= element.clientWidth + 1;
      })).toBe(true);
      await page.screenshot({ path: `test-results/settings-input-${width}.png` });
    }
    await page.getByRole('button', { name: '添加服务', exact: true }).click();
    await expect(fields.nth(0)).toHaveValue('');
    await expect(fields.nth(0)).toBeFocused();
    await expect(fields.nth(1)).toHaveValue('');
    await expect(fields.nth(2)).toHaveValue('');
    await expect(fields.nth(3)).toHaveValue('');
    await expect(headers).toHaveValue('{}');
    await page.getByRole('button', { name: '图片导出', exact: true }).click();
    const presetName = page.getByRole('textbox', { name: '导出预设名称', exact: true });
    await app.evaluate(({ clipboard }) => clipboard.writeText('粘贴的导出名称'));
    await presetName.focus();
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+V' : 'Control+V');
    await expect(presetName).toHaveValue('粘贴的导出名称');
    await expect(page.getByRole('heading', { name: '导出预设', exact: true })).toBeVisible();
    await expect(page.locator('.provider-form')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: '诊断摘要', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: '诊断与维护', exact: true }).click();
    await expect(page.getByRole('heading', { name: '诊断摘要', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: '导出预设', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'AI 模型', exact: true }).click();
    await expect.poll(() => page.locator('.settings-content').evaluate((element) => element.scrollTop)).toBe(0);
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
