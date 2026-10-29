import path from 'node:path';
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { _electron as electron, expect, test } from '@playwright/test';
import { CatalogService } from '../../apps/desktop/src/main/catalog-service';

test('updates an open viewer from folder navigation and preserves filmstrip multiselection', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'photo-viewer-folder-'));
  const userData = path.join(directory, 'user-data');
  const firstFolder = path.join(directory, 'first');
  const secondFolder = path.join(directory, 'second');
  await mkdir(path.join(userData, 'library'), { recursive: true });
  await mkdir(firstFolder);
  await mkdir(secondFolder);
  const fixture = path.resolve('apps/desktop/src/renderer/public/demo/portrait.jpg');
  for (const name of ['A.jpg', 'B.jpg', 'C.jpg']) await copyFile(fixture, path.join(firstFolder, name));
  await copyFile(fixture, path.join(secondFolder, 'Other.jpg'));
  const catalog = new CatalogService(path.join(userData, 'library', 'catalog.sqlite'));
  await catalog.importFolders([firstFolder, secondFolder]);
  catalog.close();
  const app = await electron.launch({ args: [path.resolve('apps/desktop/out/main/index.js')], env: { ...process.env, PHOTOALLISAI_USER_DATA: userData } });
  try {
    const page = await app.firstWindow();
    await page.getByRole('treeitem', { name: /^first / }).click();
    await expect(page.locator('.catalog-card')).toHaveCount(3);
    await page.locator('.catalog-card').first().dblclick();
    const viewer = page.getByRole('region', { name: '看图', exact: true });
    const thumbs = viewer.locator('.thumb');
    await expect(thumbs).toHaveCount(3);
    await expect(viewer.locator('.thumb-index, .selection-check')).toHaveCount(0);
    await thumbs.first().click();
    await thumbs.nth(1).click({ modifiers: ['Control'] });
    await expect(viewer.locator('.thumb[aria-selected="true"]')).toHaveCount(2);
    await expect(viewer.locator('.thumb.is-selected')).toHaveAttribute('data-asset-id', (await thumbs.nth(1).getAttribute('data-asset-id'))!);
    await thumbs.first().click();
    await thumbs.last().click({ modifiers: ['Shift'] });
    await expect(viewer.locator('.thumb[aria-selected="true"]')).toHaveCount(3);
    await page.getByRole('treeitem', { name: /^second / }).click();
    await expect(viewer.locator('.viewer-title')).toContainText('Other.jpg');
    await expect(thumbs).toHaveCount(1);
    await expect(viewer.locator('.base-image')).toHaveClass(/is-ready/);
    await page.getByRole('treeitem', { name: /^first / }).click();
    await expect(thumbs).toHaveCount(3);
    await expect(viewer.locator('.viewer-title')).toContainText('A.jpg');
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('switches portrait and landscape previews without painting the previous image at the next aspect ratio', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'photo-viewer-switch-'));
  const app = await electron.launch({ args: [path.resolve('apps/desktop/out/main/index.js')], env: { ...process.env, PHOTOALLISAI_USER_DATA: directory, PHOTOALLISAI_E2E_DEMO: '1' } });
  try {
    const page = await app.firstWindow();
    await page.locator('.catalog-card').first().dblclick();
    const viewer = page.getByRole('region', { name: '看图', exact: true });
    await expect(viewer.locator('.base-image')).toHaveClass(/is-ready/);
    await page.evaluate(() => {
      const frames = { mismatches: [] as string[], blankFrames: 0, samples: 0, running: true };
      Object.assign(window, { previewFrames: frames });
      const sample = () => {
        const image = document.querySelector<HTMLImageElement>('.base-image');
        const canvas = document.querySelector('.photo-canvas');
        if (canvas && getComputedStyle(canvas).visibility !== 'hidden') {
          if (!image || getComputedStyle(image).opacity === '0' || !image.naturalHeight) frames.blankFrames++;
        }
        if (image?.complete && image.naturalHeight && canvas && getComputedStyle(canvas).visibility !== 'hidden') {
          const rect = canvas.getBoundingClientRect();
          frames.samples++;
          if (Math.abs(rect.width / rect.height - image.naturalWidth / image.naturalHeight) > .02) frames.mismatches.push(image.src);
        }
        if (frames.running) requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });
    for (const id of ['photo-4', 'photo-1', 'photo-5', 'photo-3', 'photo-1']) {
      await viewer.locator(`.thumb[data-asset-id="${id}"]`).click();
      const expected = await viewer.locator(`.thumb[data-asset-id="${id}"] img`).getAttribute('src');
      await expect(viewer.locator('.base-image')).toHaveAttribute('src', expected!);
      await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    }
    await viewer.locator('.filmstrip').focus();
    for (let index = 0; index < 4; index++) await page.keyboard.press('ArrowRight');
    await expect(viewer.locator('.base-image')).toHaveAttribute('src', /city\.jpg$/);
    const frames = await page.evaluate(() => {
      const state = (window as unknown as { previewFrames: { mismatches: string[]; samples: number; running: boolean } }).previewFrames;
      state.running = false;
      return state;
    });
    expect(frames.samples).toBeGreaterThan(5);
    expect(frames.mismatches).toEqual([]);
    expect(frames.blankFrames).toBe(0);
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
