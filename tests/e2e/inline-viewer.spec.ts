import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { _electron as electron, expect, test } from '@playwright/test';

test('views gallery and batch images in place and restores source state with Escape', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'photoallisai-inline-viewer-'));
  const app = await electron.launch({ args: [path.resolve('apps/desktop/out/main/index.js')], env: { ...process.env, PHOTOALLISAI_USER_DATA: directory, PHOTOALLISAI_E2E_DEMO: '1' } });
  try {
    const page = await app.firstWindow();
    await expect(page.locator('.catalog-card')).toHaveCount(6);
    expect(await page.locator('.catalog-card-image > img').first().evaluate((element) => getComputedStyle(element).objectFit)).toBe('contain');
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1000, 600));
    const source = page.locator('.catalog-grid');
    await source.evaluate((element) => { (element as HTMLElement).dataset.retained = 'yes'; element.scrollTop = element.scrollHeight; });
    const card = page.locator('.catalog-card').last();
    await card.click();
    const id = await card.getAttribute('data-asset-id');
    const scroll = await source.evaluate((element) => element.scrollTop);
    const tabCount = await page.getByRole('tab').count();
    await source.focus();
    await page.keyboard.press('Enter');
    const viewer = page.getByRole('region', { name: '看图', exact: true });
    await expect(viewer).toBeVisible();
    await expect(page.getByRole('tab')).toHaveCount(tabCount);
    await expect(page.getByRole('tab', { name: '图库', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(viewer.locator('.thumb.is-selected')).toHaveAttribute('data-asset-id', id!);
    await expect(viewer.locator('.base-image')).toHaveClass(/is-ready/);
    await expect(viewer.locator('.viewer-toolbar')).toHaveCount(0);
    await expect(viewer.locator('.viewer-footer .filmstrip-toolbar')).toHaveCount(1);
    await expect.poll(() => viewer.evaluate((element) => {
      const canvas = element.querySelector('.canvas-wrap')!.getBoundingClientRect();
      const photo = element.querySelector('.photo-canvas')!.getBoundingClientRect();
      const title = element.querySelector('.viewer-title')!.getBoundingClientRect();
      return Math.min(Math.abs(canvas.width - photo.width), Math.abs(canvas.height - photo.height)) < 1
        && title.top >= canvas.top && title.bottom <= canvas.bottom;
    })).toBe(true);
    for (const [width, height] of [[1440, 900], [1000, 600]]) {
      await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0]!.setSize(size[0]!, size[1]!), [width!, height!]);
      await expect.poll(() => viewer.evaluate((element) => {
        const canvas = element.querySelector('.canvas-wrap')!.getBoundingClientRect();
        const photo = element.querySelector('.photo-canvas')!.getBoundingClientRect();
        const toolbar = element.querySelector('.viewer-footer')!.getBoundingClientRect();
        const filmstrip = element.querySelector('.filmstrip-region')!.getBoundingClientRect();
        return Math.min(Math.abs(canvas.width - photo.width), Math.abs(canvas.height - photo.height)) < 1
          && toolbar.height <= 35 && filmstrip.top >= toolbar.bottom
          && document.documentElement.scrollWidth <= window.innerWidth;
      })).toBe(true);
      await page.screenshot({ path: `test-results/inline-viewer-${width}.png` });
    }
    await page.screenshot({ path: 'test-results/inline-viewer-open.png' });
    expect(await viewer.locator('.thumb img').first().evaluate((element) => getComputedStyle(element).objectFit)).toBe('contain');
    expect(await viewer.locator('.viewer-title').evaluate((element) => getComputedStyle(element).backgroundColor)).toBe('rgba(0, 0, 0, 0)');
    await viewer.locator('.viewer-footer').click({ button: 'right' });
    const toolbarSettings = page.getByRole('dialog', { name: '自定义看图工具栏' });
    await expect(toolbarSettings).toBeVisible();
    await toolbarSettings.getByRole('checkbox', { name: '生成与导出', exact: true }).uncheck();
    await expect(viewer.locator('[data-toolbar-item="export"]')).toBeHidden();
    await toolbarSettings.getByRole('button', { name: '上移缩放', exact: true }).click();
    await expect(viewer.locator('[data-toolbar-item]').first()).toHaveAttribute('data-toolbar-item', 'zoom');
    await toolbarSettings.locator('[data-layout-id="compare"] .toolbar-drag-handle').dragTo(toolbarSettings.locator('[data-layout-id="zoom"]'));
    await expect(viewer.locator('[data-toolbar-item]').first()).toHaveAttribute('data-toolbar-item', 'compare');
    await toolbarSettings.getByRole('button', { name: '弹性空白', exact: true }).click();
    await expect(viewer.locator('.viewer-toolbar-spacer')).toHaveCount(2);
    await page.screenshot({ path: 'test-results/viewer-toolbar-customize.png' });
    await page.keyboard.press('Escape');
    await expect(toolbarSettings).toHaveCount(0);
    await expect(viewer).toBeVisible();
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('photoallisai.viewer-toolbar.v1')!).find((entry: { id: string }) => entry.id === 'export').visible)).toBe(false);
    await page.keyboard.press('Escape');
    await expect(viewer).toHaveCount(0);
    await source.focus();
    await page.keyboard.press('Enter');
    await expect(viewer.locator('[data-toolbar-item="export"]')).toBeHidden();
    await expect(viewer.locator('.viewer-toolbar-spacer')).toHaveCount(2);
    await viewer.locator('.viewer-footer').click({ button: 'right' });
    await toolbarSettings.getByRole('button', { name: '恢复默认', exact: true }).click();
    await toolbarSettings.getByRole('button', { name: '关闭工具栏设置', exact: true }).click();
    await expect(viewer.locator('[data-toolbar-item="export"]')).toBeVisible();
    await page.getByRole('button', { name: '放大', exact: true }).click();
    await expect(viewer.locator('.zoom-value')).toHaveText('125%');
    await page.getByRole('button', { name: '适应窗口', exact: true }).click();
    await expect(viewer.locator('.zoom-value')).toHaveText('100%');
    await page.getByRole('button', { name: '对比', exact: true }).click();
    await expect(page.getByLabel('调整原图和生成图分割线')).toBeVisible();
    await page.getByRole('button', { name: '单图', exact: true }).click();
    await page.locator('.canvas-wrap').click({ button: 'right' });
    await expect(page.getByRole('menu', { name: /照片菜单/ })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menu', { name: /照片菜单/ })).toHaveCount(0);
    await expect(viewer).toBeVisible();
    await page.keyboard.press('ArrowLeft');
    await expect(viewer.locator('.thumb.is-selected')).not.toHaveAttribute('data-asset-id', id!);
    await page.keyboard.press('Escape');
    await expect(viewer).toHaveCount(0);
    await expect(source).toHaveAttribute('data-retained', 'yes');
    expect(await source.evaluate((element) => element.scrollTop)).toBe(scroll);
    await expect(card).toHaveAttribute('aria-selected', 'true');
    await expect(source).toBeFocused();
    await card.click({ button: 'right' });
    await page.getByRole('menuitem', { name: /加入 AI 批量修图/ }).click();
    await expect(page.getByRole('tab', { name: 'AI 批量修图', exact: true })).toHaveAttribute('aria-selected', 'true');
    const queue = page.locator('.batch-queue-item').first();
    const prompt = queue.locator('textarea');
    await prompt.fill('保留原有构图，改为动漫风');
    await queue.locator('.batch-queue-source').dblclick();
    await expect(viewer).toBeVisible();
    await expect(viewer.locator('.thumb')).toHaveCount(1);
    await page.getByRole('button', { name: '关闭看图', exact: true }).click();
    await expect(prompt).toHaveValue('保留原有构图，改为动漫风');
    await expect(page.getByRole('tab', { name: '看图', exact: true })).toHaveCount(0);
    expect(errors).toEqual([]);
    await page.screenshot({ path: 'test-results/inline-viewer-source.png' });
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
