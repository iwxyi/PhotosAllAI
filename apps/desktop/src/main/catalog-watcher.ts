import { watch } from 'node:fs';
import path from 'node:path';

import type { CatalogService } from './catalog-service';

type CatalogReconciler = Pick<CatalogService, 'synchronizeImportedRoot' | 'synchronizeImportedFile' | 'synchronizeImportedDirectory'> & Partial<Pick<CatalogService, 'synchronizeFolder'>>;
type WatchHandle = {
  close(): void;
  on(event: 'error', listener: (error: Error) => void): unknown;
};
type WatchFactory = (folder: string, onChange: (eventType?: string, filename?: string | Buffer | null) => void) => WatchHandle;

const defaultWatchFactory: WatchFactory = (folder, onChange) =>
  watch(folder, { recursive: true }, onChange);
const SCAN_COOLDOWN_MS = 30_000;

export class CatalogWatcher {
  readonly #catalog: CatalogReconciler;
  readonly #watchFactory: WatchFactory;
  readonly #debounceMs: number;
  readonly #retryMs: number;
  readonly #onChanged: () => void | Promise<void>;
  readonly #enabled: boolean;
  readonly #onFullScanStart: ((folder: string) => void) | undefined;
  readonly #onFullScanEnd: ((folder: string, error?: unknown) => void) | undefined;
  readonly #watchers = new Map<string, WatchHandle>();
  readonly #folders = new Set<string>();
  #debounceTimer: NodeJS.Timeout | null = null;
  #retryTimer: NodeJS.Timeout | null = null;
  #running = false;
  #refreshCursor = 0;
  readonly #dirtyFolders = new Set<string>();
  readonly #dirtyFiles = new Map<string, Set<string>>();
  readonly #dirtyRenames = new Map<string, Set<string>>();
  readonly #unselectedChanges = new Map<string, Map<string, string>>();
  readonly #pendingScopes = new Map<string, { root: string; dueAt: number }>();
  readonly #lastScopeScans = new Map<string, number>();
  #activeScopes: Map<string, Array<{ id: string; path: string }>> | null = null;
  #active = false;
  #watchFailures = 0;
  #reconciliationFailures = 0;
  #fullScans = 0;
  #fullScanMsTotal = 0;

  constructor(
    catalog: CatalogReconciler,
    options: { enabled?: boolean; watchFactory?: WatchFactory; debounceMs?: number; retryMs?: number; onChanged?: () => void | Promise<void>; onFullScanStart?: (folder: string) => void; onFullScanEnd?: (folder: string, error?: unknown) => void } = {}
  ) {
    this.#catalog = catalog;
    this.#enabled = options.enabled ?? true;
    this.#watchFactory = options.watchFactory ?? defaultWatchFactory;
    this.#debounceMs = options.debounceMs ?? 750;
    this.#retryMs = options.retryMs ?? 30_000;
    this.#onChanged = options.onChanged ?? (() => undefined);
    this.#onFullScanStart = options.onFullScanStart;
    this.#onFullScanEnd = options.onFullScanEnd;
  }

