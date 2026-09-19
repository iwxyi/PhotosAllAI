import { copyFile, mkdir, mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';

import { CatalogService, isSupportedImage } from '../../apps/desktop/src/main/catalog-service';

const configuredRoot = process.env.PHOTOALLISAI_TEST_DATA;
const suite = configuredRoot ? test.describe : test.describe.skip;
let electronApp: ElectronApplication;
let page: Page;
let testRoot: string;
let userDataDirectory: string;
let originals: Array<{ path: string; size: number; modifiedAt: number }> = [];

suite('real photo preview pipeline', () => {
  test.beforeAll(async () => {
    const sourceRoot = path.resolve(configuredRoot!);
    const candidates = await collectLargestImages(sourceRoot, 8);
    expect(candidates).toHaveLength(8);
    originals = await Promise.all(candidates.map(async (filePath) => {
      const metadata = await stat(filePath);
      return { path: filePath, size: metadata.size, modifiedAt: metadata.mtimeMs };
    }));

    testRoot = await mkdtemp(path.join(tmpdir(), 'photoallisai-real-preview-'));
    const sourceDirectory = path.join(testRoot, 'source');
    userDataDirectory = path.join(testRoot, 'user-data');
    const libraryDirectory = path.join(userDataDirectory, 'library');
    await Promise.all([mkdir(sourceDirectory), mkdir(libraryDirectory, { recursive: true })]);
    for (const [index, source] of candidates.entries()) {
      await copyFile(source, path.join(sourceDirectory, `${String(index).padStart(2, '0')}${path.extname(source)}`));
    }
    const catalog = new CatalogService(path.join(libraryDirectory, 'catalog.sqlite'));
    await catalog.importFolders([sourceDirectory]);
    catalog.close();

    electronApp = await electron.launch({
      args: [path.resolve('apps/desktop/out/main/index.js')],
      env: { ...process.env, PHOTOALLISAI_USER_DATA: userDataDirectory }
    });
    page = await electronApp.firstWindow();
    await page.waitForLoadState('domcontentloaded');
  });

  test.afterAll(async () => {
    if (electronApp) await electronApp.close();
    if (testRoot) await rm(testRoot, { recursive: true, force: true });
    for (const original of originals) {
      const metadata = await stat(original.path);
      expect({ size: metadata.size, modifiedAt: metadata.mtimeMs }).toEqual({
        size: original.size,
        modifiedAt: original.modifiedAt
      });
    }
  });

  test('decodes large camera images, reuses cached previews, and reports timings', async () => {
    const coldStartedAt = performance.now();
    await waitForVisibleImages(page);
    const coldMs = performance.now() - coldStartedAt;
    const coldDiagnostics = await page.evaluate(() => window.desktopApi.getDiagnosticSnapshot());
    expect(coldDiagnostics.cache.performance.decodes).toBeGreaterThan(0);
    expect(coldDiagnostics.cache.files).toBeGreaterThan(0);

    await electronApp.close();
    const warmStartedAt = performance.now();
    electronApp = await electron.launch({
      args: [path.resolve('apps/desktop/out/main/index.js')],
      env: { ...process.env, PHOTOALLISAI_USER_DATA: userDataDirectory }
    });
    page = await electronApp.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    await waitForVisibleImages(page);
    const warmMs = performance.now() - warmStartedAt;
    const warmDiagnostics = await page.evaluate(() => window.desktopApi.getDiagnosticSnapshot());
    expect(warmDiagnostics.cache.performance.hits).toBeGreaterThan(coldDiagnostics.cache.performance.hits);

    const dimensions = await page.locator('img').evaluateAll((images) => images.map((image) => ({
      width: image.naturalWidth,
      height: image.naturalHeight
    })));
    expect(dimensions.length).toBeGreaterThan(1);
    expect(dimensions.every(({ width, height }) => width > 0 && height > 0 && width <= 2560 && height <= 2560)).toBe(true);
    console.info(JSON.stringify({
      samples: originals.length,
      coldMs: Math.round(coldMs),
      warmMs: Math.round(warmMs),
      cacheHits: warmDiagnostics.cache.performance.hits,
      cacheMisses: warmDiagnostics.cache.performance.misses,
      decodes: warmDiagnostics.cache.performance.decodes,
      decodeMsTotal: warmDiagnostics.cache.performance.decodeMsTotal
    }));
  });
});

async function waitForVisibleImages(target: Page): Promise<void> {
  await expect(target.getByText('8 张照片', { exact: true })).toBeVisible();
  await expect.poll(async () => target.locator('img').evaluateAll((images) =>
    images.length > 1 && images.every((image) => image.complete && image.naturalWidth > 0)
  ), { timeout: 60_000 }).toBe(true);
}

async function collectLargestImages(root: string, limit: number): Promise<string[]> {
  const candidates: Array<{ path: string; size: number }> = [];
  const directories = [root];
  while (directories.length > 0) {
    const directory = directories.pop()!;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) directories.push(candidate);
      else if (entry.isFile() && isSupportedImage(entry.name)) {
        candidates.push({ path: candidate, size: (await stat(candidate)).size });
      }
    }
  }
  return candidates.sort((left, right) => right.size - left.size).slice(0, limit).map((candidate) => candidate.path);
}
