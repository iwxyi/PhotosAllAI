import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { _electron as electron, expect, test } from '@playwright/test';

test('creates custom templates and composes selected prompt fragments', async () => {
  const userData = await mkdtemp(path.join(tmpdir(), 'photoallisai-template-compose-'));
  const app = await electron.launch({ args: [path.resolve('apps/desktop/out/main/index.js')], env: { ...process.env, PHOTOALLISAI_USER_DATA: userData, PHOTOALLISAI_E2E_DEMO: '1' } });
  try {
    const page = await app.firstWindow();
    const templates = await page.evaluate(async () => Promise.all([
      window.desktopApi.savePromptTemplate({ name: '清理背景', category: '局部修饰', description: '移除背景中不需要的杂物', body: '只清理背景杂物，保持主体不变。' }),
      window.desktopApi.savePromptTemplate({ name: '增加阳光', category: '光线氛围', description: '为逆光照片添加自然暖阳', body: '在画面左上方加入柔和自然的阳光。' })
    ]));
    await page.getByRole('button', { name: '打开工作区', exact: true }).click();
    await page.getByRole('menuitem', { name: '图片生成', exact: true }).click();
    const addButton = page.getByRole('button', { name: '插入提示词模板', exact: true });
    await addButton.click();
    const picker = page.getByRole('dialog', { name: '选择提示词模板' });
    const prompt = page.getByRole('textbox', { name: '批次整体提示词' });
    const [buttonBox, promptBox, pickerBox] = await Promise.all([addButton.boundingBox(), prompt.boundingBox(), picker.boundingBox()]);
    expect(buttonBox && promptBox && buttonBox.y > promptBox.y + promptBox.height - 34).toBeTruthy();
    expect(pickerBox && promptBox && pickerBox.y >= promptBox.y + promptBox.height).toBeTruthy();
    const first = picker.getByRole('checkbox', { name: /清理背景/ });
    const second = picker.getByRole('checkbox', { name: /增加阳光/ });
    await first.check();
    await second.check();
    const selectedChips = page.getByLabel('已选模板');
    await expect(selectedChips.getByText('清理背景', { exact: true })).toBeVisible();
    await expect(selectedChips.getByText('增加阳光', { exact: true })).toBeVisible();
    await expect.poll(() => prompt.inputValue()).toContain(templates[0]!.body);
    await expect.poll(() => prompt.inputValue()).toContain(templates[1]!.body);
    await first.uncheck();
    await expect(selectedChips.getByText('清理背景', { exact: true })).toHaveCount(0);
    await expect.poll(() => prompt.inputValue()).not.toContain(templates[0]!.body);
    await expect.poll(() => prompt.inputValue()).toContain(templates[1]!.body);
    await prompt.fill('自定义改写：在画面右边缘加入柔和阳光。');
    await second.uncheck();
    await expect(prompt).toHaveValue('自定义改写：在画面右边缘加入柔和阳光。');
    await expect(picker.getByRole('checkbox', { name: /增加阳光/ })).not.toBeChecked();
    await page.keyboard.press('Escape');
    await expect(picker).toBeHidden();
    await addButton.click();
    await expect(picker).toBeVisible();
    await page.locator('body').click({ position: { x: 8, y: 180 } });
    await expect(picker).toBeHidden();
  } finally {
    await app.close();
    await rm(userData, { recursive: true, force: true });
  }
});