  watchFolders(folders: readonly string[]): void {
    if (!this.#enabled) return;
    this.#active = true;
    const nextFolders = new Set(folders);
    for (const [folder, watcher] of this.#watchers) {
      if (nextFolders.has(folder)) continue;
      watcher.close();
      this.#watchers.delete(folder);
      this.#dirtyFolders.delete(folder);
      this.#dirtyFiles.delete(folder);
      this.#dirtyRenames.delete(folder);
      this.#unselectedChanges.delete(folder);
      for (const [id, pending] of this.#pendingScopes) if (pending.root === folder) this.#pendingScopes.delete(id);
    }
    this.#folders.clear();
    this.#refreshCursor = 0;
    for (const folder of nextFolders) {
      this.#folders.add(folder);
      this.#attach(folder);
    }
    this.#scheduleRetry();
  }

  setActiveFolders(folders: readonly { id: string; path: string; rootPath: string }[]): void {
    const next = new Map<string, Array<{ id: string; path: string }>>();
    for (const item of folders) next.set(item.rootPath, [...(next.get(item.rootPath) ?? []), { id: item.id, path: item.path }]);
    this.#activeScopes = next;
    for (const root of this.#dirtyFolders) if (!next.has(root)) this.#dirtyFolders.delete(root);
    for (const root of this.#dirtyFiles.keys()) if (!next.has(root)) this.#dirtyFiles.delete(root);
    for (const root of this.#dirtyRenames.keys()) if (!next.has(root)) this.#dirtyRenames.delete(root);
    for (const [id, pending] of this.#pendingScopes) {
      if (!next.get(pending.root)?.some((scope) => scope.id === id)) this.#pendingScopes.delete(id);
    }
    for (const [root, changes] of this.#unselectedChanges) {
      if (!next.has(root)) continue;
      for (const [relative, eventType] of changes) {
        if (!this.#matchesActiveScope(root, relative)) continue;
        changes.delete(relative);
        this.#scheduleWatchEvent(root, eventType, relative);
      }
      if (!changes.size) this.#unselectedChanges.delete(root);
    }
    if (this.#dirtyFolders.size || this.#dirtyFiles.size || this.#dirtyRenames.size || this.#pendingScopes.size) this.#scheduleReconciliation();
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
    this.#unselectedChanges.clear();
    this.#pendingScopes.clear();
    this.#lastScopeScans.clear();
  }

  refresh(maxRoots = 2): void {
    if (this.#activeScopes) {
      return;
    }
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
    if (folder && this.#activeScopes && !this.#activeScopes.has(folder)) return;
    if (folder && this.#folders.has(folder)) {
      if (this.#activeScopes) {
        for (const scope of this.#activeScopes.get(folder) ?? []) this.#queueScope(folder, scope.id, true);
      } else this.#dirtyFolders.add(folder);
      this.#dirtyFiles.delete(folder);
      this.#dirtyRenames.delete(folder);
    }
    if (this.#dirtyFolders.size === 0 && this.#dirtyFiles.size === 0 && this.#dirtyRenames.size === 0 && this.#pendingScopes.size === 0) return;
    if (this.#running) return;
    if (this.#debounceTimer) clearTimeout(this.#debounceTimer);
    const nextDue = this.#pendingScopes.size ? Math.min(...[...this.#pendingScopes.values()].map((pending) => pending.dueAt)) : Infinity;
    const delay = this.#dirtyFolders.size || this.#dirtyFiles.size || this.#dirtyRenames.size
      ? this.#debounceMs : Math.max(this.#debounceMs, nextDue - Date.now());
    this.#debounceTimer = setTimeout(() => {
      this.#debounceTimer = null;
      void this.#reconcileUntilCurrent();
    }, delay);
  }

  #queueScope(root: string, id: string, changed: boolean): void {
    const last = this.#lastScopeScans.get(id);
    if (!changed && last !== undefined && Date.now() - last < SCAN_COOLDOWN_MS) return;
    const dueAt = Math.max(Date.now(), (last ?? -Infinity) + SCAN_COOLDOWN_MS);
    const pending = this.#pendingScopes.get(id);
    if (!pending || dueAt < pending.dueAt) this.#pendingScopes.set(id, { root, dueAt });
  }

  #scheduleWatchEvent(folder: string, eventType?: string, filename?: string | Buffer | null): void {
    if (!this.#active || !this.#folders.has(folder)) return;
    const relative = typeof filename === 'string' ? filename : Buffer.isBuffer(filename) ? filename.toString('utf8') : '';
    const scope = this.#activeScopes?.get(folder);
    if (this.#activeScopes && (!scope || (relative && !this.#matchesActiveScope(folder, relative)))) {
      if (relative && !relative.includes('\0') && !path.isAbsolute(relative)
        && !relative.split(/[\\/]/u).some((part) => part === '..' || part === '.')) {
        const changes = this.#unselectedChanges.get(folder) ?? new Map<string, string>();
        if (changes.size < 128) changes.set(relative, eventType ?? 'unknown');
        this.#unselectedChanges.set(folder, changes);
      }
      return;
    }
    if (scope && relative) {
      const changedPath = path.resolve(folder, relative);
      if (scope.some((item) => item.path.startsWith(changedPath + path.sep))) {
        this.#scheduleReconciliation(folder);
        return;
      }
    }
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

  #matchesActiveScope(root: string, relative: string): boolean {
    const changedPath = path.resolve(root, relative);
    return this.#activeScopes?.get(root)?.some((item) => changedPath === item.path
      || changedPath.startsWith(item.path + path.sep) || item.path.startsWith(changedPath + path.sep)) ?? false;
  }

  async #reconcileUntilCurrent(): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    try {
      while (this.#active && (this.#dirtyFolders.size > 0 || this.#dirtyRenames.size > 0 || this.#dirtyFiles.size > 0 || [...this.#pendingScopes.values()].some((pending) => pending.dueAt <= Date.now()))) {
        if (this.#activeScopes && this.#pendingScopes.size > 0 && this.#dirtyFolders.size === 0 && this.#dirtyRenames.size === 0 && this.#dirtyFiles.size === 0) {
          const ready = [...this.#pendingScopes].find(([, pending]) => pending.dueAt <= Date.now());
          if (!ready) break;
          const [id, pending] = ready;
          this.#pendingScopes.delete(id);
          if (!this.#folders.has(pending.root) || !this.#activeScopes.get(pending.root)?.some((scope) => scope.id === id)) continue;
          const startedAt = performance.now();
          this.#lastScopeScans.set(id, Date.now());
          this.#onFullScanStart?.(pending.root);
          try {
            await this.#catalog.synchronizeFolder?.(id);
            await this.#onChanged();
            this.#onFullScanEnd?.(pending.root);
          } catch (error) {
            this.#reconciliationFailures += 1;
            this.#onFullScanEnd?.(pending.root, error);
          } finally {
            this.#fullScans += 1;
            this.#fullScanMsTotal += performance.now() - startedAt;
          }
          continue;
        }
        const folder = this.#dirtyFolders.size > 0 ? this.#dirtyFolders.values().next().value! : this.#dirtyRenames.size > 0 ? this.#dirtyRenames.keys().next().value! : this.#dirtyFiles.keys().next().value!;
        const fullScan = this.#dirtyFolders.delete(folder);
        const files = this.#dirtyFiles.get(folder);
        const renames = this.#dirtyRenames.get(folder);
        this.#dirtyFiles.delete(folder);
        this.#dirtyRenames.delete(folder);
        if (!this.#folders.has(folder)) continue;
        const scanStartedAt = fullScan ? performance.now() : 0;
        if (fullScan) this.#onFullScanStart?.(folder);
        const scope = this.#activeScopes?.get(folder);
        if (this.#activeScopes && !scope) continue;
        const scan = async () => {
          if (scope && this.#catalog.synchronizeFolder) {
            for (const item of scope) this.#queueScope(folder, item.id, true);
          } else await this.#catalog.synchronizeImportedRoot(folder);
        };
        const work = fullScan ? scan() : renames?.size
          ? (async () => {
            for (const relative of renames) {
              if (!await this.#catalog.synchronizeImportedDirectory(folder, relative)) {
                await scan();
                return;
              }
            }
            await Promise.all([...(files ?? [])].map((file) => this.#catalog.synchronizeImportedFile(folder, file)));
          })()
          : Promise.all([...(files ?? [])].map((file) => this.#catalog.synchronizeImportedFile(folder, file)));
        await work.then(async () => { if (fullScan) this.#onFullScanEnd?.(folder); await this.#onChanged(); }).catch((error: unknown) => {
          if (fullScan) this.#onFullScanEnd?.(folder, error);
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
      if (this.#active) this.#scheduleReconciliation();
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
