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
    await copyFile(path.resolve(`apps/desktop/src/renderer/public/demo/${index > 0 && index % 3 === 0 ? 'portrait' : 'coast'}.jpg`), path.join(photos, `${String(index).padStart(3, '0')}.jpg`));
  }
  const catalog = new CatalogService(path.join(userData, 'library', 'catalog.sqlite'));
  await catalog.importFolders([photos]);
  for (const asset of catalog.listAssetPage({ limit: 200 }).items) {
    const portrait = Number(path.parse(asset.fileName).name) % 3 === 0 && asset.fileName !== '000.jpg';
    catalog.saveDimensions(asset.id, 1800, portrait ? 2251 : 1197);
  }
  catalog.close();
  let releaseThumbnailRequests = () => undefined;
  const thumbnailGate = new Promise<void>((resolve) => { releaseThumbnailRequests = resolve; });
  const app = await electron.launch({ args: [path.resolve('apps/desktop/out/main/index.js')], env: { ...process.env, PHOTOALLISAI_USER_DATA: userData } });
  try {
    const page = await app.firstWindow();
    const session = await page.context().newCDPSession(page);
    await session.send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 800, deviceScaleFactor: 2, mobile: false });
    await page.evaluate(() => localStorage.setItem('photoallisai.thumbnail-size', '100'));
    await page.reload();
    const cards = page.locator('.catalog-card');
    await expect(cards).toHaveCount(160);
    expect(await cards.nth(3).evaluate((card) => {
      const frame = card.querySelector<HTMLElement>('.catalog-card-image')!.getBoundingClientRect();
      return frame.width / frame.height;
    })).toBeLessThan(1);
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
    await expect.poll(() => cards.nth(3).evaluate((card) => {
      const image = card.querySelector<HTMLImageElement>('img:not(.catalog-image-previous)')!;
      const frame = card.querySelector<HTMLElement>('.catalog-card-image')!.getBoundingClientRect();
      return image.naturalHeight > image.naturalWidth && Math.abs(frame.width / frame.height - image.naturalWidth / image.naturalHeight) < .03;
    })).toBe(true);
    expect(await last.getAttribute('src')).toBeNull();
    await first.evaluate((image) => {
      const mutations: string[] = [];
      (window as unknown as { imageMutations: string[] }).imageMutations = mutations;
      new MutationObserver(() => mutations.push(`${image.getAttribute('src')}|${image.className}`)).observe(image, { attributes: true });
    });
    for (let index = 0; index < 4; index += 1) {
      await page.locator('.catalog-grid').dispatchEvent('wheel', { deltaY: -200, ctrlKey: true, bubbles: true });
    }
    await expect(first).toHaveAttribute('src', /photoasset:\/\/(medium|preview)\//);
    await expect(first).toHaveClass('is-ready');
    expect(await first.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(384);
    expect(await first.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeLessThanOrEqual(2048);
    expect(await page.evaluate(() => (window as unknown as { imageMutations: string[] }).imageMutations.every((value) => value.endsWith('|is-ready') && !value.startsWith('null|')))).toBe(true);
    expect(await last.getAttribute('src')).toBeNull();
    await page.screenshot({ path: 'test-results/catalog-image-loading.png' });
    await cards.last().scrollIntoViewIfNeeded();
    await expect(last).toHaveClass('is-ready');
    await expect(last).toHaveAttribute('src', /photoasset:\/\/(thumbnail|medium)\//);
    const opened = cards.nth(80);
    await opened.scrollIntoViewIfNeeded();
    await expect(opened.locator('img:not(.catalog-image-previous)')).toHaveClass('is-ready');
    await opened.dblclick();
    const filmstrip = page.locator('.inline-photo-viewer .filmstrip');
    const selected = filmstrip.locator('.thumb.is-selected');
    await expect(selected).toHaveAttribute('data-asset-id', await opened.getAttribute('data-asset-id'));
    await expect(selected.locator('img:not(.catalog-image-previous)')).toHaveClass('is-ready');
    expect(await selected.evaluate((element) => {
      const item = element.getBoundingClientRect();
      const strip = element.closest('.filmstrip')!.getBoundingClientRect();
      return item.left >= strip.left - 2 && item.right <= strip.right + 2;
    })).toBe(true);
    const cachedSrc = await selected.locator('img:not(.catalog-image-previous)').getAttribute('src');
    const selectedScrollLeft = await filmstrip.evaluate((element) => element.scrollLeft);
    await filmstrip.evaluate((element) => { element.scrollLeft = 0; });
    await expect(selected).toHaveCount(0);
    await filmstrip.evaluate((element, left) => { element.scrollLeft = left; }, selectedScrollLeft);
    await expect(selected.locator('img:not(.catalog-image-previous)')).toHaveClass('is-ready');
    const remountedSrc = await selected.locator('img:not(.catalog-image-previous)').getAttribute('src');
    expect(remountedSrc === cachedSrc || /^photoasset:\/\/(medium|preview)\//.test(remountedSrc ?? '')).toBe(true);
    expect(await selected.locator('img:not(.catalog-image-previous)').evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
    await session.send('Network.enable');
    await session.send('Network.clearBrowserCache');
    await page.route(/^photoasset:\/\/thumbnail\//, async (route) => {
      await thumbnailGate;
      await route.continue();
    });
    await page.evaluate(() => localStorage.setItem('photoallisai.catalog-view-mode', 'masonry'));
    await page.reload();
    await expect(page.locator('.catalog-masonry')).toBeVisible();
    const masonry = page.locator('.catalog-masonry');
    await expect(masonry.locator('.catalog-card').first()).toBeVisible();
    const firstMasonryCard = masonry.locator('.catalog-card').first();
    await expect(firstMasonryCard.locator('img:not(.catalog-image-previous)')).not.toHaveClass('is-ready');
    const geometryBeforeDecode = await masonry.locator('.catalog-card').evaluateAll((items) => items.map((card) => {
      const rect = card.getBoundingClientRect();
      const frame = card.querySelector<HTMLElement>('.catalog-card-image')!.getBoundingClientRect();
      return [card.getAttribute('data-asset-id'), rect.top, rect.left, rect.width, rect.height, frame.width, frame.height];
    }));
    releaseThumbnailRequests();
    await expect.poll(() => page.locator('.catalog-masonry .catalog-card').evaluateAll((items) => {
      const cardSize = (index: number) => {
        const card = items[index]!;
        const image = card.querySelector<HTMLImageElement>('img:not(.catalog-image-previous)')!;
        const frame = card.querySelector<HTMLElement>('.catalog-card-image')!.getBoundingClientRect();
        return { natural: image.naturalHeight ? image.naturalWidth / image.naturalHeight : 0, frame: frame.width / frame.height };
      };
      const landscape = cardSize(0);
      const portrait = cardSize(3);
      return landscape.natural > 1 && portrait.natural < 1
        && Math.abs(landscape.frame - landscape.natural) < 0.03
        && Math.abs(portrait.frame - portrait.natural) < 0.03;
    })).toBe(true);
    const geometryAfterDecode = await masonry.locator('.catalog-card').evaluateAll((items) => items.map((card) => {
      const rect = card.getBoundingClientRect();
      const frame = card.querySelector<HTMLElement>('.catalog-card-image')!.getBoundingClientRect();
      return [card.getAttribute('data-asset-id'), rect.top, rect.left, rect.width, rect.height, frame.width, frame.height];
    }));
    expect(geometryAfterDecode).toEqual(geometryBeforeDecode);
    const firstMasonryId = await firstMasonryCard.getAttribute('data-asset-id');
    const firstMasonryElement = await firstMasonryCard.evaluate((element) => {
      (window as typeof window & { firstMasonryElement?: Element }).firstMasonryElement = element;
      return element.getAttribute('data-asset-id');
    });
    expect(firstMasonryElement).toBe(firstMasonryId);
    await masonry.evaluate((element) => { element.scrollTop = element.scrollHeight; });
    await expect(masonry.locator(`[data-asset-id="${firstMasonryId}"]`)).toHaveCount(1);
    await masonry.evaluate((element) => { element.scrollTop = 0; });
    await expect(masonry.locator(`[data-asset-id="${firstMasonryId}"] img:not(.catalog-image-previous)`)).toHaveClass('is-ready');
    expect(await firstMasonryCard.evaluate((element) => element === (window as typeof window & { firstMasonryElement?: Element }).firstMasonryElement)).toBe(true);
    expect(await firstMasonryCard.locator('img:not(.catalog-image-previous)').evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
  } finally {
    releaseThumbnailRequests();
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
