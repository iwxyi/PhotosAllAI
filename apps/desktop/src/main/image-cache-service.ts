import { access, mkdir, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { execFile as nodeExecFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

import { nativeImage } from 'electron';

import type { CatalogService } from './catalog-service';

export type ImageVariant = 'thumbnail' | 'preview';
type DecoderProbe = () => Promise<boolean>;

const variants: Record<ImageVariant, { width: number; height: number; quality: number }> = {
  thumbnail: { width: 384, height: 384, quality: 82 },
  preview: { width: 2560, height: 2560, quality: 90 }
};
const execFile = promisify(nodeExecFile);

export class ImageCacheService {
  readonly #inFlight = new Map<string, Promise<string>>();
  readonly #cacheDirectory: string;
  readonly #catalog: CatalogService;
  readonly #decoderProbe: DecoderProbe;
  #decoderAvailability: Promise<boolean> | null = null;
  #hits = 0;
  #misses = 0;
  #decodes = 0;
  #decodeMsTotal = 0;

  constructor(cacheDirectory: string, catalog: CatalogService, decoderProbe: DecoderProbe = defaultDecoderProbe) {
    this.#cacheDirectory = cacheDirectory;
    this.#catalog = catalog;
    this.#decoderProbe = decoderProbe;
  }

  async getStats(): Promise<{ files: number; bytes: number }> {
    const files = await this.#listFiles();
    let bytes = 0;
    for (const file of files) bytes += file.size;
    return { files: files.length, bytes };
  }

  getPerformanceStats(): { hits: number; misses: number; decodes: number; decodeMsTotal: number } {
    return {
      hits: this.#hits,
      misses: this.#misses,
      decodes: this.#decodes,
      decodeMsTotal: Math.round(this.#decodeMsTotal * 100) / 100
    };
  }

  async getDecoderCapabilities(): Promise<{ nativeImage: boolean; imageMagick: boolean }> {
    this.#decoderAvailability ??= this.#decoderProbe();
    return { nativeImage: true, imageMagick: await this.#decoderAvailability };
  }

  async prune(maxBytes: number): Promise<{ removedFiles: number; removedBytes: number }> {
    const target = Math.max(0, Math.trunc(maxBytes));
    const files = await this.#listFiles();
    let total = files.reduce((sum, file) => sum + file.size, 0);
    let removedFiles = 0;
    let removedBytes = 0;
    files.sort((left, right) => left.modifiedAt - right.modifiedAt);
    for (const file of files) {
      if (total <= target) break;
      await unlink(file.path).catch(() => undefined);
      total -= file.size;
      removedFiles += 1;
      removedBytes += file.size;
    }
    return { removedFiles, removedBytes };
  }

  async #listFiles(): Promise<{ path: string; size: number; modifiedAt: number }[]> {
    const result: { path: string; size: number; modifiedAt: number }[] = [];
    const directories = [this.#cacheDirectory];
    while (directories.length > 0) {
      const directory = directories.pop();
      if (!directory) continue;
      const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        const filePath = path.join(directory, entry.name);
        if (entry.isDirectory()) directories.push(filePath);
        else if (entry.isFile() && entry.name.endsWith('.jpg')) {
          const metadata = await stat(filePath).catch(() => null);
          if (metadata) result.push({ path: filePath, size: metadata.size, modifiedAt: metadata.mtimeMs });
        }
      }
    }
    return result;
  }

  async getOrCreate(assetId: string, variant: ImageVariant): Promise<string | null> {
    const source = this.#catalog.resolveAssetFile(assetId);
    if (!source) return null;

    const specification = variants[variant];
    const cacheKey = `${assetId}-${source.modifiedAt}-${variant}`;
    const destination = path.join(this.#cacheDirectory, cacheKey.slice(0, 2), `${cacheKey}.jpg`);

    try {
      await access(destination);
      this.#hits += 1;
      return destination;
    } catch {
      // Cache miss.
      this.#misses += 1;
    }

    const existing = this.#inFlight.get(cacheKey);
    if (existing) return existing;

    const startedAt = performance.now();
    const operation = this.#create(source.path, destination, specification)
      .then((result) => result)
      .finally(() => {
        this.#decodes += 1;
        this.#decodeMsTotal += performance.now() - startedAt;
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
    let encoded: Buffer | null = null;
    if (!image.isEmpty()) {
      const size = image.getSize();
      const scale = Math.min(specification.width / size.width, specification.height / size.height, 1);
      image = image.resize({
        width: Math.max(1, Math.round(size.width * scale)),
        height: Math.max(1, Math.round(size.height * scale)),
        quality: 'best'
      });
    } else {
      encoded = await this.#decodeWithImageMagick(sourcePath, specification);
      if (!encoded) {
        image = await nativeImage.createThumbnailFromPath(sourcePath, {
          width: specification.width,
          height: specification.height
        });
      }
    }
    if (image.isEmpty() && !encoded) throw new Error('IMAGE_PREVIEW_UNAVAILABLE');

    const temporaryPath = `${destination}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporaryPath, encoded ?? image.toJPEG(specification.quality), { flag: 'wx' });
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

  async #decodeWithImageMagick(sourcePath: string, specification: { width: number; height: number; quality: number }): Promise<Buffer | null> {
    try {
      const result = await execFile('magick', [
        sourcePath,
        '-auto-orient',
        '-resize', `${specification.width}x${specification.height}>`,
        '-quality', String(specification.quality),
        'jpg:-'
      ], { encoding: 'buffer', maxBuffer: 20 * 1024 * 1024, timeout: 30_000, windowsHide: true });
      const output = Buffer.from(result.stdout);
      return output.length > 0 && output.length <= 20 * 1024 * 1024 ? output : null;
    } catch {
      return null;
    }
  }
}

async function defaultDecoderProbe(): Promise<boolean> {
  try {
    await execFile('magick', ['-version'], { timeout: 5_000, windowsHide: true });
    return true;
  } catch {
    return false;
  }
}
