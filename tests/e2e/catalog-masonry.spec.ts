import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { _electron as electron, expect, test } from '@playwright/test';

test('masonry keeps full image proportions, selection and inline viewing across window sizes', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'photo-masonry-'));
  const app = await electron.launch({ args: [path.resolve('apps/desktop/out/main/index.js')], env: { ...process.env, PHOTOALLISAI_USER_DATA: directory, PHOTOALLISAI_E2E_DEMO: '1' } });
  try {
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await expect(page.locator('.catalog-card')).toHaveCount(6);
    await page.getByRole('button', { name: '瀑布流视图', exact: true }).click();
    const grid = page.locator('.catalog-masonry');
    for (const [width, height] of [[1440, 900], [1000, 600]]) {
      await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0]!.setSize(size[0]!, size[1]!), [width!, height!]);
      await expect.poll(() => grid.evaluate((element) => {
        const cards = [...element.querySelectorAll<HTMLElement>('.catalog-card')];
        return cards.every((card, index) => {
          const image = card.querySelector('img')!;
          const frame = card.querySelector('.catalog-card-image')!.getBoundingClientRect();
          const rect = card.getBoundingClientRect();
          return image.naturalHeight > 0 && Math.abs(frame.height - frame.width * image.naturalHeight / image.naturalWidth) < 2
            && cards.slice(index + 1).every((other) => {
              const next = other.getBoundingClientRect();
              return rect.right <= next.left || next.right <= rect.left || rect.bottom <= next.top || next.bottom <= rect.top;
            });
        }) && element.scrollWidth <= element.clientWidth;
      })).toBe(true);
      await page.screenshot({ path: `test-results/catalog-masonry-${width}.png`, animations: 'disabled' });
    }
    for (const [theme, color] of [['dark', 'rgb(96, 96, 96)'], ['light', 'rgb(208, 208, 208)']]) {
      await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme!);
      expect(await page.locator('.catalog-card-image').first().evaluate((element) => getComputedStyle(element).backgroundColor)).toBe(color);
      await expect(page.locator('.catalog-card-image .raw-placeholder').first()).toBeHidden();
    }
    await grid.focus();
    await page.keyboard.press('ControlOrMeta+a');
    await expect(grid.locator('[aria-selected="true"]')).toHaveCount(6);
    await grid.locator('.catalog-card').last().dblclick();
    const viewer = page.getByRole('region', { name: '看图', exact: true });
    await expect(viewer).toBeVisible();
    for (const [theme, color] of [['dark', 'rgb(96, 96, 96)'], ['light', 'rgb(208, 208, 208)']]) {
      await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme!);
      for (const selector of ['.canvas-wrap']) {
        expect(await viewer.locator(selector).first().evaluate((element) => getComputedStyle(element).backgroundColor)).toBe(color);
      }
    }
    await expect.poll(() => viewer.locator('.filmstrip').evaluate((element) => element.scrollLeft > 0)).toBe(true);
    await page.keyboard.press('Escape');
    await expect(grid).toBeVisible();
    await expect(grid.locator('[aria-selected="true"]')).toHaveCount(6);
    await grid.locator('.catalog-card').first().click();
    await page.keyboard.press('ArrowDown');
    await expect(grid.locator('.catalog-card').first()).not.toHaveAttribute('aria-selected', 'true');
    await page.reload();
    await expect(page.locator('.catalog-masonry')).toBeVisible();
    await expect(page.getByRole('button', { name: '瀑布流视图', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await page.getByRole('button', { name: '网格视图', exact: true }).click();
    await expect(page.locator('.catalog-masonry')).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
