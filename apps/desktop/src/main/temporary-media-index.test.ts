import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { TemporaryMediaIndex } from './temporary-media-index';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe('temporary media index', () => {
  it('pages a large disposable directory and revokes the previous session', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'photoallisai-temporary-index-'));
    roots.push(root);
    const index = new TemporaryMediaIndex(path.join(root, 'temporary.sqlite'));
    const session = 'first';
    index.begin(session);
    for (let start = 0; start < 100_000; start += 250) {
      index.insert(session, Array.from({ length: 250 }, (_, offset) => {
        const number = start + offset;
        return { id: `asset-${number}`, file: path.join(root, `photo${String(number).padStart(5, '0')}.jpg`) };
      }));
    }
    const started = performance.now();
    index.finish(session);
    const page = index.page(session, 99_750, 250);
    const deepPageMs = performance.now() - started;
    console.info('temporary index 100k deep page', { deepPageMs: Math.round(deepPageMs * 100) / 100 });
    expect(page.totalCount).toBe(100_000);
    expect(page.items).toHaveLength(250);
    expect(page.items[0]?.fileName).toBe('photo99750.jpg');
    expect(index.resolve('asset-99750')).toBe(path.join(root, 'photo99750.jpg'));
    index.begin('second');
    expect(index.page(session, 0, 10)).toEqual({ items: [], totalCount: 0 });
    expect(index.resolve('asset-99750')).toBeNull();
    index.insert(session, [{ id: 'stale', file: path.join(root, 'stale.jpg') }]);
    expect(index.resolve('stale')).toBeNull();
    index.close();
  });

  it('orders numbered filenames naturally and finds the selected position', () => {
    const index = new TemporaryMediaIndex();
    index.begin('natural');
    index.insert('natural', ['photo10.jpg', 'photo2.jpg', 'photo1.jpg'].map((file, offset) => ({ id: `id-${offset}`, file: path.join('/photos', file) })));
    index.finish('natural');
    expect(index.page('natural', 0, 3).items.map((item) => item.fileName)).toEqual(['photo1.jpg', 'photo2.jpg', 'photo10.jpg']);
    expect(index.position('natural', 'id-0')).toBe(2);
    index.close();
  });

  it('keeps pages responsive while sorting and cancels stale sessions', async () => {
    const index = new TemporaryMediaIndex();
    index.begin('large');
    for (let start = 0; start < 40_000; start += 500) {
      index.insert('large', Array.from({ length: 500 }, (_, offset) => {
        const number = 39_999 - start - offset;
        return { id: `id-${number}`, file: `/photos/photo${number}.jpg` };
      }));
    }
    const sorting = index.finishAsync('large');
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(index.page('large', 0, 1).totalCount).toBe(40_000);
    expect(index.position('large', 'id-39999')).toBe(0);
    index.begin('replacement');
    index.insert('replacement', [{ id: 'new', file: '/photos/new.jpg' }]);
    await sorting;
    expect(index.page('replacement', 0, 1).items[0]?.id).toBe('new');
    expect(index.page('large', 0, 1).items).toEqual([]);
    index.close();
  });

  it('finishes a natural sort without losing the selected position', async () => {
    const index = new TemporaryMediaIndex();
    index.begin('natural-async');
    index.insert('natural-async', ['photo10.jpg', 'photo2.jpg', 'photo1.jpg'].map((file, offset) => ({ id: `id-${offset}`, file: `/photos/${file}` })));
    await index.finishAsync('natural-async');
    expect(index.page('natural-async', 0, 3).items.map((item) => item.fileName)).toEqual(['photo1.jpg', 'photo2.jpg', 'photo10.jpg']);
    expect(index.position('natural-async', 'id-0')).toBe(2);
    expect(() => index.insert('natural-async', [{ id: 'late', file: '/photos/late.jpg' }])).toThrow('TEMPORARY_INDEX_COMPLETE');
    index.close();
  });

  it('can restart sorting after records arrive during an earlier sort', async () => {
    const index = new TemporaryMediaIndex();
    index.begin('growing');
    index.insert('growing', Array.from({ length: 30_000 }, (_, number) => ({
      id: `id-${number}`, file: `/photos/photo${30_000 - number}.jpg`
    })));
    const firstSort = index.finishAsync('growing');
    await new Promise<void>((resolve) => setImmediate(resolve));
    index.insert('growing', [{ id: 'new', file: '/photos/photo0.jpg' }]);
    await firstSort;
    await index.finishAsync('growing');
    expect(index.page('growing', 0, 1).items[0]?.id).toBe('new');
    expect(index.position('growing', 'id-0')).toBe(30_000);
    index.close();
  });

  it('resolves files from a shared directory and mixed explicit paths', () => {
    const index = new TemporaryMediaIndex();
    index.begin('mixed');
    index.insert('mixed', [
      { id: 'first', file: '/photos/first.jpg' },
      { id: 'other', file: '/elsewhere/other.jpg' },
      { id: 'second', file: '/photos/second.jpg' }
    ]);
    expect(index.resolve('first')).toBe('/photos/first.jpg');
    expect(index.resolve('other')).toBe('/elsewhere/other.jpg');
    expect(index.resolve('second')).toBe('/photos/second.jpg');
    index.begin('new');
    index.insert('new', [{ id: 'next', file: '/new/next.jpg' }]);
    expect(index.resolve('first')).toBeNull();
    expect(index.resolve('next')).toBe('/new/next.jpg');
    index.close();
  });

  it('keeps the event loop available while sorting one hundred thousand reverse ordered items', async () => {
    const index = new TemporaryMediaIndex();
    index.begin('hundred-thousand');
    for (let start = 0; start < 100_000; start += 500) {
      index.insert('hundred-thousand', Array.from({ length: 500 }, (_, offset) => {
        const number = 99_999 - start - offset;
        return { id: `id-${number}`, file: `/photos/photo${String(number).padStart(6, '0')}.jpg` };
      }));
    }
    let ticks = 0;
    const timer = setInterval(() => { ticks += 1; }, 1);
    const started = performance.now();
    try {
      await index.finishAsync('hundred-thousand');
    } finally {
      clearInterval(timer);
    }
    const sortMs = performance.now() - started;
    console.info('temporary index 100k async sort', { sortMs: Math.round(sortMs), ticks });
    expect(ticks).toBeGreaterThan(5);
    expect(index.page('hundred-thousand', 0, 1).items[0]?.fileName).toBe('photo000000.jpg');
    expect(index.page('hundred-thousand', 99_999, 1).items[0]?.fileName).toBe('photo099999.jpg');
    expect(index.position('hundred-thousand', 'id-99999')).toBe(99_999);
    index.close();
  });
});
