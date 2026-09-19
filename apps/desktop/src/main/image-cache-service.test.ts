import { mkdir, mkdtemp, readFile, readdir, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ImageCacheService, writeCacheFileAtomically } from './image-cache-service';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('image cache governance', () => {
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
    expect(service.getPerformanceStats()).toEqual({ hits: 0, misses: 0, decodes: 0, decodeMsTotal: 0 });
    await expect(new ImageCacheService(directory, {} as never, async () => ({ imageMagick: true, sips: false })).getDecoderCapabilities()).resolves.toEqual({ nativeImage: true, imageMagick: true, sips: false });
    await expect(new ImageCacheService(directory, {} as never, async () => ({ imageMagick: false, sips: true })).getDecoderCapabilities()).resolves.toEqual({ nativeImage: true, imageMagick: false, sips: true });
    expect(await service.getStats()).toEqual({ files: 2, bytes: 30 });
    expect(await service.prune(20)).toEqual({ removedFiles: 1, removedBytes: 10 });
    expect(await service.getStats()).toEqual({ files: 1, bytes: 20 });
    await writeFile(path.join(nested, 'later.jpg'), Buffer.alloc(15));
    expect(await service.setMaxBytes(20)).toEqual({ removedFiles: 1, removedBytes: 20 });
    expect(await service.getStats()).toEqual({ files: 1, bytes: 15 });
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
