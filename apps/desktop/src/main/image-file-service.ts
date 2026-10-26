import { randomUUID } from 'node:crypto';
import { readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import exifr from 'exifr';
import type { CatalogAsset, FileDetails, QuickViewSession } from '@photoallisai/contracts';
import { isSupportedImage, type CatalogService } from './catalog-service';

export const DIRECT_IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.avif', '.bmp', '.ico']);

// Temporary IDs grant access only to files explicitly opened or their directory siblings.
export class ImageFileService {
  readonly #temporary = new Map<string, string>();
  readonly #detailsCache = new Map<string, { sizeBytes: number; modifiedAt: number; details: FileDetails }>();
  constructor(private readonly catalog: Pick<CatalogService, 'resolveAssetFile'>) {}

  resolve(id: string): string | null {
    return this.#temporary.get(id) ?? this.catalog.resolveAssetFile(id)?.path ?? null;
  }

  async open(paths: string[]): Promise<QuickViewSession> {
    if (!paths.length) throw new Error('请选择图片文件');
    const selectedPath = await realpath(paths[0]!);
    const selectedStat = await stat(selectedPath);
    const directory = selectedStat.isDirectory() ? selectedPath : path.dirname(selectedPath);
    if (!selectedStat.isDirectory() && !isSupportedImage(selectedPath)) throw new Error('不支持的图片格式');
    const candidates = paths.length > 1 ? paths : (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && isSupportedImage(entry.name)).map((entry) => path.join(directory, entry.name));
    candidates.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    const items: CatalogAsset[] = [];
    const grants = new Map<string, string>();
    let selectedId = '';
    const canonical = await Promise.all(candidates.map((candidate) => realpath(candidate).catch(() => null)));
    for (const candidate of new Set(canonical)) {
      if (!candidate) continue;
      if (!isSupportedImage(candidate)) continue;
      const metadata = await stat(candidate).catch(() => null);
      if (!metadata?.isFile()) continue;
      const id = randomUUID();
      grants.set(id, candidate);
      if (candidate === selectedPath) selectedId = id;
      items.push({ id, folderId: '', fileName: path.basename(candidate), format: path.extname(candidate).slice(1).toUpperCase(),
        sizeBytes: metadata.size, modifiedAt: metadata.mtimeMs, rating: 0, labelColor: null, flag: 'unflagged', favorite: false, offline: false, tags: [],
        thumbnailUrl: `photoasset://temporary-thumbnail/${id}`, previewUrl: `photoasset://temporary/${id}` });
    }
    if (!items.length) throw new Error('所选位置没有可查看的图片');
    this.#temporary.clear();
    for (const [id, file] of grants) this.#temporary.set(id, file);
    return { items, selectedId: selectedId || items[0]!.id, directory };
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
      const tags = await exifr.parse(file, { iptc: true, xmp: true, pick: ['Make', 'Model', 'LensMake', 'LensModel', 'DateTimeOriginal', 'ExposureTime', 'FNumber', 'ISO', 'FocalLength', 'ExifImageWidth', 'ExifImageHeight', 'ImageWidth', 'ImageHeight', 'City', 'Country', 'CountryName'] });
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
      }
    } catch {
      result.metadataWarning = '此文件未提供可读取的拍摄信息';
    }
    this.#detailsCache.delete(file);
    this.#detailsCache.set(file, { sizeBytes: metadata.size, modifiedAt: metadata.mtimeMs, details: result });
    if (this.#detailsCache.size > 5_000) this.#detailsCache.delete(this.#detailsCache.keys().next().value!);
    return result;
  }
}
