import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { _electron as electron, expect, test } from '@playwright/test';

test('catalog cards keep thumbnail-sized placeholders during startup', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'photo-catalog-layout-'));
  const app = await electron.launch({
    args: [path.resolve('apps/desktop/out/main/index.js')],
    env: { ...process.env, PHOTOALLISAI_USER_DATA: directory, PHOTOALLISAI_E2E_DEMO: '1' }
  });
  try {
    const page = await app.firstWindow();
    await expect(page.locator('.catalog-card')).toHaveCount(6);
    await page.addInitScript(() => {
      (window as typeof window & { catalogLayoutSamples: Array<{ viewport: number; imageHeight: number; cardHeight: number }> }).catalogLayoutSamples = [];
      const sample = () => {
        const grid = document.querySelector<HTMLElement>('.catalog-grid');
        const card = grid?.querySelector<HTMLElement>('.catalog-card');
        if (grid && card) {
          const samples = (window as typeof window & { catalogLayoutSamples: Array<{ viewport: number; imageHeight: number; cardHeight: number }> }).catalogLayoutSamples;
          if (samples.length < 100) samples.push({
            viewport: grid.clientHeight,
            cardHeight: card.getBoundingClientRect().height,
            imageHeight: card.querySelector('.catalog-card-image')?.getBoundingClientRect().height ?? 0
          });
        }
        requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });
    for (const mode of ['justified', 'grid', 'masonry'] as const) {
      await page.evaluate((value) => localStorage.setItem('photoallisai.catalog-view-mode', value), mode);
      await page.reload();
      await expect(page.locator('.catalog-card')).toHaveCount(6);
      const sizes = await page.locator('.catalog-grid').evaluate((grid) => ({
        viewport: grid.clientHeight,
        cards: [...grid.querySelectorAll<HTMLElement>('.catalog-card')].map((card) => ({
          width: card.getBoundingClientRect().width,
          height: card.getBoundingClientRect().height,
          imageHeight: card.querySelector('.catalog-card-image')?.getBoundingClientRect().height
        }))
      }));
      expect(sizes.cards.every((card) => card.height > 0 && card.height < sizes.viewport * .75)).toBe(true);
    }
    await page.evaluate(() => {
      localStorage.setItem('photoallisai.catalog-view-mode', 'justified');
      localStorage.setItem('photoallisai.thumbnail-size', '420');
    });
    await page.reload();
    await expect(page.locator('.catalog-card')).toHaveCount(6);
    const zoomedSamples = await page.evaluate(() => (window as typeof window & { catalogLayoutSamples: Array<{ viewport: number; imageHeight: number; cardHeight: number }> }).catalogLayoutSamples);
    expect(zoomedSamples.length).toBeGreaterThan(0);
    expect(zoomedSamples.every((sample) => sample.imageHeight <= Math.max(100, sample.viewport * .55) + 1)).toBe(true);
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
