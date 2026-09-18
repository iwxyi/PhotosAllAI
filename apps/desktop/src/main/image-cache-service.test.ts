import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ImageCacheService } from './image-cache-service';

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
    expect(await service.getStats()).toEqual({ files: 2, bytes: 30 });
    expect(await service.prune(20)).toEqual({ removedFiles: 1, removedBytes: 10 });
    expect(await service.getStats()).toEqual({ files: 1, bytes: 20 });
  });
});
