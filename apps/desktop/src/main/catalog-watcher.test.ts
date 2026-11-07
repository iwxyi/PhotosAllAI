import { EventEmitter } from 'node:events';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { CatalogWatcher } from './catalog-watcher';

class FakeWatcher extends EventEmitter {
  close = vi.fn();
}
const synchronizeImportedFile = vi.fn().mockResolvedValue(undefined);
const synchronizeImportedDirectory = vi.fn().mockResolvedValue(true);

afterEach(() => {
  vi.useRealTimers();
});

describe('catalog watcher', () => {
  it('updates changed files without scanning roots and escalates rename events', async () => {
    vi.useFakeTimers();
    let notify: (eventType?: string, filename?: string | Buffer | null) => void = () => undefined;
    const synchronizeImportedRoot = vi.fn().mockResolvedValue({ discovered: 0, offline: 0 });
    const synchronizeImportedFile = vi.fn().mockResolvedValue(undefined);
    const watcher = new CatalogWatcher(
      { synchronizeImportedRoot, synchronizeImportedFile, synchronizeImportedDirectory },
      { debounceMs: 10, watchFactory: (_folder, onChange) => { notify = onChange; return new FakeWatcher(); } }
    );
    watcher.watchFolders(['/photos']);
    notify('change', 'events/one.jpg');
    notify('change', 'events/one.jpg');
    notify('change', 'events/two.jpg');
    await vi.advanceTimersByTimeAsync(10);
    expect(synchronizeImportedFile.mock.calls).toEqual([['/photos', 'events/one.jpg'], ['/photos', 'events/two.jpg']]);
    expect(synchronizeImportedRoot).not.toHaveBeenCalled();
    notify('rename', 'events/one.jpg');
    await vi.advanceTimersByTimeAsync(10);
    expect(synchronizeImportedDirectory).toHaveBeenCalledWith('/photos', 'events/one.jpg');
    expect(synchronizeImportedRoot).not.toHaveBeenCalled();
    watcher.stop();
  });

  it('falls back to the root after a directory rename cannot be reconciled locally', async () => {
    vi.useFakeTimers();
    let notify: (eventType?: string, filename?: string | Buffer | null) => void = () => undefined;
    const synchronizeImportedRoot = vi.fn().mockResolvedValue({ discovered: 0, offline: 0 });
    const localDirectory = vi.fn().mockResolvedValue(false);
    const watcher = new CatalogWatcher(
      { synchronizeImportedRoot, synchronizeImportedFile, synchronizeImportedDirectory: localDirectory },
      { debounceMs: 10, watchFactory: (_folder, onChange) => { notify = onChange; return new FakeWatcher(); } }
    );
    watcher.watchFolders(['/photos']);
    notify('rename', 'moved');
    await vi.advanceTimersByTimeAsync(10);
    expect(localDirectory).toHaveBeenCalledWith('/photos', 'moved');
    expect(synchronizeImportedRoot).toHaveBeenCalledExactlyOnceWith('/photos');
    watcher.stop();
  });

  it('reconciles only changed roots and merges repeated events per root', async () => {
    vi.useFakeTimers();
    const notify = new Map<string, () => void>();
    const synchronizeImportedRoot = vi.fn().mockResolvedValue({ discovered: 0, offline: 0 });
    const watcher = new CatalogWatcher(
      { synchronizeImportedRoot, synchronizeImportedFile, synchronizeImportedDirectory },
      { debounceMs: 10, watchFactory: (folder, onChange) => { notify.set(folder, onChange); return new FakeWatcher(); } }
    );
    watcher.watchFolders(['/one', '/two']);
    notify.get('/two')!();
    notify.get('/two')!();
    await vi.advanceTimersByTimeAsync(10);
    expect(synchronizeImportedRoot).toHaveBeenCalledOnce();
    expect(synchronizeImportedRoot).toHaveBeenCalledWith('/two');
    watcher.refresh(2);
    await vi.advanceTimersByTimeAsync(10);
    expect(synchronizeImportedRoot.mock.calls.slice(1).map(([folder]) => folder)).toEqual(['/one', '/two']);
    watcher.stop();
  });

  it('rotates bounded refresh work across many roots without enqueuing the whole library', async () => {
    vi.useFakeTimers();
    const reconcile = vi.fn().mockResolvedValue({ discovered: 0, offline: 0 });
    const watcher = new CatalogWatcher(
      { synchronizeImportedRoot: reconcile, synchronizeImportedFile, synchronizeImportedDirectory },
      { debounceMs: 10, watchFactory: () => new FakeWatcher() }
    );
    watcher.watchFolders(['/one', '/two', '/three', '/four', '/five']);
    watcher.refresh();
    await vi.advanceTimersByTimeAsync(10);
    expect(reconcile.mock.calls.map(([folder]) => folder)).toEqual(['/one', '/two']);
    watcher.refresh();
    await vi.advanceTimersByTimeAsync(10);
    expect(reconcile.mock.calls.map(([folder]) => folder)).toEqual(['/one', '/two', '/three', '/four']);
    watcher.refresh();
    await vi.advanceTimersByTimeAsync(10);
    expect(reconcile.mock.calls.map(([folder]) => folder)).toEqual(['/one', '/two', '/three', '/four', '/five', '/one']);
    watcher.stop();
  });

  it('does not accumulate whole-root scans while a slow root is still running', async () => {
    vi.useFakeTimers();
    let finish: () => void = () => undefined;
    const slow = new Promise<void>((resolve) => { finish = resolve; });
    const reconcile = vi.fn().mockImplementationOnce(() => slow).mockResolvedValue({ discovered: 0, offline: 0 });
    const watcher = new CatalogWatcher(
      { synchronizeImportedRoot: reconcile, synchronizeImportedFile, synchronizeImportedDirectory },
      { debounceMs: 10, watchFactory: () => new FakeWatcher() }
    );
    watcher.watchFolders(['/one', '/two', '/three', '/four', '/five']);
    watcher.refresh();
    await vi.advanceTimersByTimeAsync(10);
    for (let index = 0; index < 20; index += 1) watcher.refresh();
    finish();
    await vi.runAllTimersAsync();
    expect(reconcile.mock.calls.map(([folder]) => folder)).toEqual(['/one', '/two', '/three']);
    watcher.stop();
  });

  it('drops pending work for a root removed before reconciliation', async () => {
    vi.useFakeTimers();
    const notify = new Map<string, () => void>();
    const synchronizeImportedRoot = vi.fn().mockResolvedValue({ discovered: 0, offline: 0 });
    const watcher = new CatalogWatcher(
      { synchronizeImportedRoot, synchronizeImportedFile, synchronizeImportedDirectory },
      { debounceMs: 10, watchFactory: (folder, onChange) => { notify.set(folder, onChange); return new FakeWatcher(); } }
    );
    watcher.watchFolders(['/one', '/two']);
    notify.get('/one')!();
    watcher.watchFolders(['/two']);
    await vi.advanceTimersByTimeAsync(10);
    expect(synchronizeImportedRoot).not.toHaveBeenCalled();
    watcher.stop();
  });

  it('coalesces bursts but reconciles an event received while a pass is running', async () => {
    vi.useFakeTimers();
    let notify: () => void = () => undefined;
    let finishFirst: () => void = () => undefined;
    const firstPass = new Promise<void>((resolve) => { finishFirst = resolve; });
    const reconcile = vi.fn()
      .mockImplementationOnce(() => firstPass)
      .mockResolvedValue({ discovered: 0, offline: 0 });
    const watcher = new CatalogWatcher(
      { synchronizeImportedRoot: reconcile, synchronizeImportedFile, synchronizeImportedDirectory },
      { debounceMs: 10, watchFactory: (_folder, onChange) => { notify = onChange; return new FakeWatcher(); } }
    );
    watcher.watchFolders(['/photos']);

    notify();
    notify();
    await vi.advanceTimersByTimeAsync(10);
    expect(reconcile).toHaveBeenCalledTimes(1);
    notify();
    finishFirst();
    await vi.runAllTimersAsync();

    expect(reconcile).toHaveBeenCalledTimes(2);
    watcher.stop();
  });

  it('keeps unchanged watchers and closes only removed folders', () => {
    const handles = new Map<string, FakeWatcher>();
    const factory = vi.fn((folder: string) => {
      const handle = new FakeWatcher();
      handles.set(folder, handle);
      return handle;
    });
    const watcher = new CatalogWatcher(
      { synchronizeImportedRoot: vi.fn().mockResolvedValue({ discovered: 0, offline: 0 }), synchronizeImportedFile, synchronizeImportedDirectory },
      { watchFactory: factory }
    );
    watcher.watchFolders(['/one', '/two']);
    watcher.watchFolders(['/two', '/three']);

    expect(factory).toHaveBeenCalledTimes(3);
    expect(handles.get('/one')?.close).toHaveBeenCalledOnce();
    expect(handles.get('/two')?.close).not.toHaveBeenCalled();
    watcher.stop();
    expect(handles.get('/two')?.close).toHaveBeenCalledOnce();
    expect(handles.get('/three')?.close).toHaveBeenCalledOnce();
  });

  it('handles watcher errors and reconnects an unavailable folder', async () => {
    vi.useFakeTimers();
    const handles: FakeWatcher[] = [];
    let attempts = 0;
    const factory = vi.fn((_folder: string, _onChange: () => void) => {
      attempts += 1;
      if (attempts === 1) throw new Error('offline');
      const handle = new FakeWatcher();
      handles.push(handle);
      return handle;
    });
    const reconcile = vi.fn().mockResolvedValue({ discovered: 0, offline: 0 });
    const watcher = new CatalogWatcher(
      { synchronizeImportedRoot: reconcile, synchronizeImportedFile, synchronizeImportedDirectory },
      { debounceMs: 5, retryMs: 20, watchFactory: factory }
    );
    watcher.watchFolders(['/removable']);

    await vi.advanceTimersByTimeAsync(25);
    expect(factory).toHaveBeenCalledTimes(2);
    expect(reconcile).toHaveBeenCalledOnce();

    handles[0]!.emit('error', new Error('disconnected'));
    await vi.advanceTimersByTimeAsync(25);
    expect(handles[0]!.close).toHaveBeenCalledOnce();
    expect(factory).toHaveBeenCalledTimes(3);
    expect(reconcile).toHaveBeenCalledTimes(3);
    expect(watcher.getStats()).toMatchObject({ watchedFolders: 1, activeWatchers: 1, watchFailures: 2, reconciliationFailures: 0, reconciling: false });
    watcher.stop();
  });

  it('counts reconciliation failures without stopping future passes', async () => {
    vi.useFakeTimers();
    let notify: () => void = () => undefined;
    const reconcile = vi.fn()
      .mockRejectedValueOnce(new Error('temporary'))
      .mockResolvedValue({ discovered: 0, offline: 0 });
    const watcher = new CatalogWatcher(
      { synchronizeImportedRoot: reconcile, synchronizeImportedFile, synchronizeImportedDirectory },
      { debounceMs: 5, watchFactory: (_folder, onChange) => { notify = onChange; return new FakeWatcher(); } }
    );
    watcher.watchFolders(['/photos']);
    notify();
    await vi.advanceTimersByTimeAsync(5);
    notify();
    await vi.advanceTimersByTimeAsync(5);

    expect(reconcile).toHaveBeenCalledTimes(2);
    expect(watcher.getStats().reconciliationFailures).toBe(1);
    watcher.stop();
  });

  it('stops pending retries and reconciliations', async () => {
    vi.useFakeTimers();
    const reconcile = vi.fn().mockResolvedValue({ discovered: 0, offline: 0 });
    const factory = vi.fn(() => { throw new Error('offline'); });
    const watcher = new CatalogWatcher(
      { synchronizeImportedRoot: reconcile, synchronizeImportedFile, synchronizeImportedDirectory },
      { debounceMs: 5, retryMs: 20, watchFactory: factory }
    );
    watcher.watchFolders(['/offline']);
    watcher.stop();
    await vi.runAllTimersAsync();

    expect(factory).toHaveBeenCalledOnce();
    expect(reconcile).not.toHaveBeenCalled();
  });
});
