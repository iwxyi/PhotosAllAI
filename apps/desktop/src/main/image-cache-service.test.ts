import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import sharp from 'sharp';

import { createQuickLookThumbnail, ImageCacheService, writeCacheFileAtomically } from './image-cache-service';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('image cache governance', () => {
  it('decodes a large PNG thumbnail with the bundled decoder', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'photoallisai-cache-'));
    directories.push(directory);
    const source = path.join(directory, 'large.png');
    await sharp({ create: { width: 2048, height: 2048, channels: 3, background: '#c0c0c0' } })
      .png({ compressionLevel: 0 }).toFile(source);
    const metadata = await stat(source);
    expect(metadata.size).toBeGreaterThan(8 * 1024 * 1024);
    const service = new ImageCacheService(path.join(directory, 'cache'), {} as never, async () => ({ imageMagick: false, sips: false }));
    try {
      const thumbnail = await service.getOrCreate('large', 'thumbnail', {
        path: source, modifiedAt: metadata.mtimeMs, sizeBytes: metadata.size
      });
      expect(thumbnail).not.toBeNull();
      expect(await sharp(thumbnail!).metadata()).toMatchObject({ format: 'jpeg', width: 384, height: 384 });
      expect(service.getPerformanceStats()).toMatchObject({ decodes: 1, misses: 1 });
    } finally {
      await service.stop();
    }
  });

  it('reuses one medium preview across card zoom sizes', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'photoallisai-cache-medium-'));
    directories.push(directory);
    const source = path.join(directory, 'large.png');
    await sharp({ create: { width: 2400, height: 1600, channels: 3, background: '#385f88' } }).png({ compressionLevel: 0 }).toFile(source);
    const metadata = await stat(source);
    expect(metadata.size).toBeGreaterThan(8 * 1024 * 1024);
    const service = new ImageCacheService(path.join(directory, 'cache'), {} as never);
    try {
      const input = { path: source, modifiedAt: metadata.mtimeMs, sizeBytes: metadata.size };
      const first = await service.getOrCreate('medium-image', 'medium', input);
      const second = await service.getOrCreate('medium-image', 'medium', input);
      expect(second).toBe(first);
      expect(await sharp(first!).metadata()).toMatchObject({ width: 1024, height: 683 });
      expect(service.getPerformanceStats()).toMatchObject({ decodes: 1, hits: 1 });
    } finally { await service.stop(); }
  });

  it('decodes TIFF without external tools or platform thumbnail codecs', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'photoallisai-cache-tiff-'));
    directories.push(directory);
    const source = path.join(directory, 'camera.tiff');
    await sharp({ create: { width: 720, height: 480, channels: 3, background: '#4277aa' } })
      .tiff().toFile(source);
    const metadata = await stat(source);
    const service = new ImageCacheService(path.join(directory, 'cache'), {} as never, async () => ({ imageMagick: false, sips: false }));
    try {
      const preview = await service.getOrCreate('tiff', 'preview', {
        path: source, modifiedAt: metadata.mtimeMs, sizeBytes: metadata.size
      });
      expect(preview).not.toBeNull();
      expect(await sharp(preview!).metadata()).toMatchObject({ format: 'jpeg', width: 720, height: 480 });
      expect(service.getPerformanceStats()).toMatchObject({ decodes: 1, nativeReadMsTotal: 0 });
    } finally {
      await service.stop();
    }
  });

  it.skipIf(process.platform !== 'darwin' || process.env.PHOTOALLISAI_TEST_QUICKLOOK !== '1')('generates a Quick Look fallback in a separate process', async () => {
    const fixture = path.resolve('apps/desktop/src/renderer/public/demo/portrait.jpg');
    const thumbnail = await createQuickLookThumbnail(fixture, 128);
    expect(thumbnail?.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  });
  it('reports and prunes oldest rebuildable previews to a byte budget', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'photoallisai-cache-'));
    directories.push(directory);
    const nested = path.join(directory, 'aa');
    await mkdir(nested, { recursive: true });
    const oldest = path.join(nested, 'old.jpg');
    const newest = path.join(nested, 'new.jpg');
    await writeFile(oldest, Buffer.alloc(10));
    await writeFile(newest, Buffer.alloc(20));
    const oldTime = new Date(1_000);
    const newTime = new Date(2_000);
    await utimes(oldest, oldTime, oldTime);
    await utimes(newest, newTime, newTime);
    const service = new ImageCacheService(directory, {} as never);
    expect(service.getPerformanceStats()).toMatchObject({ hits: 0, misses: 0, decodes: 0, decodeMsTotal: 0, queueWaitMsTotal: 0, createMsTotal: 0, sourceStatMsTotal: 0, nativeDecodeMsTotal: 0, jpegEncodeMsTotal: 0, cacheWriteMsTotal: 0, cachePayloadWriteMsTotal: 0, cachePublishMsTotal: 0, cacheCleanupMsTotal: 0 });
    await expect(new ImageCacheService(directory, {} as never, async () => ({ imageMagick: true, sips: false })).getDecoderCapabilities()).resolves.toEqual({ nativeImage: true, imageMagick: true, sips: false });
    await expect(new ImageCacheService(directory, {} as never, async () => ({ imageMagick: false, sips: true })).getDecoderCapabilities()).resolves.toEqual({ nativeImage: true, imageMagick: false, sips: true });
    expect(await service.getStats()).toEqual({ files: 2, bytes: 30 });
    expect(await service.prune(20)).toEqual({ removedFiles: 1, removedBytes: 10 });
    expect(await service.getStats()).toEqual({ files: 1, bytes: 20 });
    await writeFile(path.join(nested, 'later.jpg'), Buffer.alloc(15));
    expect(await service.setMaxBytes(20)).toEqual({ removedFiles: 1, removedBytes: 20 });
    expect(await service.getStats()).toEqual({ files: 1, bytes: 15 });
  });

  it('evicts an equally recent large preview before a thumbnail but keeps a recently used preview', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'photoallisai-cache-priority-'));
    directories.push(directory);
    const cache = path.join(directory, 'cache');
    await mkdir(cache);
    const thumbnail = path.join(cache, 'asset-thumbnail.jpg');
    const preview = path.join(cache, 'asset-preview.jpg');
    await writeFile(thumbnail, Buffer.alloc(10));
    await writeFile(preview, Buffer.alloc(10));
    const now = Date.now();
    await utimes(thumbnail, new Date(now), new Date(now));
    await utimes(preview, new Date(now), new Date(now));
    const service = new ImageCacheService(cache, {} as never);
    await service.prune(10);
    expect(await stat(thumbnail)).toBeDefined();
    await expect(stat(preview)).rejects.toMatchObject({ code: 'ENOENT' });
    await writeFile(preview, Buffer.alloc(10));
    await utimes(thumbnail, new Date(now - 3 * 24 * 60 * 60_000), new Date(now - 3 * 24 * 60 * 60_000));
    await utimes(preview, new Date(now), new Date(now));
    await service.prune(10);
    expect(await stat(preview)).toBeDefined();
    await expect(stat(thumbnail)).rejects.toMatchObject({ code: 'ENOENT' });
    await service.stop();
  });

  it('clears every cached size for a selected asset only', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'photoallisai-cache-folder-clear-'));
    directories.push(directory);
    const assetId = 'a'.repeat(32);
    const otherId = 'b'.repeat(32);
    const nested = path.join(directory, assetId.slice(0, 2));
    await mkdir(nested, { recursive: true });
    const variants = ['thumbnail', 'medium', 'preview'];
    for (const variant of variants) await writeFile(path.join(nested, `${assetId}-123-456-${variant}.jpg`), variant);
    const other = path.join(nested, `${otherId}-123-456-thumbnail.jpg`);
    await writeFile(other, 'other');
    const service = new ImageCacheService(directory, {} as never);
    try {
      expect(await service.clearAssets([assetId])).toEqual({ removedFiles: 3, removedBytes: variants.join('').length });
      expect(await readFile(other, 'utf8')).toBe('other');
      expect((await readdir(nested)).filter((name) => name.startsWith(`${assetId}-`))).toEqual([]);
    } finally { await service.stop(); }
  });

  it('includes source size in the cache fingerprint', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'photoallisai-cache-'));
    directories.push(directory);
    const assetId = 'asset-size-fingerprint';
    const modifiedAt = 1234;
    const variant = 'thumbnail';
    const firstKey = `${assetId}-${modifiedAt}-10-${variant}`;
    const secondKey = `${assetId}-${modifiedAt}-20-${variant}`;
    const nested = path.join(directory, firstKey.slice(0, 2));
    await mkdir(nested, { recursive: true });
    await writeFile(path.join(nested, `${firstKey}.jpg`), 'first-preview');
    await writeFile(path.join(nested, `${secondKey}.jpg`), 'second-preview');
    let sizeBytes = 10;
    const service = new ImageCacheService(directory, {
      resolveAssetFile: () => ({ path: '/source.jpg', fileName: 'source.jpg', modifiedAt, sizeBytes })
    } as never);

    const first = await service.getOrCreate(assetId, variant);
    sizeBytes = 20;
    const second = await service.getOrCreate(assetId, variant);
    expect(await readFile(first!, 'utf8')).toBe('first-preview');
    expect(await readFile(second!, 'utf8')).toBe('second-preview');
    expect(first).not.toBe(second);
  });

  it('serves cached previews without waiting for the decode queue', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'photoallisai-cache-'));
    directories.push(directory);
    const assetId = 'shared-preview';
    const key = `${assetId}-1234-10-thumbnail`;
    const nested = path.join(directory, key.slice(0, 2));
    const cached = path.join(nested, `${key}.jpg`);
    await mkdir(nested, { recursive: true });
    await writeFile(cached, 'cached-preview');
    const service = new ImageCacheService(directory, {
      resolveAssetFile: () => ({ path: '/source.jpg', fileName: 'source.jpg', modifiedAt: 1234, sizeBytes: 10 })
    } as never);
    const abandoned = new AbortController();
    const active = new AbortController();

    const first = service.getOrCreate(assetId, 'thumbnail', undefined, 'background', abandoned.signal);
    const second = service.getOrCreate(assetId, 'thumbnail', undefined, 'visible', active.signal);
    abandoned.abort();
    await expect(first).resolves.toBeNull();
    await expect(second).resolves.toBe(cached);
    expect(service.getPerformanceStats()).toMatchObject({ hits: 1, decodes: 0, queueWaitMsTotal: 0, canceledQueued: 0 });
  });

  it('does not decode cached previews when consumers abort', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'photoallisai-cache-'));
    directories.push(directory);
    const cached = new Map<string, string>();
    for (const assetId of ['active-one', 'active-two', 'waiting']) {
      const key = `${assetId}-1234-10-thumbnail`;
      const nested = path.join(directory, key.slice(0, 2));
      const filePath = path.join(nested, `${key}.jpg`);
      await mkdir(nested, { recursive: true });
      await writeFile(filePath, 'cached-preview');
      cached.set(assetId, filePath);
    }
    const service = new ImageCacheService(directory, {
      resolveAssetFile: () => ({ path: '/source.jpg', fileName: 'source.jpg', modifiedAt: 1234, sizeBytes: 10 })
    } as never);
    const active = [
      service.getOrCreate('active-one', 'thumbnail'),
      service.getOrCreate('active-two', 'thumbnail')
    ];
    const firstController = new AbortController();
    const secondController = new AbortController();
    const first = service.getOrCreate('waiting', 'thumbnail', undefined, 'background', firstController.signal);
    const second = service.getOrCreate('waiting', 'thumbnail', undefined, 'visible', secondController.signal);

    firstController.abort();
    await expect(first).resolves.toBeNull();
    expect(service.getPerformanceStats()).toMatchObject({ decodes: 0, canceledQueued: 0 });
    secondController.abort();
    await expect(second).resolves.toBeNull();
    expect(service.getPerformanceStats()).toMatchObject({ decodes: 0, canceledQueued: 0 });
    await Promise.all(active);
    expect(service.getPerformanceStats().hits).toBe(2);

    await expect(service.getOrCreate('waiting', 'thumbnail')).resolves.toBe(cached.get('waiting'));
    expect(service.getPerformanceStats().hits).toBe(3);
  });

  it('reuses a temporary preview across session IDs and invalidates changed source metadata', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'photoallisai-cache-'));
    directories.push(directory);
    const source = '/photos/photo.jpg';
    const hash = createHash('sha256').update(source).digest('hex');
    const cacheKey = (size: number) => `temporary-${hash}-1234-${size}-thumbnail`;
    for (const [size, contents] of [[10, 'old'], [20, 'new']] as const) {
      const key = cacheKey(size);
      const nested = path.join(directory, key.slice(0, 2));
      await mkdir(nested, { recursive: true });
      await writeFile(path.join(nested, `${key}.jpg`), contents);
    }
    const service = new ImageCacheService(directory, {} as never);
    const first = await service.getOrCreate('session-one', 'thumbnail', { path: source, modifiedAt: 1234, sizeBytes: 10 });
    const reopened = await service.getOrCreate('session-two', 'thumbnail', { path: source, modifiedAt: 1234, sizeBytes: 10 });
    const changed = await service.getOrCreate('session-three', 'thumbnail', { path: source, modifiedAt: 1234, sizeBytes: 20 });
    expect(first).toBe(reopened);
    expect(changed).not.toBe(first);
    expect(await readFile(first!, 'utf8')).toBe('old');
    expect(await readFile(changed!, 'utf8')).toBe('new');
    expect(service.getPerformanceStats().hits).toBe(3);
  });

  it('removes only recognized regular cache temporary files', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'photoallisai-cache-'));
    directories.push(directory);
    const nested = path.join(directory, 'aa');
    await mkdir(nested, { recursive: true });
    const legacy = path.join(nested, 'asset-preview.jpg.123.456.tmp');
    const current = path.join(nested, 'asset-preview.jpg.123.5aa8e874-6f6c-4828-b1ea-a7f15a28b0d1.tmp');
    const unknown = path.join(nested, 'keep-me.tmp');
    const outside = path.join(directory, 'outside.txt');
    const linked = path.join(nested, 'linked.jpg.123.456.tmp');
    await writeFile(legacy, 'legacy');
    await writeFile(current, 'current');
    await writeFile(unknown, 'unknown');
    await writeFile(outside, 'outside');
    await symlink(outside, linked);
    const service = new ImageCacheService(directory, {} as never);

    await expect(service.cleanupTemporaryFiles()).resolves.toEqual({
      removedFiles: 2,
      removedBytes: Buffer.byteLength('legacycurrent')
    });
    expect(await readFile(unknown, 'utf8')).toBe('unknown');
    expect(await readFile(linked, 'utf8')).toBe('outside');
  });

  it('cleans the temporary payload when atomic cache publication fails', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'photoallisai-cache-'));
    directories.push(directory);
    const destination = path.join(directory, 'blocked.jpg');
    await mkdir(destination);

    await expect(writeCacheFileAtomically(destination, Buffer.from('preview'))).rejects.toThrow();
    expect(await readdir(directory)).toEqual(['blocked.jpg']);
  });

  it('replaces an existing cache file without leaving transaction artifacts', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'photoallisai-cache-'));
    directories.push(directory);
    const destination = path.join(directory, 'preview.jpg');
    await writeFile(destination, 'old-preview');

    await expect(writeCacheFileAtomically(destination, Buffer.from('new-preview'))).resolves.toBe(destination);

    expect(await readFile(destination, 'utf8')).toBe('new-preview');
    expect(await readdir(directory)).toEqual(['preview.jpg']);
  });

  it('does not replace a symbolic-link cache destination', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'photoallisai-cache-'));
    directories.push(directory);
    const outside = path.join(directory, 'outside.jpg');
    const destination = path.join(directory, 'preview.jpg');
    await writeFile(outside, 'outside-preview');
    await symlink(outside, destination);

    await expect(writeCacheFileAtomically(destination, Buffer.from('new-preview')))
      .rejects.toThrow('DESTINATION_NOT_REGULAR_FILE');
    expect(await readFile(outside, 'utf8')).toBe('outside-preview');
    expect(await readdir(directory)).toEqual(['outside.jpg', 'preview.jpg']);
  });
});
