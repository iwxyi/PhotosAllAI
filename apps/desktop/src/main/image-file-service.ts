import { randomUUID } from 'node:crypto';
import { readdir, opendir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import exifr from 'exifr';
import { imageSizeFromFile } from 'image-size/fromFile';
import type { CatalogAsset, FileDetails, QuickViewSession } from '@photoallisai/contracts';
import type { CatalogService } from './catalog-service';
import { isSupportedBrowseMedia } from './media-format-registry';
import type { TemporaryMediaIndex } from './temporary-media-index';

export { isDirectPreviewImage } from './media-format-registry';

// Temporary IDs grant access only to files explicitly opened or their directory siblings.
export class ImageFileService {
  readonly #temporary = new Map<string, string>();
  readonly #detailsCache = new Map<string, { sizeBytes: number; modifiedAt: number; details: FileDetails }>();
  #openGeneration = 0;
  constructor(private readonly catalog: Pick<CatalogService, 'resolveAssetFile'>, private readonly temporaryIndex?: TemporaryMediaIndex) {}

  resolve(id: string): string | null {
    return this.temporaryIndex?.resolve(id) ?? this.#temporary.get(id) ?? this.catalog.resolveAssetFile(id)?.path ?? null;
  }

  pageTemporary(sessionId: string, offset: number, limit: number, selectedId?: string): { items: CatalogAsset[]; totalCount: number; selectedPosition?: number | null } {
    if (!this.temporaryIndex) throw new Error('TEMPORARY_INDEX_UNAVAILABLE');
    return { ...this.temporaryIndex.page(sessionId, offset, limit), ...(selectedId ? { selectedPosition: this.temporaryIndex.position(sessionId, selectedId) } : {}) };
  }

  async open(paths: string[], onProgress?: (session: QuickViewSession) => void): Promise<QuickViewSession> {
    if (!paths.length) throw new Error('请选择图片文件');
    const selectedPath = await realpath(paths[0]!);
    const selectedStat = await stat(selectedPath);
    const directory = selectedStat.isDirectory() ? selectedPath : path.dirname(selectedPath);
    if (!selectedStat.isDirectory() && !isSupportedBrowseMedia(selectedPath)) throw new Error('不支持的图片格式');
    const explicit = paths.length > 1;
    if (selectedStat.isDirectory() && onProgress) {
      const handle = await opendir(directory);
      let first: string | null = null;
      try {
        let entry;
        while ((entry = await handle.read())) {
          if (entry.isFile() && isSupportedBrowseMedia(entry.name)) {
            first = path.join(directory, entry.name);
            break;
          }
        }
        if (!first) throw new Error('所选位置没有可查看的图片');
      } catch (error) {
        await handle.close().catch(() => undefined);
        throw error;
      }
      const sessionId = randomUUID();
      const generation = ++this.#openGeneration;
      const id = randomUUID();
      this.#temporary.clear();
      if (!this.temporaryIndex) this.#temporary.set(id, first);
      this.temporaryIndex?.begin(sessionId);
      this.temporaryIndex?.insert(sessionId, [{ id, file: first }]);
      setImmediate(() => { void this.#discoverEntries(handle, directory, first, id, sessionId, generation, onProgress); });
      return { items: [this.#temporaryAsset(id, first)], selectedId: id, directory, sessionId, complete: false, ...(this.temporaryIndex ? { indexed: true, totalCount: 1 } : {}) };
    }
    if (!explicit && selectedStat.isFile() && onProgress) {
      const sessionId = randomUUID();
      const generation = ++this.#openGeneration;
      const id = randomUUID();
      const item = this.#temporaryAsset(id, selectedPath, selectedStat);
      this.#temporary.clear();
      if (!this.temporaryIndex) this.#temporary.set(id, selectedPath);
      this.temporaryIndex?.begin(sessionId);
      this.temporaryIndex?.insert(sessionId, [{ id, file: selectedPath, sizeBytes: selectedStat.size, modifiedAt: selectedStat.mtimeMs }]);
      setImmediate(() => { void this.#discoverSiblings(directory, selectedPath, id, sessionId, generation, onProgress); });
      return { items: [item], selectedId: id, directory, sessionId, complete: false, ...(this.temporaryIndex ? { indexed: true, totalCount: 1 } : {}) };
    }
    const candidates = explicit ? paths : (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && isSupportedBrowseMedia(entry.name)).map((entry) => path.join(directory, entry.name));
    candidates.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    const items: CatalogAsset[] = [];
    const grants = new Map<string, string>();
    let selectedId = '';
    // Directory entries already carry file type. Stat and canonicalize only
    // explicit paths; doing both for every sibling made opening O(N) syscalls.
    const seen = new Set<string>();
    for (const input of candidates) {
      const candidate = explicit ? await realpath(input).catch(() => null) : input;
      if (!candidate) continue;
      if (seen.has(candidate)) continue;
      seen.add(candidate);
      if (!isSupportedBrowseMedia(candidate)) continue;
      const metadata = explicit || candidate === selectedPath ? await stat(candidate).catch(() => null) : null;
      if (explicit && !metadata?.isFile()) continue;
      const id = randomUUID();
      grants.set(id, candidate);
      if (candidate === selectedPath) selectedId = id;
      items.push({ id, folderId: '', fileName: path.basename(candidate), format: path.extname(candidate).slice(1).toUpperCase(),
        sizeBytes: metadata?.size ?? 0, modifiedAt: metadata?.mtimeMs ?? 0, rating: 0, labelColor: null, flag: 'unflagged', favorite: false, offline: false, tags: [],
        thumbnailUrl: `photoasset://temporary-thumbnail/${id}`, previewUrl: `photoasset://temporary/${id}` });
    }
    if (!items.length) throw new Error('所选位置没有可查看的图片');
    ++this.#openGeneration;
    this.#temporary.clear();
    if (!this.temporaryIndex) for (const [id, file] of grants) this.#temporary.set(id, file);
    if (this.temporaryIndex) {
      const sessionId = randomUUID();
      this.temporaryIndex.begin(sessionId);
      for (let start = 0; start < items.length; start += 256) {
        this.temporaryIndex.insert(sessionId, items.slice(start, start + 256).map((item) => ({ id: item.id, file: grants.get(item.id)!, sizeBytes: item.sizeBytes, modifiedAt: item.modifiedAt })));
      }
      await this.temporaryIndex.finishAsync(sessionId);
      return { items, selectedId: selectedId || items[0]!.id, directory, sessionId, complete: true, indexed: true, totalCount: items.length };
    }
    return { items, selectedId: selectedId || items[0]!.id, directory };
  }

  #temporaryAsset(id: string, file: string, metadata?: { size: number; mtimeMs: number }): CatalogAsset {
    return { id, folderId: '', fileName: path.basename(file), format: path.extname(file).slice(1).toUpperCase(),
      sizeBytes: metadata?.size ?? 0, modifiedAt: metadata?.mtimeMs ?? 0, rating: 0, labelColor: null, flag: 'unflagged', favorite: false, offline: false, tags: [],
      thumbnailUrl: `photoasset://temporary-thumbnail/${id}`, previewUrl: `photoasset://temporary/${id}` };
  }

  async #discoverSiblings(directory: string, selectedPath: string, selectedId: string, sessionId: string, generation: number, onProgress: (session: QuickViewSession) => void): Promise<void> {
    try {
      const handle = await opendir(directory);
      await this.#discoverEntries(handle, directory, selectedPath, selectedId, sessionId, generation, onProgress);
    } catch {
      if (generation === this.#openGeneration) {
        await this.temporaryIndex?.finishAsync(sessionId).catch(() => undefined);
        if (generation === this.#openGeneration) onProgress({ items: [], selectedId, directory, sessionId, complete: true });
      }
    }
  }

  async #discoverEntries(handle: Awaited<ReturnType<typeof opendir>>, directory: string, selectedPath: string, selectedId: string, sessionId: string, generation: number, onProgress: (session: QuickViewSession) => void): Promise<void> {
    const batch: CatalogAsset[] = [];
    try {
      for await (const entry of handle) {
        if (generation !== this.#openGeneration) return;
        if (!entry.isFile() || !isSupportedBrowseMedia(entry.name)) continue;
        const file = path.join(directory, entry.name);
        if (file === selectedPath) continue;
        const id = randomUUID();
        if (!this.temporaryIndex) this.#temporary.set(id, file);
        batch.push(this.#temporaryAsset(id, file));
        if (batch.length >= 256) {
          this.temporaryIndex?.insert(sessionId, batch.map((item) => ({ id: item.id, file: path.join(directory, item.fileName) })));
          onProgress({ items: batch.splice(0), selectedId, directory, sessionId, complete: false });
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
      }
      if (generation === this.#openGeneration) {
        this.temporaryIndex?.insert(sessionId, batch.map((item) => ({ id: item.id, file: path.join(directory, item.fileName) })));
        await this.temporaryIndex?.finishAsync(sessionId);
        if (generation !== this.#openGeneration) return;
        onProgress({ items: batch, selectedId, directory, sessionId, complete: true });
      }
    } catch {
      if (generation === this.#openGeneration) {
        this.temporaryIndex?.insert(sessionId, batch.map((item) => ({ id: item.id, file: path.join(directory, item.fileName) })));
        await this.temporaryIndex?.finishAsync(sessionId);
        if (generation !== this.#openGeneration) return;
        onProgress({ items: batch, selectedId, directory, sessionId, complete: true });
      }
    }
  }

  async details(id: string): Promise<FileDetails> {
    const file = this.resolve(id);
    if (!file) throw new Error('图片已从图库移除');
    const metadata = await stat(file);
    if (!metadata.isFile()) throw new Error('图片文件不可用');
    const cached = this.#detailsCache.get(file);
    if (cached?.sizeBytes === metadata.size && cached.modifiedAt === metadata.mtimeMs) return { ...cached.details };
    const result: FileDetails = { path: file, sizeBytes: metadata.size, modifiedAt: metadata.mtimeMs };
    try {
      const tags = await exifr.parse(file, { iptc: true, xmp: true, pick: ['Make', 'Model', 'LensMake', 'LensModel', 'DateTimeOriginal', 'ExposureTime', 'FNumber', 'ISO', 'FocalLength', 'ExifImageWidth', 'ExifImageHeight', 'ImageWidth', 'ImageHeight', 'Orientation', 'City', 'Country', 'CountryName'] });
      if (tags) {
        result.camera = [tags.Make, tags.Model].filter(Boolean).join(' ') || undefined;
        result.lens = tags.LensModel;
        if (typeof tags.Make === 'string') result.cameraMake = tags.Make.trim() || undefined;
        if (typeof tags.Model === 'string') result.cameraModel = tags.Model.trim() || undefined;
        if (typeof tags.LensMake === 'string') result.lensMake = tags.LensMake.trim() || undefined;
        if (typeof tags.LensModel === 'string') result.lensModel = tags.LensModel.trim() || undefined;
        if (typeof tags.City === 'string') result.city = tags.City.trim() || undefined;
        const country = tags.CountryName ?? tags.Country;
        if (typeof country === 'string') result.country = country.trim() || undefined;
        result.takenAt = tags.DateTimeOriginal instanceof Date ? tags.DateTimeOriginal.toISOString() : undefined;
        result.exposure = typeof tags.ExposureTime === 'number' && tags.ExposureTime > 0 ? tags.ExposureTime < 1 ? `1/${Math.round(1 / tags.ExposureTime)} s` : `${tags.ExposureTime} s` : undefined;
        if (typeof tags.ExposureTime === 'number' && Number.isFinite(tags.ExposureTime) && tags.ExposureTime > 0) result.exposureSeconds = tags.ExposureTime;
        for (const [key, value] of Object.entries({ aperture: tags.FNumber, iso: tags.ISO, focalLength: tags.FocalLength, width: tags.ExifImageWidth ?? tags.ImageWidth, height: tags.ExifImageHeight ?? tags.ImageHeight })) {
          if (typeof value === 'number' && Number.isFinite(value) && value > 0) Object.assign(result, { [key]: value });
        }
        if (result.width && result.height && [5, 6, 7, 8].includes(Number(tags.Orientation))) [result.width, result.height] = [result.height, result.width];
      }
    } catch {
      result.metadataWarning = '此文件未提供可读取的拍摄信息';
    }
    if (!result.width || !result.height) {
      try {
        const size = await imageSizeFromFile(file);
        if (size.width > 0 && size.height > 0) {
          [result.width, result.height] = [size.width, size.height];
          if (size.orientation && [5, 6, 7, 8].includes(size.orientation)) [result.width, result.height] = [result.height, result.width];
        }
      } catch { /* RAW or unsupported formats may only expose dimensions through EXIF. */ }
    }
    this.#detailsCache.delete(file);
    this.#detailsCache.set(file, { sizeBytes: metadata.size, modifiedAt: metadata.mtimeMs, details: result });
    if (this.#detailsCache.size > 5_000) this.#detailsCache.delete(this.#detailsCache.keys().next().value!);
    return result;
  }
}
