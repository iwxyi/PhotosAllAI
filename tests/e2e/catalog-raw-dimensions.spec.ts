import path from 'node:path';
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { _electron as electron, expect, test } from '@playwright/test';
import { CatalogService } from '../../apps/desktop/src/main/catalog-service';

const source = process.env.PHOTOALLISAI_RAW_PORTRAIT_TEST_FILE;

test.skip(!source, 'Set PHOTOALLISAI_RAW_PORTRAIT_TEST_FILE to a portrait RAW file');

test('RAW gallery frame uses indexed orientation before thumbnail decoding', async () => {
  test.setTimeout(120_000);
  const root = await mkdtemp(path.join(tmpdir(), 'photoallisai-raw-layout-'));
  const userData = path.join(root, 'user-data');
  const photos = path.join(root, 'photos');
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    await mkdir(path.join(userData, 'library'), { recursive: true });
    await mkdir(photos);
    await copyFile(source!, path.join(photos, path.basename(source!)));
    const catalog = new CatalogService(path.join(userData, 'library', 'catalog.sqlite'));
    try { await catalog.importFolders([photos]); }
    finally { catalog.close(); }
    app = await electron.launch({ args: [path.resolve('apps/desktop/out/main/index.js')], env: { ...process.env, PHOTOALLISAI_USER_DATA: userData } });
    const page = await app.firstWindow();
    const card = page.locator('.catalog-grid .catalog-card').first();
    await expect(card).toBeVisible();
    const asset = await page.evaluate(async () => (await window.desktopApi.listCatalogAssetPage({ limit: 10 })).items[0]);
    expect(asset?.width).toBeGreaterThan(0);
    expect(asset?.height).toBeGreaterThan(asset!.width!);
    const frameRatio = await card.locator('.catalog-card-image').evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return rect.width / rect.height;
    });
    expect(frameRatio).toBeLessThan(1);
    const image = card.locator('img:not(.catalog-image-previous)');
    await expect(image).toHaveClass(/is-ready/);
    expect(await image.evaluate((element: HTMLImageElement) => element.naturalHeight)).toBeGreaterThan(await image.evaluate((element: HTMLImageElement) => element.naturalWidth));
  } finally {
    await app?.close();
    await rm(root, { recursive: true, force: true });
  }
});
