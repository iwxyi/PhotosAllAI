import { watch, type FSWatcher } from 'node:fs';

import type { CatalogService } from './catalog-service';

export class CatalogWatcher {
  readonly #catalog: CatalogService;
  readonly #watchers = new Map<string, FSWatcher>();
  #timer: NodeJS.Timeout | null = null;
  #running = false;

  constructor(catalog: CatalogService) {
    this.#catalog = catalog;
  }

  watchFolders(folders: readonly string[]): void {
    this.stop();
    for (const folder of folders) {
      try {
        const watcher = watch(folder, { recursive: true }, () => this.#schedule());
        this.#watchers.set(folder, watcher);
      } catch {
        // A removed or inaccessible folder is represented as offline in the next reconciliation.
      }
    }
  }

  stop(): void {
    for (const watcher of this.#watchers.values()) watcher.close();
    this.#watchers.clear();
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
  }

  #schedule(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.#timer = null;
      if (this.#running) return;
      this.#running = true;
      void this.#catalog.reconcileImportedFolders().finally(() => { this.#running = false; });
    }, 750);
  }
}
