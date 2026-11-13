import path from 'node:path';
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { _electron as electron, expect, test } from '@playwright/test';
import { CatalogService } from '../../apps/desktop/src/main/catalog-service';

test('gallery defers distant thumbnails and reuses a medium preview when cards grow', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'photo-image-loading-'));
  const userData = path.join(directory, 'user-data');
  const photos = path.join(directory, 'photos');
  await mkdir(path.join(userData, 'library'), { recursive: true });
  await mkdir(photos);
  for (let index = 0; index < 160; index += 1) {
    await copyFile(path.resolve(`apps/desktop/src/renderer/public/demo/${index > 0 && index % 3 === 0 ? 'portrait' : 'mountain'}.jpg`), path.join(photos, `${String(index).padStart(3, '0')}.jpg`));
  }
  const catalog = new CatalogService(path.join(userData, 'library', 'catalog.sqlite'));
  await catalog.importFolders([photos]);
  catalog.close();
  const app = await electron.launch({ args: [path.resolve('apps/desktop/out/main/index.js')], env: { ...process.env, PHOTOALLISAI_USER_DATA: userData } });
  try {
    const page = await app.firstWindow();
    const session = await page.context().newCDPSession(page);
    await session.send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 800, deviceScaleFactor: 2, mobile: false });
    await page.evaluate(() => localStorage.setItem('photoallisai.thumbnail-size', '100'));
    await page.reload();
    const cards = page.locator('.catalog-card');
    await expect(cards).toHaveCount(160);
    const first = cards.first().locator('img');
    const last = cards.last().locator('img');
    await expect(first).toHaveClass('is-ready');
    await expect(first).toHaveAttribute('src', /photoasset:\/\/thumbnail\//);
    const aheadIndex = await cards.evaluateAll((items) => {
      const bottom = items[0]!.closest('.catalog-grid')!.getBoundingClientRect().bottom;
      return items.findIndex((item, index) => {
        const top = item.getBoundingClientRect().top;
        return index % 3 === 0 && top > bottom + 100 && top < bottom + 700;
      });
    });
    expect(aheadIndex).toBeGreaterThan(0);
    const ahead = cards.nth(aheadIndex).locator('img');
    await expect(ahead).toHaveAttribute('src', /photoasset:\/\/thumbnail\//);
    await expect(ahead).toHaveClass('is-ready');
    expect(await ahead.evaluate((image: HTMLImageElement) => image.naturalHeight > image.naturalWidth)).toBe(true);
    expect(await last.getAttribute('src')).toBeNull();
    await first.evaluate((image) => {
      const mutations: string[] = [];
      (window as unknown as { imageMutations: string[] }).imageMutations = mutations;
      new MutationObserver(() => mutations.push(`${image.getAttribute('src')}|${image.className}`)).observe(image, { attributes: true });
    });
    for (let index = 0; index < 4; index += 1) {
      await page.locator('.catalog-grid').dispatchEvent('wheel', { deltaY: -200, ctrlKey: true, bubbles: true });
    }
    await expect(first).toHaveAttribute('src', /photoasset:\/\/medium\//);
    await expect(first).toHaveClass('is-ready');
    expect(await first.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(384);
    expect(await first.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeLessThanOrEqual(1024);
    expect(await page.evaluate(() => (window as unknown as { imageMutations: string[] }).imageMutations.every((value) => value.endsWith('|is-ready') && !value.startsWith('null|')))).toBe(true);
    expect(await last.getAttribute('src')).toBeNull();
    await page.screenshot({ path: 'test-results/catalog-image-loading.png' });
    await cards.last().scrollIntoViewIfNeeded();
    await expect(last).toHaveClass('is-ready');
    await expect(last).toHaveAttribute('src', /photoasset:\/\/(thumbnail|medium)\//);
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
