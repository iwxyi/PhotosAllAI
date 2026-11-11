import path from 'node:path';
import type { CatalogAsset } from '@photoallisai/contracts';
import { naturalSortKey } from '@photoallisai/domain';

type Entry = { id: string; file?: string; fileName: string; sortKey: string | undefined; sizeBytes: number; modifiedAt: number };

/** Session scoped index. Only requested pages cross into the renderer. */
export class TemporaryMediaIndex {
  #sessionId: string | null = null;
  #entries: Entry[] = [];
  #positions = new Map<string, number>();
  #complete = false;
  #revision = 0;
  #commonDirectory: string | null = null;

  constructor(_databasePath = ':memory:') {}

  begin(sessionId: string): void {
    this.#revision += 1;
    this.#sessionId = sessionId;
    this.#entries = [];
    this.#positions.clear();
    this.#complete = false;
    this.#commonDirectory = null;
  }

  insert(sessionId: string, records: Array<{ id: string; file: string; sizeBytes?: number; modifiedAt?: number }>): void {
    if (sessionId !== this.#sessionId) return;
    if (this.#complete) throw new Error('TEMPORARY_INDEX_COMPLETE');
    for (const record of records) {
      const fileName = path.basename(record.file);
      const directory = path.dirname(record.file);
      this.#commonDirectory ??= directory;
      const entry: Entry = { id: record.id, ...(directory === this.#commonDirectory ? {} : { file: record.file }), fileName, sortKey: naturalSortKey(fileName), sizeBytes: record.sizeBytes ?? 0, modifiedAt: record.modifiedAt ?? 0 };
      this.#positions.set(record.id, this.#entries.length);
      this.#entries.push(entry);
    }
    if (records.length) this.#revision += 1;
    this.#complete = false;
  }

  finish(sessionId: string): void {
    if (sessionId !== this.#sessionId || this.#complete) return;
    this.#entries.sort((left, right) => left.sortKey!.localeCompare(right.sortKey!) || left.id.localeCompare(right.id));
    this.#positions.clear();
    for (let index = 0; index < this.#entries.length; index += 1) {
      const entry = this.#entries[index]!;
      this.#positions.set(entry.id, index);
      entry.sortKey = undefined;
    }
    this.#complete = true;
  }

  /** Sorts in bounded turns so a large directory cannot monopolize the main process. */
  async finishAsync(sessionId: string): Promise<void> {
    if (sessionId !== this.#sessionId || this.#complete) return;
    const revision = this.#revision;
    const current = () => sessionId === this.#sessionId && revision === this.#revision;
    const compare = (left: Entry, right: Entry) => left.sortKey!.localeCompare(right.sortKey!) || left.id.localeCompare(right.id);
    const chunkSize = 8_192;
    let chunks: Entry[][] = [];
    for (let start = 0; start < this.#entries.length; start += chunkSize) {
      chunks.push(this.#entries.slice(start, start + chunkSize).sort(compare));
      if (!current()) return;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    while (chunks.length > 1) {
      const merged: Entry[][] = [];
      for (let index = 0; index < chunks.length; index += 2) {
        const left = chunks[index]!;
        const right = chunks[index + 1];
        if (!right) { merged.push(left); continue; }
        const result: Entry[] = new Array(left.length + right.length);
        let a = 0;
        let b = 0;
        for (let cursor = 0; cursor < result.length; cursor += 1) {
          result[cursor] = b === right.length || (a < left.length && compare(left[a]!, right[b]!) <= 0) ? left[a++]! : right[b++]!;
          if ((cursor & 8_191) === 8_191) {
            if (!current()) return;
            await new Promise<void>((resolve) => setImmediate(resolve));
          }
        }
        merged.push(result);
      }
      chunks = merged;
      if (!current()) return;
    }
    if (!current()) return;
    const sorted = chunks[0] ?? [];
    const positions = new Map<string, number>();
    for (let index = 0; index < sorted.length; index += 1) {
      const entry = sorted[index]!;
      positions.set(entry.id, index);
      if ((index & 8_191) === 8_191) {
        if (!current()) return;
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    }
    if (!current()) return;
    for (const entry of sorted) entry.sortKey = undefined;
    this.#entries = sorted;
    this.#positions = positions;
    this.#complete = true;
  }

  resolve(id: string): string | null {
    const position = this.#positions.get(id);
    const entry = position === undefined ? undefined : this.#entries[position];
    return entry ? entry.file ?? path.join(this.#commonDirectory!, entry.fileName) : null;
  }

  page(sessionId: string, offset: number, limit: number): { items: CatalogAsset[]; totalCount: number } {
    if (sessionId !== this.#sessionId) return { items: [], totalCount: 0 };
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new RangeError('INVALID_TEMPORARY_PAGE');
    return { totalCount: this.#entries.length, items: this.#entries.slice(offset, offset + limit).map((entry) => ({
      id: entry.id, folderId: '', fileName: entry.fileName, format: path.extname(entry.fileName).slice(1).toUpperCase(),
      sizeBytes: entry.sizeBytes, modifiedAt: entry.modifiedAt, rating: 0, labelColor: null,
      flag: 'unflagged', favorite: false, offline: false, tags: [],
      thumbnailUrl: `photoasset://temporary-thumbnail/${entry.id}`, previewUrl: `photoasset://temporary/${entry.id}`
    })) };
  }

  position(sessionId: string, id: string): number | null {
    if (sessionId !== this.#sessionId) return null;
    return this.#positions.get(id) ?? null;
  }

  close(): void { this.#revision += 1; this.#sessionId = null; this.#commonDirectory = null; this.#entries = []; this.#positions.clear(); }
}
