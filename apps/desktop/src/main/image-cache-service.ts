import { access, mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { nativeImage } from 'electron';

import type { CatalogService } from './catalog-service';

export type ImageVariant = 'thumbnail' | 'preview';

const variants: Record<ImageVariant, { width: number; height: number; quality: number }> = {
  thumbnail: { width: 384, height: 384, quality: 82 },
  preview: { width: 2560, height: 2560, quality: 90 }
};

export class ImageCacheService {
  readonly #inFlight = new Map<string, Promise<string>>();
  readonly #cacheDirectory: string;
  readonly #catalog: CatalogService;

  constructor(cacheDirectory: string, catalog: CatalogService) {
    this.#cacheDirectory = cacheDirectory;
    this.#catalog = catalog;
  }

  async getOrCreate(assetId: string, variant: ImageVariant): Promise<string | null> {
    const source = this.#catalog.resolveAssetFile(assetId);
    if (!source) return null;

    const specification = variants[variant];
    const cacheKey = `${assetId}-${source.modifiedAt}-${variant}`;
    const destination = path.join(this.#cacheDirectory, cacheKey.slice(0, 2), `${cacheKey}.jpg`);

    try {
      await access(destination);
      return destination;
    } catch {
      // Cache miss.
    }

    const existing = this.#inFlight.get(cacheKey);
    if (existing) return existing;

    const operation = this.#create(source.path, destination, specification).finally(() => {
      this.#inFlight.delete(cacheKey);
    });
    this.#inFlight.set(cacheKey, operation);
    return operation;
  }

  async #create(
    sourcePath: string,
    destination: string,
    specification: { width: number; height: number; quality: number }
  ): Promise<string> {
    await mkdir(path.dirname(destination), { recursive: true });
    let image = nativeImage.createFromPath(sourcePath);
    if (!image.isEmpty()) {
      const size = image.getSize();
      const scale = Math.min(specification.width / size.width, specification.height / size.height, 1);
      image = image.resize({
        width: Math.max(1, Math.round(size.width * scale)),
        height: Math.max(1, Math.round(size.height * scale)),
        quality: 'best'
      });
    } else {
      image = await nativeImage.createThumbnailFromPath(sourcePath, {
        width: specification.width,
        height: specification.height
      });
    }
    if (image.isEmpty()) throw new Error('IMAGE_PREVIEW_UNAVAILABLE');

    const temporaryPath = `${destination}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporaryPath, image.toJPEG(specification.quality), { flag: 'wx' });
    try {
      await rename(temporaryPath, destination);
    } catch (error) {
      try {
        await access(destination);
        return destination;
      } catch {
        throw error;
      }
    }
    return destination;
  }
}
