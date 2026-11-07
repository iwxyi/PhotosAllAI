import { watch } from 'node:fs';
import path from 'node:path';

import type { CatalogService } from './catalog-service';

type CatalogReconciler = Pick<CatalogService, 'synchronizeImportedRoot' | 'synchronizeImportedFile' | 'synchronizeImportedDirectory'>;
type WatchHandle = {
  close(): void;
  on(event: 'error', listener: (error: Error) => void): unknown;
};
type WatchFactory = (folder: string, onChange: (eventType?: string, filename?: string | Buffer | null) => void) => WatchHandle;

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
  #refreshCursor = 0;
  readonly #dirtyFolders = new Set<string>();
  readonly #dirtyFiles = new Map<string, Set<string>>();
  readonly #dirtyRenames = new Map<string, Set<string>>();
  #active = false;
  #watchFailures = 0;
  #reconciliationFailures = 0;
  #fullScans = 0;
  #fullScanMsTotal = 0;

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
      this.#dirtyFolders.delete(folder);
      this.#dirtyFiles.delete(folder);
      this.#dirtyRenames.delete(folder);
    }
    this.#folders.clear();
    this.#refreshCursor = 0;
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
    this.#refreshCursor = 0;
    if (this.#debounceTimer) clearTimeout(this.#debounceTimer);
    if (this.#retryTimer) clearTimeout(this.#retryTimer);
    this.#debounceTimer = null;
    this.#retryTimer = null;
    this.#dirtyFolders.clear();
    this.#dirtyFiles.clear();
    this.#dirtyRenames.clear();
  }

  refresh(maxRoots = 2): void {
    if (!this.#active || this.#folders.size === 0 || maxRoots <= 0) return;
    const folders = [...this.#folders];
    const budget = Math.min(Math.floor(maxRoots), folders.length);
    if (this.#dirtyFolders.size >= budget) return;
    for (let checked = 0, added = 0; checked < folders.length && added < budget; checked += 1) {
      const folder = folders[this.#refreshCursor % folders.length]!;
      this.#refreshCursor = (this.#refreshCursor + 1) % folders.length;
      if (this.#dirtyFolders.has(folder)) continue;
      if (this.#dirtyFolders.size >= budget) break;
      this.#dirtyFolders.add(folder);
      added += 1;
    }
    this.#scheduleReconciliation();
  }

  getStats(): { watchedFolders: number; activeWatchers: number; watchFailures: number; reconciliationFailures: number; reconciling: boolean; fullScans: number; fullScanMsTotal: number } {
    return {
      watchedFolders: this.#folders.size,
      activeWatchers: this.#watchers.size,
      watchFailures: this.#watchFailures,
      reconciliationFailures: this.#reconciliationFailures,
      reconciling: this.#running,
      fullScans: this.#fullScans,
      fullScanMsTotal: Math.round(this.#fullScanMsTotal)
    };
  }

  #attach(folder: string): boolean {
    if (this.#watchers.has(folder) || !this.#folders.has(folder)) return false;
    try {
      const watcher = this.#watchFactory(folder, (eventType, filename) => this.#scheduleWatchEvent(folder, eventType, filename));
      this.#watchers.set(folder, watcher);
      watcher.on('error', () => {
        if (this.#watchers.get(folder) !== watcher) return;
        this.#watchFailures += 1;
        watcher.close();
        this.#watchers.delete(folder);
        this.#scheduleReconciliation(folder);
        this.#scheduleRetry();
      });
      return true;
    } catch {
      this.#watchFailures += 1;
      return false;
    }
  }

  #scheduleReconciliation(folder?: string): void {
    if (!this.#active) return;
    if (folder && this.#folders.has(folder)) { this.#dirtyFolders.add(folder); this.#dirtyFiles.delete(folder); this.#dirtyRenames.delete(folder); }
    if (this.#dirtyFolders.size === 0 && this.#dirtyFiles.size === 0 && this.#dirtyRenames.size === 0) return;
    if (this.#running) return;
    if (this.#debounceTimer) clearTimeout(this.#debounceTimer);
    this.#debounceTimer = setTimeout(() => {
      this.#debounceTimer = null;
      void this.#reconcileUntilCurrent();
    }, this.#debounceMs);
  }

  #scheduleWatchEvent(folder: string, eventType?: string, filename?: string | Buffer | null): void {
    if (!this.#active || !this.#folders.has(folder)) return;
    const relative = typeof filename === 'string' ? filename : Buffer.isBuffer(filename) ? filename.toString('utf8') : '';
    if (!relative || relative.includes('\0') || path.isAbsolute(relative) || relative.split(/[\\/]/u).some((part) => part === '..' || part === '.')) {
      this.#scheduleReconciliation(folder);
      return;
    }
    if (this.#dirtyFolders.has(folder)) return;
    if (eventType === 'rename') {
      const renamed = this.#dirtyRenames.get(folder) ?? new Set<string>();
      renamed.add(relative);
      if (renamed.size > 128) { this.#scheduleReconciliation(folder); return; }
      this.#dirtyRenames.set(folder, renamed);
      this.#scheduleReconciliation();
      return;
    }
    if (eventType !== 'change') { this.#scheduleReconciliation(folder); return; }
    const files = this.#dirtyFiles.get(folder) ?? new Set<string>();
    files.add(relative);
    if (files.size > 128) { this.#scheduleReconciliation(folder); return; }
    this.#dirtyFiles.set(folder, files);
    this.#scheduleReconciliation();
  }

  async #reconcileUntilCurrent(): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    try {
      while (this.#active && (this.#dirtyFolders.size > 0 || this.#dirtyRenames.size > 0 || this.#dirtyFiles.size > 0)) {
        const folder = this.#dirtyFolders.size > 0 ? this.#dirtyFolders.values().next().value! : this.#dirtyRenames.size > 0 ? this.#dirtyRenames.keys().next().value! : this.#dirtyFiles.keys().next().value!;
        const fullScan = this.#dirtyFolders.delete(folder);
        const files = this.#dirtyFiles.get(folder);
        const renames = this.#dirtyRenames.get(folder);
        this.#dirtyFiles.delete(folder);
        this.#dirtyRenames.delete(folder);
        if (!this.#folders.has(folder)) continue;
        const scanStartedAt = fullScan ? performance.now() : 0;
        const work = fullScan ? this.#catalog.synchronizeImportedRoot(folder) : renames?.size
          ? (async () => {
            for (const relative of renames) {
              if (!await this.#catalog.synchronizeImportedDirectory(folder, relative)) {
                await this.#catalog.synchronizeImportedRoot(folder);
                return;
              }
            }
            await Promise.all([...(files ?? [])].map((file) => this.#catalog.synchronizeImportedFile(folder, file)));
          })()
          : Promise.all([...(files ?? [])].map((file) => this.#catalog.synchronizeImportedFile(folder, file)));
        await work.then(() => this.#onChanged()).catch(() => {
          this.#reconciliationFailures += 1;
        }).finally(() => {
          if (fullScan) {
            this.#fullScans += 1;
            this.#fullScanMsTotal += performance.now() - scanStartedAt;
          }
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
      for (const folder of this.#folders) if (this.#attach(folder)) this.#scheduleReconciliation(folder);
      this.#scheduleRetry();
    }, this.#retryMs);
    this.#retryTimer.unref();
  }
}
