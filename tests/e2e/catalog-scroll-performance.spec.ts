import path from 'node:path';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { copyFile, link, mkdir, mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { backup, DatabaseSync } from 'node:sqlite';
import { _electron as electron, expect, test } from '@playwright/test';
import { CatalogService } from '../../apps/desktop/src/main/catalog-service';
import { galleryInspectionScript } from '../../apps/desktop/src/main/gallery-inspection';

const source = process.env.PHOTOALLISAI_SCROLL_TEST_DATA;
const sourceCatalog = process.env.PHOTOALLISAI_SCROLL_TEST_CATALOG;
const synthetic = process.env.PHOTOALLISAI_SCROLL_TEST_SYNTHETIC === '1';
const desktopRequire = createRequire(path.resolve('apps/desktop/package.json'));
const imageSize = (desktopRequire('image-size') as { imageSize: (input: string) => { width: number; height: number } }).imageSize;
const minimumLoaded = Number(process.env.PHOTOALLISAI_SCROLL_TEST_MIN_LOADED ?? 600);
const rawDiagnosticPath = process.env.PHOTOALLISAI_SCROLL_TEST_RAW;
const replaceThumbnails = process.env.PHOTOALLISAI_SCROLL_TEST_REPLACE_THUMBNAILS === '1';
const viewMode = ['grid', 'justified', 'masonry'].includes(process.env.PHOTOALLISAI_SCROLL_TEST_VIEW ?? '')
  ? process.env.PHOTOALLISAI_SCROLL_TEST_VIEW!
  : 'justified';
const suite = source || sourceCatalog || synthetic ? test.describe : test.describe.skip;
type GalleryInspection = { view: string; mountedCount: number; images: Array<{ fileName: string; imageReady: boolean; ratioMismatch: string | null; indexed: { width: number | null; height: number | null }; decoded: { width: number | null; height: number | null }; frame: { width: number; height: number } | null }> };

suite('real photo gallery scrolling', () => {
  test('reports cold and warm scrolling pressure', async () => {
    test.setTimeout(600_000);
    const directory = await mkdtemp(path.join(tmpdir(), 'photoallisai-scroll-'));
    const userData = path.join(directory, 'user-data');
    await mkdir(path.join(userData, 'library'), { recursive: true });
    const destination = path.join(userData, 'library', 'catalog.sqlite');
    const catalog = sourceCatalog ? null : new CatalogService(destination);
    let catalogClosed = false;
    let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
    try {
      if (sourceCatalog) {
        const database = new DatabaseSync(sourceCatalog, { readOnly: true });
        try { await backup(database, destination); }
        finally { database.close(); }
        await copyFile(path.join(path.dirname(sourceCatalog), 'schema-state.json'), path.join(userData, 'library', 'schema-state.json')).catch(() => undefined);
      } else if (synthetic) {
        const sourceDirectory = path.resolve(process.env.PHOTOALLISAI_SCROLL_TEST_SYNTHETIC_SOURCE ?? 'apps/desktop/src/renderer/public/demo');
        const files = (await readdir(sourceDirectory, { withFileTypes: true }))
          .filter((entry) => entry.isFile() && /\.(?:jpe?g|png|webp|tiff?)$/iu.test(entry.name))
          .map((entry) => path.join(sourceDirectory, entry.name));
        if (!files.length) throw new Error('Synthetic gallery fixture has no supported images');
        const photoDirectory = path.join(directory, 'photos');
        await mkdir(photoDirectory);
        const writer = new DatabaseSync(destination);
        writer.prepare('INSERT INTO folders (id, path, name, imported_at) VALUES (?, ?, ?, ?)')
          .run('synthetic-root', photoDirectory, 'Synthetic performance photos', 1);
        const insertAsset = writer.prepare(`INSERT INTO assets
          (id, folder_id, path, file_name, extension, size_bytes, modified_at, imported_at)
          VALUES (?, 'synthetic-root', ?, ?, ?, ?, ?, 1)`);
        const insertDimensions = writer.prepare(`INSERT INTO asset_exif
          (asset_id, source_size, source_modified_at, width, height, dimension_version)
          VALUES (?, ?, ?, ?, ?, 1)`);
        const dimensionsByFile = new Map<string, { width: number; height: number }>();
        writer.exec('BEGIN IMMEDIATE');
        try {
          for (let index = 0; index < 1_200; index += 1) {
            const sourcePath = files[index % files.length]!;
            const extension = path.extname(sourcePath).toLowerCase();
            const fileName = `PHOTO_${String(index).padStart(4, '0')}${extension}`;
            const photoPath = path.join(photoDirectory, fileName);
            await link(sourcePath, photoPath);
            const sourceStat = await stat(photoPath);
            let dimensions = dimensionsByFile.get(sourcePath);
            if (!dimensions) {
              dimensions = imageSize(await readFile(sourcePath));
              dimensionsByFile.set(sourcePath, dimensions);
            }
            const id = randomUUID();
            const modifiedAt = Math.trunc(sourceStat.mtimeMs);
            insertAsset.run(id, photoPath, fileName, extension, sourceStat.size, modifiedAt);
            insertDimensions.run(id, sourceStat.size, modifiedAt, dimensions.width, dimensions.height);
          }
          writer.exec('COMMIT');
        } catch (error) {
          writer.exec('ROLLBACK');
          throw error;
        } finally { writer.close(); }
        catalog!.close();
        catalogClosed = true;
      } else {
        await catalog!.importFolders([source!]);
        catalog!.close();
        catalogClosed = true;
      }
      for (const pass of ['cold', 'warm']) {
        app = await electron.launch({ args: [path.resolve('apps/desktop/out/main/index.js')], env: { ...process.env, PHOTOALLISAI_USER_DATA: userData, PHOTOALLISAI_STARTUP_TRACE: '1' } });
        if (rawDiagnosticPath && pass === 'cold') {
          const rawDecode = await app.evaluate(({ nativeImage }, filePath) => {
            const started = performance.now();
            const image = nativeImage.createFromPath(filePath);
            return { elapsedMs: performance.now() - started, empty: image.isEmpty(), size: image.getSize() };
          }, rawDiagnosticPath);
          console.info(JSON.stringify({ pass: 'native-raw-decode', ...rawDecode }));
        }
        const page = await app.firstWindow();
        const thumbnailRequests: string[] = [];
        let thumbnailFailuresLogged = 0;
        page.on('request', (request) => {
          if (request.url().startsWith('photoasset://thumbnail/')) thumbnailRequests.push(request.url());
        });
        page.on('requestfailed', (request) => {
          if (request.url().startsWith('photoasset://thumbnail/') && thumbnailFailuresLogged++ < 8) {
            console.info(JSON.stringify({ pass, thumbnailRequestFailed: request.url(), error: request.failure()?.errorText }));
          }
        });
        page.on('response', (response) => {
          if (response.url().startsWith('photoasset://thumbnail/') && response.status() >= 400 && thumbnailFailuresLogged++ < 8) {
            console.info(JSON.stringify({ pass, thumbnailResponseFailed: response.url(), status: response.status() }));
          }
        });
        console.info(JSON.stringify({ pass, startup: await readFile(path.join(userData, 'logs', 'startup-timing.log'), 'utf8').catch(() => '') }));
        await expect(page.locator('.app-shell')).toBeVisible({ timeout: 120_000 });
        const replacedVariants: Record<string, number> = {};
        if (replaceThumbnails) {
          const body = await readFile(path.resolve('apps/desktop/src/renderer/public/demo/portrait.jpg'));
          await page.route(/^photoasset:\/\/(thumbnail|medium|preview)\//, async (route) => {
            const variant = new URL(route.request().url()).host;
            replacedVariants[variant] = (replacedVariants[variant] ?? 0) + 1;
            await route.fulfill({ status: 200, contentType: 'image/jpeg', body });
          });
        }
        await page.evaluate((selectedView) => {
          localStorage.setItem('photoallisai.catalog-view-mode', selectedView);
          localStorage.setItem('photoallisai.thumbnail-size', '160');
        }, viewMode);
        await page.reload();
        await page.locator('.smart-collection-row .smart-collection-open').first().evaluate((button: HTMLButtonElement) => button.click());
        await expect(page.locator('.catalog-grid .catalog-card').first()).toBeVisible({ timeout: 60_000 });
        for (let pageIndex = 0; pageIndex < Math.ceil(minimumLoaded / 128); pageIndex += 1) {
          const grid = page.locator('.catalog-grid');
          const loaded = Number(await grid.getAttribute('data-loaded-count'));
          if (loaded >= minimumLoaded || await page.locator('.catalog-load-more').count() === 0) break;
          await expect(page.locator('.catalog-load-more')).toBeEnabled({ timeout: 120_000 });
          await page.locator('.catalog-load-more').evaluate((button: HTMLButtonElement) => button.click());
          await expect.poll(async () => Number(await grid.getAttribute('data-loaded-count')), { timeout: 30_000 }).toBeGreaterThan(loaded);
        }
        await expect.poll(async () => Number(await page.locator('.catalog-grid').getAttribute('data-loaded-count')), { timeout: 120_000 }).toBeGreaterThanOrEqual(minimumLoaded);
        await page.locator('.catalog-grid').evaluate((element) => { element.scrollTop = 0; });
        const layout = await page.locator('.catalog-grid').evaluate((element) => ({
          className: element.className,
          width: element.clientWidth,
          height: element.clientHeight,
          cards: element.querySelectorAll('.catalog-card').length,
          loaded: element.getAttribute('data-loaded-count')
        }));
        console.info(JSON.stringify({ pass, layout }));
        const inspectGallery = async (stage: string) => {
          const inspection = await page.evaluate(galleryInspectionScript) as GalleryInspection;
          const ready = inspection.images.filter((item) => item.imageReady);
          console.info(JSON.stringify({ pass, stage, view: inspection.view, mounted: inspection.mountedCount,
            ready: ready.length, portraits: ready.filter((item) => item.decoded.height! > item.decoded.width!).length,
            missingIndex: inspection.images.filter((item) => !item.indexed.width || !item.indexed.height).length,
            mismatches: ready.filter((item) => item.ratioMismatch).slice(0, 12) }));
          expect(ready.filter((item) => item.ratioMismatch)).toEqual([]);
          return ready.length;
        };
        await expect.poll(() => page.locator('.catalog-card img.is-ready').count(), { timeout: 60_000 }).toBeGreaterThan(0);
        await inspectGallery('before-scroll');
        expect(layout.className).toContain('is-windowed');
        expect(layout.cards).toBeLessThanOrEqual(Number(layout.loaded));
        expect(layout.height).toBeLessThan(2_000);
        const baseline = await app.evaluate(async () => {
          const histogram = process.getBuiltinModule('node:perf_hooks').monitorEventLoopDelay({ resolution: 20 });
          histogram.enable();
          await new Promise((resolve) => setTimeout(resolve, 1_000));
          histogram.disable();
          return { maxMs: histogram.max / 1_000_000, meanMs: histogram.mean / 1_000_000 };
        });
        console.info(JSON.stringify({ pass, stage: 'idle-baseline', mainLoopDelay: baseline }));
        await page.evaluate(() => {
          const samples: number[] = [];
          const tasks: number[] = [];
          (window as unknown as { scrollProfile: { samples: number[]; tasks: number[] } }).scrollProfile = { samples, tasks };
          let prior = performance.now();
          const frame = (now: number) => { samples.push(now - prior); prior = now; requestAnimationFrame(frame); };
          requestAnimationFrame(frame);
          new PerformanceObserver((list) => { for (const entry of list.getEntries()) tasks.push(entry.duration); }).observe({ type: 'longtask' });
        });
        const before = await page.evaluate(() => window.desktopApi.getDiagnosticSnapshot());
        await app.evaluate(() => {
          const inspector = process.getBuiltinModule('node:inspector');
          const mainProfile = new inspector.Session();
          mainProfile.connect();
          mainProfile.post('Profiler.enable');
          mainProfile.post('Profiler.start');
          (globalThis as typeof globalThis & { mainProfile?: typeof mainProfile }).mainProfile = mainProfile;
          const histogram = process.getBuiltinModule('node:perf_hooks').monitorEventLoopDelay({ resolution: 20 });
          histogram.enable();
          (globalThis as typeof globalThis & { scrollDelay?: typeof histogram }).scrollDelay = histogram;
        });
        const session = await page.context().newCDPSession(page);
        await session.send('Profiler.enable');
        await session.send('Profiler.start');
        const grid = page.locator('.catalog-grid');
        const bounds = await grid.boundingBox();
        if (!bounds) throw new Error('Gallery is not visible');
        await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
        for (let step = 0; step < 12; step += 1) {
          await page.mouse.wheel(0, bounds.height * 0.8);
          await page.waitForTimeout(180);
        }
        await page.waitForTimeout(2_000);
        await inspectGallery('after-scroll');
        const cpu = await session.send('Profiler.stop');
        await session.detach();
        const mainLoopDelay = await app.evaluate(() => {
          const histogram = (globalThis as typeof globalThis & { scrollDelay: ReturnType<typeof import('node:perf_hooks').monitorEventLoopDelay> }).scrollDelay;
          histogram.disable();
          return { maxMs: histogram.max / 1_000_000, meanMs: histogram.mean / 1_000_000 };
        });
        const mainTop = await app.evaluate(async () => {
          const session = (globalThis as typeof globalThis & { mainProfile: import('node:inspector').Session }).mainProfile;
          const profile = await new Promise<import('node:inspector').Profiler.Profile>((resolve, reject) => {
            session.post('Profiler.stop', (error, result) => error ? reject(error) : resolve(result.profile));
          });
          session.disconnect();
          const hits = new Map<number, number>();
          for (const id of profile.samples ?? []) hits.set(id, (hits.get(id) ?? 0) + 1);
          const parents = new Map<number, number>();
          const nodes = new Map(profile.nodes.map((node) => [node.id, node]));
          for (const node of profile.nodes) for (const child of node.children ?? []) parents.set(child, node.id);
          return profile.nodes.map((node) => {
            const stack: string[] = [];
            let ancestor = parents.get(node.id);
            while (ancestor && stack.length < 8) {
              const frame = nodes.get(ancestor)?.callFrame;
              if (frame?.functionName) stack.push(frame.functionName);
              ancestor = parents.get(ancestor);
            }
            return { name: node.callFrame.functionName, url: node.callFrame.url, hits: hits.get(node.id) ?? 0, stack };
          }).filter((entry) => entry.hits > 0 && entry.name !== '(idle)')
            .sort((left, right) => right.hits - left.hits).slice(0, 20);
        });
        const after = await page.evaluate(() => window.desktopApi.getDiagnosticSnapshot());
        const profile = await page.evaluate(() => (window as unknown as { scrollProfile: { samples: number[]; tasks: number[] } }).scrollProfile);
        const frames = profile.samples.filter((value) => value > 0);
        const sorted = frames.toSorted((left, right) => left - right);
        const hits = new Map<number, number>();
        for (const id of cpu.profile.samples ?? []) hits.set(id, (hits.get(id) ?? 0) + 1);
        const top = cpu.profile.nodes.map((node) => ({ name: node.callFrame.functionName, url: node.callFrame.url, hits: hits.get(node.id) ?? 0 }))
          .filter((entry) => entry.hits > 0).sort((left, right) => right.hits - left.hits).slice(0, 15);
        console.info(JSON.stringify({ pass, replaceThumbnails, replacedVariants, loaded: await grid.getAttribute('data-loaded-count'), cards: await page.locator('.catalog-grid .catalog-card').count(),
          frames: frames.length, p95Frame: sorted[Math.floor(sorted.length * .95)], maxFrame: Math.max(...frames), framesOver33: frames.filter((value) => value > 33).length, top,
          longTasks: profile.tasks.length, longTaskTotal: profile.tasks.reduce((sum, value) => sum + value, 0),
          longTaskMax: Math.max(0, ...profile.tasks), mainLoopDelay, mainTop, before: before.cache.performance, after: after.cache.performance }));
        if (pass === 'warm') {
          const firstPassRequests = new Set(thumbnailRequests);
          thumbnailRequests.length = 0;
          await grid.evaluate((element) => { element.scrollTop = 0; });
          await page.waitForTimeout(1_000);
          const session = await page.context().newCDPSession(page);
          await session.send('Profiler.enable');
          await session.send('Profiler.start');
          const previous = await page.evaluate(() => {
            const profile = (window as unknown as { scrollProfile: { samples: number[]; tasks: number[] } }).scrollProfile;
            return { frames: profile.samples.length, tasks: profile.tasks.length };
          });
          const cacheBefore = await page.evaluate(() => window.desktopApi.getDiagnosticSnapshot());
          await app.evaluate(() => {
            const histogram = process.getBuiltinModule('node:perf_hooks').monitorEventLoopDelay({ resolution: 20 });
            histogram.enable();
            (globalThis as typeof globalThis & { scrollDelay?: typeof histogram }).scrollDelay = histogram;
          });
          for (let step = 0; step < 12; step += 1) {
            await page.mouse.wheel(0, bounds.height * 0.8);
            await page.waitForTimeout(180);
          }
          await page.waitForTimeout(500);
          const cpu = await session.send('Profiler.stop');
          const mainLoopDelay = await app.evaluate(() => {
            const histogram = (globalThis as typeof globalThis & { scrollDelay: ReturnType<typeof import('node:perf_hooks').monitorEventLoopDelay> }).scrollDelay;
            histogram.disable();
            return { maxMs: histogram.max / 1_000_000, meanMs: histogram.mean / 1_000_000 };
          });
          const cacheAfter = await page.evaluate(() => window.desktopApi.getDiagnosticSnapshot());
          const revisit = await page.evaluate((start) => {
            const profile = (window as unknown as { scrollProfile: { samples: number[]; tasks: number[] } }).scrollProfile;
            return { frames: profile.samples.slice(start.frames), tasks: profile.tasks.slice(start.tasks) };
          }, previous);
          const hits = new Map<number, number>();
          for (const id of cpu.profile.samples ?? []) hits.set(id, (hits.get(id) ?? 0) + 1);
          const top = cpu.profile.nodes.map((node) => ({ name: node.callFrame.functionName, url: node.callFrame.url, hits: hits.get(node.id) ?? 0 }))
            .filter((entry) => entry.hits > 0).sort((left, right) => right.hits - left.hits).slice(0, 12);
          const orderedFrames = revisit.frames.toSorted((left, right) => left - right);
          console.info(JSON.stringify({ pass: 'revisit', p95Frame: orderedFrames[Math.floor(orderedFrames.length * .95)],
            maxFrame: Math.max(...revisit.frames), longTasks: revisit.tasks.length, mainLoopDelay, top,
            thumbnailRequests: thumbnailRequests.length,
            repeatedThumbnailRequests: thumbnailRequests.filter((url) => firstPassRequests.has(url)).length,
            newThumbnailRequests: thumbnailRequests.filter((url) => !firstPassRequests.has(url)).length,
            cacheBefore: cacheBefore.cache.performance, cacheAfter: cacheAfter.cache.performance }));
          await session.detach();
        }
        await app.close();
        app = undefined;
      }
    } finally {
      if (app) await app.close();
      if (catalog && !catalogClosed) catalog.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
