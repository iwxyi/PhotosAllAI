import { describe, expect, it } from 'vitest';
import { PreviewWorkQueue } from './preview-work-queue';

describe('preview work queue', () => {
  it('bounds active work and runs visible previews before waiting background work', async () => {
    const queue = new PreviewWorkQueue(1);
    const started: string[] = [];
    let finishFirst: (() => void) | undefined;
    const first = queue.enqueue(async () => {
      started.push('first');
      await new Promise<void>((resolve) => { finishFirst = resolve; });
      return 1;
    }, 'background');
    const second = queue.enqueue(async () => { started.push('background'); return 2; }, 'background');
    const third = queue.enqueue(async () => { started.push('visible'); return 3; }, 'visible');
    await Promise.resolve();
    expect(queue.stats).toEqual({ active: 1, pending: 2 });
    expect(started).toEqual(['first']);
    finishFirst?.();
    expect(await Promise.all([first, second, third])).toEqual([1, 2, 3]);
    expect(started).toEqual(['first', 'visible', 'background']);
    expect(queue.stats).toEqual({ active: 0, pending: 0 });
  });

  it('continues after a failed decode', async () => {
    const queue = new PreviewWorkQueue(1);
    const failed = queue.enqueue(async () => { throw new Error('decode failed'); }, 'visible');
    const next = queue.enqueue(async () => 'ok', 'background');
    await expect(failed).rejects.toThrow('decode failed');
    await expect(next).resolves.toBe('ok');
  });

  it('starts the newest waiting thumbnail after visible previews', async () => {
    const queue = new PreviewWorkQueue(1);
    const started: string[] = [];
    let finishFirst: (() => void) | undefined;
    const first = queue.enqueue(async () => {
      started.push('first');
      await new Promise<void>((resolve) => { finishFirst = resolve; });
    }, 'background');
    const old = queue.enqueue(async () => { started.push('old'); }, 'background');
    const recent = queue.enqueue(async () => { started.push('recent'); }, 'background');
    const preview = queue.enqueue(async () => { started.push('preview'); }, 'visible');
    await Promise.resolve();
    finishFirst?.();
    await Promise.all([first, old, recent, preview]);
    expect(started).toEqual(['first', 'preview', 'recent', 'old']);
  });

  it('promotes a waiting thumbnail without starting duplicate work', async () => {
    const queue = new PreviewWorkQueue(1);
    const started: string[] = [];
    let release: (() => void) | undefined;
    const active = queue.enqueue(() => new Promise<void>((resolve) => { release = resolve; }), 'background');
    const older = queue.enqueue(async () => { started.push('older'); }, 'background', 'older');
    const newer = queue.enqueue(async () => { started.push('newer'); }, 'background', 'newer');
    expect(queue.promote('older')).toBe(true);
    expect(queue.promote('older')).toBe(false);
    await Promise.resolve();
    release?.();
    await Promise.all([active, older, newer]);
    expect(started).toEqual(['older', 'newer']);
  });

  it('cancels waiting work without interrupting an active decoder', async () => {
    const queue = new PreviewWorkQueue(1);
    let release: (() => void) | undefined;
    const active = queue.enqueue(() => new Promise<void>((resolve) => { release = resolve; }), 'visible', 'active');
    const started: string[] = [];
    const stale = queue.enqueue(async () => { started.push('stale'); }, 'background', 'stale');
    const canceled = expect(stale).rejects.toThrow('PREVIEW_QUEUE_STALE');
    const latest = queue.enqueue(async () => { started.push('latest'); }, 'visible', 'latest');

    expect(queue.cancel('active')).toBe(false);
    expect(queue.cancel('stale')).toBe(true);
    expect(queue.cancel('stale')).toBe(false);
    expect(queue.stats).toEqual({ active: 1, pending: 1 });
    await canceled;
    release?.();
    await Promise.all([active, latest]);
    expect(started).toEqual(['latest']);
  });

  it('keeps a large backlog bounded by the concurrency limit and drains recent thumbnails first', async () => {
    const queue = new PreviewWorkQueue(1);
    let release: (() => void) | undefined;
    const active = queue.enqueue(() => new Promise<void>((resolve) => { release = resolve; }), 'background');
    const order: number[] = [];
    const waiting = Array.from({ length: 10_000 }, (_, index) =>
      queue.enqueue(async () => { order.push(index); }, 'background'));
    const visible = queue.enqueue(async () => { order.push(-1); }, 'visible');
    expect(queue.stats).toEqual({ active: 1, pending: 10_001 });
    await Promise.resolve();
    release?.();
    await Promise.all([active, visible, ...waiting]);
    expect(order.slice(0, 4)).toEqual([-1, 9_999, 9_998, 9_997]);
    expect(order.at(-1)).toBe(0);
    expect(queue.stats).toEqual({ active: 0, pending: 0 });
  });

  it('drops oldest waiting thumbnails when the background backlog reaches its limit', async () => {
    const queue = new PreviewWorkQueue(1, 2);
    let release: (() => void) | undefined;
    const active = queue.enqueue(() => new Promise<void>((resolve) => { release = resolve; }), 'background');
    const old = queue.enqueue(async () => 'old', 'background');
    const oldResult = expect(old).rejects.toThrow('PREVIEW_QUEUE_STALE');
    const middle = queue.enqueue(async () => 'middle', 'background');
    const recent = queue.enqueue(async () => 'recent', 'background');
    await oldResult;
    expect(queue.stats).toEqual({ active: 1, pending: 2 });
    await Promise.resolve();
    release?.();
    await active;
    await expect(recent).resolves.toBe('recent');
    await expect(middle).resolves.toBe('middle');
  });

  it('drops stale visible work so the latest viewport can decode first', async () => {
    const queue = new PreviewWorkQueue(1, 2, 2);
    let release: (() => void) | undefined;
    const active = queue.enqueue(() => new Promise<void>((resolve) => { release = resolve; }), 'background');
    const old = queue.enqueue(async () => 'old', 'visible');
    const stale = expect(old).rejects.toThrow('PREVIEW_QUEUE_STALE');
    const middle = queue.enqueue(async () => 'middle', 'visible');
    const recent = queue.enqueue(async () => 'recent', 'visible');
    await stale;
    expect(queue.stats).toEqual({ active: 1, pending: 2 });
    await Promise.resolve();
    release?.();
    await active;
    await expect(middle).resolves.toBe('middle');
    await expect(recent).resolves.toBe('recent');
  });

  it('rejects waiting and new work on close, but waits for an active native callback', async () => {
    const queue = new PreviewWorkQueue(1);
    let finish: (() => void) | undefined;
    const active = queue.enqueue(() => new Promise<void>((resolve) => { finish = resolve; }), 'visible');
    let queuedRan = false;
    const waiting = queue.enqueue(async () => { queuedRan = true; }, 'background');
    const rejected = expect(waiting).rejects.toThrow('PREVIEW_QUEUE_CLOSED');
    await Promise.resolve();
    let stopped = false;
    const closing = queue.close().then(() => { stopped = true; });
    await rejected;
    await expect(queue.enqueue(async () => undefined, 'visible')).rejects.toThrow('PREVIEW_QUEUE_CLOSED');
    expect(stopped).toBe(false);
    expect(queuedRan).toBe(false);
    finish?.();
    await Promise.all([active, closing]);
    expect(stopped).toBe(true);
    expect(queue.stats).toEqual({ active: 0, pending: 0 });
    await queue.close();
  });
});
