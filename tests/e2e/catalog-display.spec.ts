import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { _electron as electron, expect, test } from '@playwright/test';

test('list fields persist and Ctrl wheel or Chromium pinch scales only gallery thumbnails', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'photo-catalog-display-'));
  const app = await electron.launch({ args: [path.resolve('apps/desktop/out/main/index.js')], env: { ...process.env, PHOTOALLISAI_USER_DATA: directory, PHOTOALLISAI_E2E_DEMO: '1' } });
  try {
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await expect(page.locator('.catalog-card')).toHaveCount(6);
    await expect(page.getByRole('button', { name: '分析视图', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: '配置图库工具栏', exact: true }).click();
    await page.getByRole('checkbox', { name: '视图', exact: true }).check();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: '列表视图', exact: true }).click();
    await page.locator('.catalog-list-header').click({ button: 'right' });
    const menu = page.getByRole('menu', { name: '显示字段', exact: true });
    await menu.getByRole('menuitemcheckbox', { name: '分析', exact: true }).click();
    await menu.getByRole('menuitemcheckbox', { name: '建议', exact: true }).click();
    await menu.getByRole('menuitemcheckbox', { name: '评分', exact: true }).click();
    await expect(page.locator('.catalog-list-cell-analysis')).toHaveCount(6);
    await expect(page.locator('.catalog-list-cell-rating')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    await page.locator('.catalog-list-row').first().click();
    await expect(page.locator('.catalog-list-row').first()).toHaveAttribute('aria-selected', 'true');
    await page.reload();
    await expect(page.locator('.catalog-list-cell-analysis')).toHaveCount(6);
    await expect(page.locator('.catalog-list-cell-rating')).toHaveCount(0);
    await page.screenshot({ path: 'test-results/catalog-list-fields.png', animations: 'disabled' });
    for (const mode of ['网格视图', '瀑布流视图']) {
      await page.getByRole('button', { name: mode, exact: true }).click();
      const grid = page.locator('.catalog-grid');
      const size = () => grid.evaluate((element) => parseFloat((element as HTMLElement).style.getPropertyValue('--thumbnail-size')));
      const before = await size();
      const rect = await grid.boundingBox();
      await page.mouse.move(rect!.x + 40, rect!.y + 40);
      await page.keyboard.down('Control');
      await page.mouse.wheel(0, -150);
      await page.keyboard.up('Control');
      await expect.poll(size).toBeGreaterThan(before);
      const enlarged = await size();
      // Trackpad pinch is delivered by Chromium as a cancelable Ctrl+wheel.
      expect(await grid.evaluate((element) => element.dispatchEvent(new WheelEvent('wheel', { ctrlKey: true, deltaY: 50, bubbles: true, cancelable: true })))).toBe(false);
      await expect.poll(size).toBeLessThan(enlarged);
      const afterPinch = await size();
      await page.mouse.wheel(0, 80);
      expect(await size()).toBe(afterPinch);
      expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.getZoomFactor())).toBe(1);
      if (mode === '瀑布流视图') await page.screenshot({ path: 'test-results/catalog-masonry-zoom.png', animations: 'disabled' });
    }
    const saved = await page.locator('.catalog-grid').evaluate((element) => (element as HTMLElement).style.getPropertyValue('--thumbnail-size'));
    await page.reload();
    await expect(page.locator('.catalog-masonry')).toBeVisible();
    expect(await page.locator('.catalog-grid').evaluate((element) => (element as HTMLElement).style.getPropertyValue('--thumbnail-size'))).toBe(saved);
    expect(errors).toEqual([]);
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
