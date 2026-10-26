import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { _electron as electron, expect, test } from '@playwright/test';

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
