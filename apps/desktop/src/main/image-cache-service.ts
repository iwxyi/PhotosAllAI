import { access, mkdir, readFile, readdir, rename, stat, unlink, utimes, writeFile } from 'node:fs/promises';
import { execFile as nodeExecFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

import { nativeImage } from 'electron';

import type { CatalogService } from './catalog-service';

export type ImageVariant = 'thumbnail' | 'preview';
type DecoderCapabilities = { imageMagick: boolean; sips: boolean };
type DecoderProbe = () => Promise<DecoderCapabilities>;

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
  #decoderAvailability: Promise<DecoderCapabilities> | null = null;
  #maxBytes: number;
  #pruneQueue: Promise<void> = Promise.resolve();
  #pruneTimer: ReturnType<typeof setTimeout> | null = null;
  readonly #lastTouches = new Map<string, number>();
  #hits = 0;
  #misses = 0;
  #decodes = 0;
  #decodeMsTotal = 0;

  constructor(
    cacheDirectory: string,
    catalog: CatalogService,
    decoderProbe: DecoderProbe = defaultDecoderProbe,
    maxBytes = 5 * 1024 ** 3
  ) {
    this.#cacheDirectory = cacheDirectory;
    this.#catalog = catalog;
    this.#decoderProbe = decoderProbe;
    this.#maxBytes = normalizeMaxBytes(maxBytes);
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

  async getDecoderCapabilities(): Promise<{ nativeImage: boolean; imageMagick: boolean; sips: boolean }> {
    this.#decoderAvailability ??= this.#decoderProbe();
    return { nativeImage: true, ...(await this.#decoderAvailability) };
  }

  async prune(maxBytes: number): Promise<{ removedFiles: number; removedBytes: number }> {
    const operation = this.#pruneQueue.then(() => this.#prune(normalizeMaxBytes(maxBytes)));
    this.#pruneQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async setMaxBytes(maxBytes: number): Promise<{ removedFiles: number; removedBytes: number }> {
    this.#maxBytes = normalizeMaxBytes(maxBytes);
    return this.prune(this.#maxBytes);
  }

  async #prune(target: number): Promise<{ removedFiles: number; removedBytes: number }> {
    const files = await this.#listFiles();
    let total = files.reduce((sum, file) => sum + file.size, 0);
    let removedFiles = 0;
    let removedBytes = 0;
    files.sort((left, right) => left.modifiedAt - right.modifiedAt);
    for (const file of files) {
      if (total <= target) break;
      try {
        await unlink(file.path);
        total -= file.size;
        removedFiles += 1;
        removedBytes += file.size;
        this.#lastTouches.delete(file.path);
      } catch (error) {
        if (isNodeError(error, 'ENOENT')) total -= file.size;
      }
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
      await this.#touch(destination);
      return destination;
    } catch {
      // Cache miss.
      this.#misses += 1;
    }

    const existing = this.#inFlight.get(cacheKey);
    if (existing) return existing;

    const startedAt = performance.now();
    const operation = this.#create(source.path, destination, specification)
      .then((result) => {
        this.#schedulePrune();
        return result;
      })
      .finally(() => {
        this.#decodes += 1;
        this.#decodeMsTotal += performance.now() - startedAt;
        this.#inFlight.delete(cacheKey);
      });
    this.#inFlight.set(cacheKey, operation);
    return operation;
  }

  async #touch(filePath: string): Promise<void> {
    const now = Date.now();
    const lastTouch = this.#lastTouches.get(filePath) ?? 0;
    if (now - lastTouch < 5 * 60_000) return;
    const timestamp = new Date(now);
    await utimes(filePath, timestamp, timestamp).catch(() => undefined);
    this.#lastTouches.set(filePath, now);
  }

  #schedulePrune(): void {
    if (this.#pruneTimer) return;
    this.#pruneTimer = setTimeout(() => {
      this.#pruneTimer = null;
      void this.prune(this.#maxBytes);
    }, 30_000);
    this.#pruneTimer.unref();
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
      encoded = await this.#decodeWithExternalTools(sourcePath, destination, specification);
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

  async #decodeWithExternalTools(sourcePath: string, destination: string, specification: { width: number; height: number; quality: number }): Promise<Buffer | null> {
    const imageMagick = await this.#decodeWithImageMagick(sourcePath, specification);
    if (imageMagick) return imageMagick;
    return this.#decodeWithSips(sourcePath, destination, specification);
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

  async #decodeWithSips(sourcePath: string, destination: string, specification: { width: number; height: number; quality: number }): Promise<Buffer | null> {
    if (process.platform !== 'darwin') return null;
    const temporaryPath = `${destination}.${process.pid}.${Date.now()}.sips.jpg`;
    try {
      await execFile('sips', [
        '-s', 'format', 'jpeg',
        '-Z', String(Math.max(specification.width, specification.height)),
        sourcePath,
        '--out', temporaryPath
      ], { timeout: 30_000, windowsHide: true });
      const output = await readFile(temporaryPath);
      return output.length > 0 && output.length <= 20 * 1024 * 1024 ? output : null;
    } catch {
      return null;
    } finally {
      await unlink(temporaryPath).catch(() => undefined);
    }
  }
}

async function defaultDecoderProbe(): Promise<DecoderCapabilities> {
  const probe = async (command: string): Promise<boolean> => {
    try {
      await execFile(command, ['-version'], { timeout: 5_000, windowsHide: true });
      return true;
    } catch {
      return false;
    }
  };
  const [imageMagick, sips] = await Promise.all([probe('magick'), process.platform === 'darwin' ? probe('sips') : Promise.resolve(false)]);
  return { imageMagick, sips };
}

function normalizeMaxBytes(value: number): number {
  return Math.max(0, Math.trunc(value));
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code;
}
