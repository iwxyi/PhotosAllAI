import { EventEmitter } from 'node:events';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { CatalogWatcher } from './catalog-watcher';

class FakeWatcher extends EventEmitter {
  close = vi.fn();
}

afterEach(() => {
  vi.useRealTimers();
});

describe('catalog watcher', () => {
  it('coalesces bursts but reconciles an event received while a pass is running', async () => {
    vi.useFakeTimers();
    let notify: () => void = () => undefined;
    let finishFirst: () => void = () => undefined;
    const firstPass = new Promise<void>((resolve) => { finishFirst = resolve; });
    const reconcile = vi.fn()
      .mockImplementationOnce(() => firstPass)
      .mockResolvedValue({ discovered: 0, offline: 0 });
    const watcher = new CatalogWatcher(
      { reconcileImportedFolders: reconcile },
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
      { reconcileImportedFolders: vi.fn().mockResolvedValue({ discovered: 0, offline: 0 }) },
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
      { reconcileImportedFolders: reconcile },
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
    expect(watcher.getStats()).toEqual({ watchedFolders: 1, activeWatchers: 1, watchFailures: 2, reconciliationFailures: 0 });
    watcher.stop();
  });

  it('counts reconciliation failures without stopping future passes', async () => {
    vi.useFakeTimers();
    let notify: () => void = () => undefined;
    const reconcile = vi.fn()
      .mockRejectedValueOnce(new Error('temporary'))
      .mockResolvedValue({ discovered: 0, offline: 0 });
    const watcher = new CatalogWatcher(
      { reconcileImportedFolders: reconcile },
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
      { reconcileImportedFolders: reconcile },
      { debounceMs: 5, retryMs: 20, watchFactory: factory }
    );
    watcher.watchFolders(['/offline']);
    watcher.stop();
    await vi.runAllTimersAsync();

    expect(factory).toHaveBeenCalledOnce();
    expect(reconcile).not.toHaveBeenCalled();
  });
});
