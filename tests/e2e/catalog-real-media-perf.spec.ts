import { link, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type * as inspectorModule from 'node:inspector';
import { DatabaseSync } from 'node:sqlite';
import { _electron as electron, expect, test } from '@playwright/test';

import { CatalogService } from '../../apps/desktop/src/main/catalog-service';

const count = Number(process.env.PHOTOALLISAI_PERF_COUNT ?? 1_000);
const profileMain = process.env.PHOTOALLISAI_PROFILE_MAIN === '1';
const abortProbe = process.env.PHOTOALLISAI_ABORT_PROBE === '1';
const loadTo = Number(process.env.PHOTOALLISAI_PERF_LOAD_TO ?? 0);
const rendererLoadTo = Number(process.env.PHOTOALLISAI_PERF_RENDERER_LOAD_TO ?? 0);
const viewMode = process.env.PHOTOALLISAI_PERF_VIEW ?? 'grid';
const mixedMedia = process.env.PHOTOALLISAI_PERF_MIXED_MEDIA === '1';
const sustainedCycles = Number(process.env.PHOTOALLISAI_PERF_CYCLES ?? 0);
const source = path.resolve('apps/desktop/src/renderer/public/demo/portrait.jpg');
const mixedSources = [
  'test_data/2025.09.14 苏州旗袍-茹意、33/33-园林/833A1252.jpeg',
  'test_data/2025.09.14 苏州旗袍-茹意、33/33-园林/833A1287.jpeg',
  'test_data/2023.11.25 杭州之门-光绘/WechatIMG601.png',
  'test_data/2023.11.25 杭州之门-光绘/DSC04042.png'
].map((file) => path.resolve(file));

test('measures real catalog image scrolling', async () => {
  test.setTimeout(Math.max(Math.max(loadTo, rendererLoadTo) > 0 ? Math.max(120_000, Math.min(1_200_000, Math.max(loadTo, rendererLoadTo) * 30)) : profileMain ? 180_000 : 120_000, sustainedCycles * 15_000 + 120_000));
  if (!Number.isSafeInteger(count) || count < 100 || count > 100_000) throw new RangeError('PHOTOALLISAI_PERF_COUNT must be 100..100000');
  if (!Number.isSafeInteger(loadTo) || loadTo < 0 || loadTo > count) throw new RangeError('PHOTOALLISAI_PERF_LOAD_TO must be 0..PHOTOALLISAI_PERF_COUNT');
  if (!Number.isSafeInteger(rendererLoadTo) || rendererLoadTo < 0 || rendererLoadTo > count) throw new RangeError('PHOTOALLISAI_PERF_RENDERER_LOAD_TO must be 0..PHOTOALLISAI_PERF_COUNT');
  if (!['grid', 'masonry', 'justified'].includes(viewMode)) throw new RangeError('PHOTOALLISAI_PERF_VIEW must be grid, masonry, or justified');
  if (!Number.isSafeInteger(sustainedCycles) || sustainedCycles < 0 || sustainedCycles > 100) throw new RangeError('PHOTOALLISAI_PERF_CYCLES must be 0..100');
  const root = await mkdtemp(path.join(tmpdir(), 'photoallisai-real-media-perf-'));
  const userData = path.join(root, 'user-data');
  const media = path.join(root, 'media');
  let application: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    await mkdir(media, { recursive: true });
    const sources = mixedMedia ? mixedSources : [source];
    const sourceSizes = await Promise.all(sources.map(async (file) => (await stat(file)).size));
    const databasePath = path.join(userData, 'library', 'catalog.sqlite');
    await mkdir(path.dirname(databasePath), { recursive: true });
    new CatalogService(databasePath).close();
    const database = new DatabaseSync(databasePath);
    database.prepare('INSERT INTO folders (id, path, name, imported_at) VALUES (?, ?, ?, ?)')
      .run('perf-media', media, 'Perf Media', 1);
    const insert = database.prepare(`
      INSERT INTO assets (id, folder_id, path, file_name, extension, size_bytes, modified_at, imported_at)
      VALUES (?, 'perf-media', ?, ?, ?, ?, ?, 1)
    `);
    database.exec('BEGIN IMMEDIATE');
    for (let index = 0; index < count; index += 1) {
      const sample = index % sources.length;
      const extension = path.extname(sources[sample]!);
      const name = `PHOTO_${String(index).padStart(6, '0')}${extension}`;
      const file = path.join(media, name);
      await link(sources[sample]!, file);
      insert.run(index.toString(16).padStart(32, '0'), file, name, extension, sourceSizes[sample]!, Date.UTC(2020, 0, 1) + index * 1000);
    }
    database.exec('COMMIT');
    database.close();

    const started = performance.now();
    application = await electron.launch({
      args: [path.resolve('apps/desktop/out/main/index.js')],
      env: { ...process.env, PHOTOALLISAI_USER_DATA: userData }
    });
    const page = await application.firstWindow();
    const viewButton = page.getByRole('button', { name: viewMode === 'grid' ? '网格视图' : viewMode === 'masonry' ? '瀑布流视图' : '等高瀑布流', exact: true });
    if (!(await viewButton.isVisible())) {
      await page.getByRole('button', { name: '配置图库工具栏', exact: true }).click();
      await page.getByRole('checkbox', { name: '视图', exact: true }).check();
      await page.keyboard.press('Escape');
    }
    await viewButton.click();
    const grid = page.getByRole('listbox', { name: '图库照片' });
    await expect(grid).toBeVisible();
    try {
      await expect.poll(() => grid.locator('img').evaluateAll((images) => images.filter((image) => (image as HTMLImageElement).naturalWidth > 0).length), { timeout: 15_000 }).toBeGreaterThan(0);
    } catch (error) {
      const images = await grid.locator('img').evaluateAll((elements) => elements.slice(0, 12).map((image) => ({ src: image.getAttribute('src'), complete: (image as HTMLImageElement).complete, naturalWidth: (image as HTMLImageElement).naturalWidth })));
      const diagnostic = await page.evaluate(async () => window.desktopApi.getDiagnosticSnapshot());
      console.log(JSON.stringify({ count, failure: 'first-screen-timeout', elapsedMs: Math.round(performance.now() - started), images, cache: diagnostic.cache, catalogWatcher: diagnostic.catalogWatcher }));
      throw error;
    }
    const firstScreenMs = Math.round(performance.now() - started);
    const beforeScroll = await page.evaluate(async () => window.desktopApi.getDiagnosticSnapshot());
    console.log(JSON.stringify({ count, viewMode, mixedMedia, sources: sources.map((file, index) => ({ file, bytes: sourceSizes[index] })), phase: 'before-scroll', firstScreenMs, cache: beforeScroll.cache, catalogWatcher: beforeScroll.catalogWatcher }));
    if (abortProbe) {
      const probe = await page.evaluate(async () => {
        const requests = Array.from({ length: 50 }, (_, index) => {
          const image = document.createElement('img');
          const id = crypto.randomUUID();
          image.src = `photoasset://thumbnail/${(5_000 + index).toString(16).padStart(32, '0')}?requestId=${id}`;
          document.body.append(image);
          return { image, id };
        });
        await new Promise((resolve) => setTimeout(resolve, 25));
        const loadedBeforeRemoval = requests.filter(({ image }) => image.complete && image.naturalWidth > 0).length;
        for (const { image, id } of requests) {
          image.removeAttribute('src');
          image.remove();
          window.desktopApi.cancelPreviewRequest(id);
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
        return { issued: requests.length, loadedBeforeRemoval };
      });
      const afterAbort = await page.evaluate(async () => (await window.desktopApi.getDiagnosticSnapshot()).cache.performance);
      console.log(JSON.stringify({ count, phase: 'abort-probe', probe, before: beforeScroll.cache.performance, after: afterAbort }));
      expect(afterAbort.abortedConsumers).toBeGreaterThan(beforeScroll.cache.performance.abortedConsumers);
      expect(afterAbort.canceledQueued).toBeGreaterThan(beforeScroll.cache.performance.canceledQueued);
    }
    const profilePromise = profileMain ? application.evaluate(async () => {
      const inspector = process.getBuiltinModule('node:inspector') as typeof inspectorModule;
      const { Session } = inspector;
      const session = new Session();
      session.connect();
      const post = (method: 'Profiler.enable' | 'Profiler.start') => new Promise<void>((resolve, reject) => {
        session.post(method, (error) => error ? reject(error) : resolve());
      });
      try {
        await post('Profiler.enable');
        await post('Profiler.start');
        await new Promise((resolve) => setTimeout(resolve, 12_000));
        return await new Promise<string>((resolve, reject) => {
          session.post('Profiler.stop', (error, result) => error ? reject(error) : resolve(JSON.stringify(result.profile)));
        });
      } finally {
        session.disconnect();
      }
    }) : null;
    const sample = await grid.evaluate(async (element) => {
      const deltas: number[] = [];
      let previous = performance.now();
      const startedAt = previous;
      while (performance.now() - startedAt < 4_000) {
        await new Promise<void>((resolve) => requestAnimationFrame((now) => {
          deltas.push(now - previous);
          previous = now;
          element.scrollTop += Math.max(1, element.clientHeight / 5);
          resolve();
        }));
      }
      deltas.sort((a, b) => a - b);
      const percentile = (fraction: number) => Math.round((deltas[Math.min(deltas.length - 1, Math.floor(deltas.length * fraction))] ?? 0) * 10) / 10;
      return {
        frames: deltas.length,
        frameP50Ms: percentile(0.5),
        frameP95Ms: percentile(0.95),
        frameMaxMs: percentile(1),
        mountedCards: element.querySelectorAll('.catalog-card').length,
        scrollTop: element.scrollTop
      };
    });
    if (profilePromise) {
      const profileText = await profilePromise;
      await writeFile(test.info().outputPath('main.cpuprofile'), profileText);
      const profile = JSON.parse(profileText) as { nodes: Array<{ callFrame: { functionName: string; url: string; lineNumber: number }; hitCount?: number }>; samples?: number[] };
      const top = profile.nodes.map((node) => ({ name: node.callFrame.functionName, url: node.callFrame.url, line: node.callFrame.lineNumber + 1, hits: node.hitCount ?? 0 }))
        .sort((left, right) => right.hits - left.hits).slice(0, 25);
      console.log(JSON.stringify({ count, phase: 'main-cpu-profile', samples: profile.samples?.length ?? 0, top }));
    }
    const afterScroll = await page.evaluate(async () => window.desktopApi.getDiagnosticSnapshot());
    console.log(JSON.stringify({ count, phase: 'after-scroll', sample, cache: afterScroll.cache, catalogWatcher: afterScroll.catalogWatcher }));
    const settledAt = performance.now();
    try { await expect.poll(() => grid.evaluate((element) => {
      const viewport = element.getBoundingClientRect();
      const visible = [...element.querySelectorAll<HTMLImageElement>('.catalog-card img')]
        .filter((image) => {
          const rect = image.getBoundingClientRect();
          return rect.bottom > viewport.top && rect.top < viewport.bottom;
        });
      return visible.length > 0 && visible.every((image) => image.naturalWidth > 0);
    }), { timeout: 15_000 }).toBe(true); } catch (error) {
      const visible = await grid.evaluate((element) => {
        const viewport = element.getBoundingClientRect();
        return [...element.querySelectorAll<HTMLImageElement>('.catalog-card img')]
          .filter((image) => {
            const rect = image.getBoundingClientRect();
            return rect.bottom > viewport.top && rect.top < viewport.bottom;
          })
          .map((image) => ({ src: image.getAttribute('src'), complete: image.complete, naturalWidth: image.naturalWidth }));
      });
      const diagnostic = await page.evaluate(async () => window.desktopApi.getDiagnosticSnapshot());
      console.log(JSON.stringify({ count, failure: 'thumbnail-timeout', firstScreenMs, sample, visible, cache: diagnostic.cache, catalogWatcher: diagnostic.catalogWatcher }));
      throw error;
    }
    const thumbnailSettleMs = Math.round(performance.now() - settledAt);
    const decodedImages = await grid.locator('img').evaluateAll((images) => images.filter((image) => (image as HTMLImageElement).naturalWidth > 0).length);
    await grid.evaluate((element) => { element.scrollTop = 0; });
    await expect.poll(() => grid.evaluate((element) => {
      const viewport = element.getBoundingClientRect();
      const visible = [...element.querySelectorAll<HTMLImageElement>('.catalog-card img')]
        .filter((image) => {
          const rect = image.getBoundingClientRect();
          return rect.bottom > viewport.top && rect.top < viewport.bottom;
        });
      return visible.length > 0 && visible.every((image) => image.naturalWidth > 0);
    }), { timeout: 15_000 }).toBe(true);
    const cachePerformance = await page.evaluate(async () => (await window.desktopApi.getDiagnosticSnapshot()).cache.performance);
    const jumpStarted = performance.now();
    const jump = await grid.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
      return { scrollTop: element.scrollTop, viewportHeight: element.clientHeight, scrollHeight: element.scrollHeight };
    });
    await expect.poll(() => grid.evaluate((element) => {
      const viewport = element.getBoundingClientRect();
      const visible = [...element.querySelectorAll<HTMLImageElement>('.catalog-card img')]
        .filter((image) => {
          const rect = image.getBoundingClientRect();
          return rect.bottom > viewport.top && rect.top < viewport.bottom;
        });
      return visible.length > 0 && visible.every((image) => image.naturalWidth > 0);
    }), { timeout: 15_000 }).toBe(true);
    const jumpSettleMs = Math.round(performance.now() - jumpStarted);
    const jumpPerformance = await page.evaluate(async () => (await window.desktopApi.getDiagnosticSnapshot()).cache.performance);
    const jumpDecodes = jumpPerformance.decodes - cachePerformance.decodes;
    const memory = await application.evaluate(({ app }) => ({
      processes: app.getAppMetrics().map((metric) => ({ type: metric.type, pid: metric.pid, workingSetKiB: metric.memory.workingSetSize })),
      version: app.getVersion()
    }));
    console.log(JSON.stringify({ count, viewMode, firstScreenMs, ...sample, thumbnailSettleMs, decodedImages, cachePerformance, jump, jumpSettleMs, jumpDecodes, jumpPerformance, memory }));
    expect(sample.scrollTop).toBeGreaterThan(0);
    expect(sample.mountedCards).toBeLessThan(150);
    expect(jump.scrollTop).toBeGreaterThan(jump.viewportHeight * 2);
    expect(jumpDecodes).toBeLessThan(120);
    if (viewMode === 'justified' || viewMode === 'masonry') {
      const lastCard = grid.locator('.catalog-card').last();
      const selectedId = await lastCard.getAttribute('data-asset-id');
      await lastCard.click();
      await grid.evaluate((element) => { element.scrollTop = 0; });
      await grid.focus();
      await page.keyboard.press('ArrowLeft');
      await expect(grid.locator('.catalog-card.is-focused')).toBeInViewport();
      await expect(grid.locator('.catalog-card.is-focused')).not.toHaveAttribute('data-asset-id', selectedId ?? '');
    }
    if (rendererLoadTo > 0) {
      await application.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]?.hide(); });
      const cdp = await page.context().newCDPSession(page);
      const samples: Array<{ loaded: number; mounted: number; scrollHeight: number; tabKiB: number; jsHeapMiB: number; elapsedMs: number }> = [];
      const pagingStarted = performance.now();
      const samplePage = async (loaded: number) => {
        await cdp.send('HeapProfiler.collectGarbage');
        const layout = await grid.evaluate((element) => ({ mounted: element.querySelectorAll('.catalog-card').length, scrollHeight: element.scrollHeight }));
        const tabKiB = await application.evaluate(({ app }) => app.getAppMetrics().find((metric) => metric.type === 'Tab')?.memory.workingSetSize ?? 0);
        const heap = await cdp.send('Runtime.getHeapUsage');
        return { loaded, ...layout, tabKiB, jsHeapMiB: Math.round(heap.usedSize / 1024 / 1024), elapsedMs: Math.round(performance.now() - pagingStarted) };
      };
      let previousLoaded = Number(await grid.getAttribute('data-loaded-count'));
      expect(previousLoaded, 'renderer target must exceed the pages already loaded during scrolling').toBeLessThan(rendererLoadTo);
      samples.push(await samplePage(previousLoaded));
      let nextSampleAt = previousLoaded + 2_000;
      console.log(JSON.stringify({ count, viewMode, phase: 'renderer-page-progress', ...samples.at(-1) }));
      while (previousLoaded < rendererLoadTo) {
        await grid.evaluate((element) => { element.scrollTop = element.scrollHeight; });
        await expect.poll(() => grid.getAttribute('data-loaded-count'), { timeout: 15_000 }).not.toBe(String(previousLoaded));
        const loaded = Number(await grid.getAttribute('data-loaded-count'));
        expect(loaded).toBeGreaterThan(previousLoaded);
        previousLoaded = loaded;
        if (loaded >= nextSampleAt || loaded >= rendererLoadTo) {
          samples.push(await samplePage(loaded));
          nextSampleAt = loaded + 2_000;
          console.log(JSON.stringify({ count, viewMode, phase: 'renderer-page-progress', ...samples.at(-1) }));
        }
        if (loaded >= count) break;
      }
      expect(previousLoaded).toBeGreaterThanOrEqual(rendererLoadTo);
      expect(samples.every((entry) => entry.mounted < 150)).toBe(true);
      console.log(JSON.stringify({ count, viewMode, phase: 'renderer-page', requested: rendererLoadTo, loaded: previousLoaded, samples }));
      await cdp.detach();
    }
    if (sustainedCycles > 0) {
      if (rendererLoadTo > 0) await application.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]?.show(); });
      const cdp = await page.context().newCDPSession(page);
      const samples: Array<{ cycle: number; position: number; loaded: number; settleMs: number; mounted: number; tabKiB: number; browserKiB: number; heapMiB: number; eventLoopDelayMaxMs: number }> = [];
      try {
        for (let cycle = 0; cycle < sustainedCycles; cycle++) {
          const position = [0, 0.25, 0.5, 0.75, 1][cycle % 5]!;
          const startedAt = performance.now();
          await grid.evaluate((element, fraction) => { element.scrollTop = element.scrollHeight * fraction; }, position);
          await expect.poll(() => grid.evaluate((element) => {
            const viewport = element.getBoundingClientRect();
            const visible = [...element.querySelectorAll<HTMLImageElement>('.catalog-card img')]
              .filter((image) => { const rect = image.getBoundingClientRect(); return rect.bottom > viewport.top && rect.top < viewport.bottom; });
            return visible.length > 0 && visible.every((image) => image.naturalWidth > 0);
          }), { timeout: 15_000 }).toBe(true);
          await cdp.send('HeapProfiler.collectGarbage');
          const [layout, metrics, heap, diagnostic] = await Promise.all([
            grid.evaluate((element) => ({ mounted: element.querySelectorAll('.catalog-card').length, loaded: Number(element.getAttribute('data-loaded-count')) })),
            application.evaluate(({ app }) => app.getAppMetrics().map((metric) => ({ type: metric.type, workingSetKiB: metric.memory.workingSetSize }))),
            cdp.send('Runtime.getHeapUsage'),
            page.evaluate(() => window.desktopApi.getDiagnosticSnapshot())
          ]);
          const sample = {
            cycle: cycle + 1, position, ...layout, settleMs: Math.round(performance.now() - startedAt),
            tabKiB: metrics.find((metric) => metric.type === 'Tab')?.workingSetKiB ?? 0,
            browserKiB: metrics.find((metric) => metric.type === 'Browser')?.workingSetKiB ?? 0,
            heapMiB: Math.round(heap.usedSize / 1024 / 1024),
            eventLoopDelayMaxMs: diagnostic.cache.performance.eventLoopDelayMaxMs
          };
          samples.push(sample);
          expect(layout.mounted).toBeLessThan(150);
          console.log(JSON.stringify({ count, viewMode, mixedMedia, phase: 'sustained-browse', ...sample }));
        }
        if (samples.length >= 10 && samples[4]!.loaded === samples.at(-1)!.loaded) {
          const baseline = samples[4]!;
          const last = samples.at(-1)!;
          expect(last.tabKiB - baseline.tabKiB, 'Tab working set grew more than 100 MiB after warmup').toBeLessThan(100 * 1024);
          expect(last.heapMiB - baseline.heapMiB, 'Retained JS heap grew more than 40 MiB after warmup').toBeLessThan(40);
        }
      } finally {
        await cdp.detach();
      }
    }
    if (loadTo > 0) {
      await grid.evaluate((element) => { element.scrollTop = 0; });
      const pagingStarted = performance.now();
      let cursor = null;
      let loaded = 0;
      let pages = 0;
      const seenIds = new Set<string>();
      let maxPageItems = 0;
      const pageDurationsMs: number[] = [];
      const memorySamples: Array<{ loaded: number; processes: Array<{ type: string; workingSetKiB: number }> }> = [];
      while (loaded < loadTo) {
        const pageStarted = performance.now();
        const pageResult = await page.evaluate((nextCursor) => window.desktopApi.listCatalogAssetPage({ folderId: 'perf-media', cursor: nextCursor, limit: 200 }), cursor);
        pageDurationsMs.push(Math.round(performance.now() - pageStarted));
        expect(pageResult.totalCount).toBe(count);
        expect(pageResult.items.length).toBeGreaterThan(0);
        maxPageItems = Math.max(maxPageItems, pageResult.items.length);
        for (const item of pageResult.items) {
          expect(seenIds.has(item.id)).toBe(false);
          seenIds.add(item.id);
        }
        loaded += pageResult.items.length;
        cursor = pageResult.nextCursor;
        pages += 1;
        if (pages === 1 || pages % 10 === 0 || loaded >= loadTo) {
          const processes = await application.evaluate(({ app }) => app.getAppMetrics().map((metric) => ({ type: metric.type, workingSetKiB: metric.memory.workingSetSize })));
          memorySamples.push({ loaded, processes });
          console.log(JSON.stringify({ count, phase: 'ipc-page-progress', loaded, pages, lastPageMs: pageDurationsMs.at(-1), elapsedMs: Math.round(performance.now() - pagingStarted), processes }));
        }
        if (!cursor) break;
      }
      const sortedDurations = [...pageDurationsMs].sort((a, b) => a - b);
      const pageDuration = (fraction: number) => sortedDurations[Math.min(sortedDurations.length - 1, Math.floor(sortedDurations.length * fraction))] ?? 0;
      console.log(JSON.stringify({ count, phase: 'ipc-page', requested: loadTo, loaded, pages, elapsedMs: Math.round(performance.now() - pagingStarted), maxPageItems, pageLatencyMs: { p50: pageDuration(0.5), p95: pageDuration(0.95), max: pageDuration(1), first: pageDurationsMs[0], last: pageDurationsMs.at(-1) }, memorySamples }));
      expect(loaded).toBeGreaterThanOrEqual(loadTo);
      expect(maxPageItems).toBeLessThanOrEqual(200);
    }
  } finally {
    if (application) await application.close();
    await rm(root, { recursive: true, force: true });
  }
});
