import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { _electron as electron, expect, test } from '@playwright/test';
import { galleryInspectionScript } from '../../apps/desktop/src/main/gallery-inspection';

test('group headings align with the first image row in both waterfall views', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'photo-group-spacing-'));
  const app = await electron.launch({ args: [path.resolve('apps/desktop/out/main/index.js')], env: { ...process.env, PHOTOALLISAI_USER_DATA: directory, PHOTOALLISAI_E2E_DEMO: '1' } });
  try {
    const page = await app.firstWindow();
    await expect(page.locator('.catalog-card')).toHaveCount(6);
    await page.getByRole('button', { name: '配置图库工具栏', exact: true }).click();
    await page.getByRole('checkbox', { name: '视图', exact: true }).check();
    await page.getByRole('checkbox', { name: '分组:横竖', exact: true }).check();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: '按横竖分组', exact: true }).click();
    for (const [view, button] of [['justified', '等高瀑布流'], ['masonry', '瀑布流视图']] as const) {
      await page.getByRole('button', { name: button, exact: true }).click();
      const gallery = page.locator(`.catalog-${view}`);
      await expect(gallery.locator('.catalog-photo-group')).not.toHaveCount(0);
      await expect.poll(() => gallery.evaluate((element) => {
        const heading = element.querySelector<HTMLElement>('.catalog-photo-group')!;
        const image = element.querySelector<HTMLElement>('.catalog-card-image')!;
        const container = element.getBoundingClientRect();
        const title = heading.getBoundingClientRect();
        const frame = image.getBoundingClientRect();
        return Math.abs(title.left - frame.left) < 1
          && Math.abs(title.right - (container.right - 16)) < 1
          && Math.abs(title.top - (container.top + 8)) < 1
          && Math.abs(frame.top - title.bottom - 12) < 1;
      })).toBe(true);
      await page.screenshot({ path: `test-results/catalog-group-${view}.png`, animations: 'disabled' });
      const inspected = await page.evaluate(galleryInspectionScript) as { mountedCount: number; groups: Array<{ title: string }>; images: Array<{ decoded: { width: number | null; height: number | null }; frame: { width: number; height: number }; display: { painted: { width: number; height: number } | null }; ratioMismatch: string | null }> };
      expect(inspected.mountedCount).toBe(6);
      expect(inspected.groups).toHaveLength(1);
      expect(inspected.images.every((item) => item.frame.width > 0 && item.frame.height > 0 && item.decoded.width && item.decoded.height)).toBe(true);
      expect(inspected.images.every((item) => item.display.painted?.width && item.display.painted.height && item.ratioMismatch === null)).toBe(true);
    }
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('returning to the gallery preserves mounted portrait cards and their geometry', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'photo-masonry-tabs-'));
  const app = await electron.launch({ args: [path.resolve('apps/desktop/out/main/index.js')], env: { ...process.env, PHOTOALLISAI_USER_DATA: directory, PHOTOALLISAI_E2E_DEMO: '1' } });
  try {
    const page = await app.firstWindow();
    await expect(page.locator('.catalog-card')).toHaveCount(6);
    await page.getByRole('button', { name: '配置图库工具栏', exact: true }).click();
    await page.getByRole('checkbox', { name: '视图', exact: true }).check();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: '瀑布流视图', exact: true }).click();
    const portrait = page.locator('.catalog-masonry .catalog-card').nth(1);
    await expect(portrait.locator('img:not(.catalog-image-previous)')).toHaveClass('is-ready');
    const before = await portrait.evaluate((card) => {
      (window as typeof window & { portraitCard?: Element }).portraitCard = card;
      const rect = card.querySelector('.catalog-card-image')!.getBoundingClientRect();
      return rect.width / rect.height;
    });
    await page.getByRole('button', { name: '打开工作区' }).click();
    await page.getByRole('menuitem', { name: '图片生成', exact: true }).click();
    await page.getByRole('tab', { name: '图库', exact: true }).click();
    const after = await portrait.evaluate((card) => {
      const rect = card.querySelector('.catalog-card-image')!.getBoundingClientRect();
      return { sameCard: card === (window as typeof window & { portraitCard?: Element }).portraitCard, ratio: rect.width / rect.height };
    });
    expect(after.sameCard).toBe(true);
    expect(after.ratio).toBeCloseTo(before, 2);
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('masonry keeps full image proportions, selection and inline viewing across window sizes', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'photo-masonry-'));
  const app = await electron.launch({ args: [path.resolve('apps/desktop/out/main/index.js')], env: { ...process.env, PHOTOALLISAI_USER_DATA: directory, PHOTOALLISAI_E2E_DEMO: '1' } });
  try {
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await expect(page.locator('.catalog-card')).toHaveCount(6);
    await page.getByRole('button', { name: '配置图库工具栏', exact: true }).click();
    await page.getByRole('checkbox', { name: '视图', exact: true }).check();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: '等高瀑布流', exact: true }).click();
    const justified = page.locator('.catalog-justified');
    await expect.poll(() => justified.locator('.catalog-card').evaluateAll((cards) => cards.every((card) => {
      const image = card.querySelector<HTMLImageElement>('img:not(.catalog-image-previous)')!;
      const frame = card.querySelector('.catalog-card-image')!.getBoundingClientRect();
      return image.naturalWidth > 0 && Math.abs(frame.width / frame.height - image.naturalWidth / image.naturalHeight) < .03;
    }))).toBe(true);
    expect(await justified.locator('.catalog-justified-row').evaluateAll((rows) => rows.every((row) => {
      const cards = [...row.querySelectorAll<HTMLElement>('.catalog-card')];
      return cards.length < 2 || cards.every((card) => Math.abs(card.getBoundingClientRect().bottom - cards[0]!.getBoundingClientRect().bottom) < 2);
    }))).toBe(true);
    await page.screenshot({ path: 'test-results/catalog-justified.png', animations: 'disabled' });
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
