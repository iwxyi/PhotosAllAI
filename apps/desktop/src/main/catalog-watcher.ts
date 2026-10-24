import { watch } from 'node:fs';

import type { CatalogService } from './catalog-service';

type CatalogReconciler = Pick<CatalogService, 'reconcileImportedFolders'>;
type WatchHandle = {
  close(): void;
  on(event: 'error', listener: (error: Error) => void): unknown;
};
type WatchFactory = (folder: string, onChange: () => void) => WatchHandle;

const defaultWatchFactory: WatchFactory = (folder, onChange) =>
  watch(folder, { recursive: true }, onChange);

export class CatalogWatcher {
  readonly #catalog: CatalogReconciler;
  readonly #watchFactory: WatchFactory;
  readonly #debounceMs: number;
  readonly #retryMs: number;
  readonly #onChanged: () => void;
  readonly #watchers = new Map<string, WatchHandle>();
  readonly #folders = new Set<string>();
  #debounceTimer: NodeJS.Timeout | null = null;
  #retryTimer: NodeJS.Timeout | null = null;
  #running = false;
  #dirty = false;
  #active = false;
  #watchFailures = 0;
  #reconciliationFailures = 0;

  constructor(
    catalog: CatalogReconciler,
    options: { watchFactory?: WatchFactory; debounceMs?: number; retryMs?: number; onChanged?: () => void } = {}
  ) {
    this.#catalog = catalog;
    this.#watchFactory = options.watchFactory ?? defaultWatchFactory;
    this.#debounceMs = options.debounceMs ?? 750;
    this.#retryMs = options.retryMs ?? 30_000;
    this.#onChanged = options.onChanged ?? (() => undefined);
  }

  watchFolders(folders: readonly string[]): void {
    this.#active = true;
    const nextFolders = new Set(folders);
    for (const [folder, watcher] of this.#watchers) {
      if (nextFolders.has(folder)) continue;
      watcher.close();
      this.#watchers.delete(folder);
    }
    this.#folders.clear();
    for (const folder of nextFolders) {
      this.#folders.add(folder);
      this.#attach(folder);
    }
    this.#scheduleRetry();
  }

  stop(): void {
    this.#active = false;
    for (const watcher of this.#watchers.values()) watcher.close();
    this.#watchers.clear();
    this.#folders.clear();
    if (this.#debounceTimer) clearTimeout(this.#debounceTimer);
    if (this.#retryTimer) clearTimeout(this.#retryTimer);
    this.#debounceTimer = null;
    this.#retryTimer = null;
    this.#dirty = false;
  }

  refresh(): void {
    this.#scheduleReconciliation();
  }

  getStats(): { watchedFolders: number; activeWatchers: number; watchFailures: number; reconciliationFailures: number } {
    return {
      watchedFolders: this.#folders.size,
      activeWatchers: this.#watchers.size,
      watchFailures: this.#watchFailures,
      reconciliationFailures: this.#reconciliationFailures
    };
  }

  #attach(folder: string): boolean {
    if (this.#watchers.has(folder) || !this.#folders.has(folder)) return false;
    try {
      const watcher = this.#watchFactory(folder, () => this.#scheduleReconciliation());
      this.#watchers.set(folder, watcher);
      watcher.on('error', () => {
        if (this.#watchers.get(folder) !== watcher) return;
        this.#watchFailures += 1;
        watcher.close();
        this.#watchers.delete(folder);
        this.#scheduleReconciliation();
        this.#scheduleRetry();
      });
      return true;
    } catch {
      this.#watchFailures += 1;
      return false;
    }
  }

  #scheduleReconciliation(): void {
    if (!this.#active) return;
    this.#dirty = true;
    if (this.#running) return;
    if (this.#debounceTimer) clearTimeout(this.#debounceTimer);
    this.#debounceTimer = setTimeout(() => {
      this.#debounceTimer = null;
      void this.#reconcileUntilCurrent();
    }, this.#debounceMs);
  }

  async #reconcileUntilCurrent(): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    try {
      while (this.#dirty) {
        this.#dirty = false;
        await this.#catalog.reconcileImportedFolders().then(() => this.#onChanged()).catch(() => {
          this.#reconciliationFailures += 1;
        });
      }
    } finally {
      this.#running = false;
    }
  }

  #scheduleRetry(): void {
    const retryNeeded = this.#active && [...this.#folders].some((folder) => !this.#watchers.has(folder));
    if (!retryNeeded) {
      if (this.#retryTimer) clearTimeout(this.#retryTimer);
      this.#retryTimer = null;
      return;
    }
    if (this.#retryTimer) return;
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = null;
      let attached = false;
      for (const folder of this.#folders) attached = this.#attach(folder) || attached;
      if (attached) this.#scheduleReconciliation();
      this.#scheduleRetry();
    }, this.#retryMs);
    this.#retryTimer.unref();
  }
}
