import { lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, unlink, utimes, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { execFile as nodeExecFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { promisify } from 'node:util';
import path from 'node:path';

import { nativeImage } from 'electron';

import type { CatalogService } from './catalog-service';
import { publishTemporaryFileSafely } from './safe-file-write';
import { PreviewWorkQueue, type PreviewPriority } from './preview-work-queue';
import { identifyMediaFormat } from './media-format-registry';

export type ImageVariant = 'thumbnail' | 'preview';
type DecoderCapabilities = { imageMagick: boolean; sips: boolean };
type DecoderProbe = () => Promise<DecoderCapabilities>;

const variants: Record<ImageVariant, { width: number; height: number; quality: number; resizeQuality: 'good' | 'best' }> = {
  thumbnail: { width: 384, height: 384, quality: 82, resizeQuality: 'good' },
  preview: { width: 2560, height: 2560, quality: 90, resizeQuality: 'best' }
};
const execFile = promisify(nodeExecFile);

export class ImageCacheService {
  readonly #inFlight = new Map<string, Promise<string>>();
  readonly #inFlightConsumers = new Map<string, number>();
  readonly #eventLoopDelay = monitorEventLoopDelay({ resolution: 20 });
  readonly #decodeQueue = new PreviewWorkQueue(2, 128, 64);
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
  #abortedConsumers = 0;
  #canceledQueued = 0;
  #decodeMsTotal = 0;
  #queueWaitMsTotal = 0;
  #createMsTotal = 0;
  #sourceStatMsTotal = 0;
  #nativeDecodeMsTotal = 0;
  #nativeReadMsTotal = 0;
  #nativeResizeMsTotal = 0;
  #externalDecodeMsTotal = 0;
  #jpegEncodeMsTotal = 0;
  #cacheWriteMsTotal = 0;
  #cachePayloadWriteMsTotal = 0;
  #cachePublishMsTotal = 0;
  #cacheCleanupMsTotal = 0;
  #closed = false;

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
    this.#eventLoopDelay.enable();
  }

  async getStats(): Promise<{ files: number; bytes: number }> {
    const files = await this.#listFiles();
    let bytes = 0;
    for (const file of files) bytes += file.size;
    return { files: files.length, bytes };
  }

  async cleanupTemporaryFiles(): Promise<{ removedFiles: number; removedBytes: number }> {
    let removedFiles = 0;
    let removedBytes = 0;
    const directories = [this.#cacheDirectory];
    while (directories.length > 0) {
      const directory = directories.pop();
      if (!directory) continue;
      const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        const filePath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          directories.push(filePath);
          continue;
        }
        if (!entry.isFile() || !isCacheTemporaryFile(entry.name)) continue;
        const metadata = await lstat(filePath).catch(() => null);
        if (!metadata?.isFile()) continue;
        try {
          await unlink(filePath);
          removedFiles += 1;
          removedBytes += metadata.size;
        } catch {
          // A concurrent cleanup or locked file can be retried on the next startup.
        }
      }
    }
    return { removedFiles, removedBytes };
  }

  getPerformanceStats() {
    return {
      hits: this.#hits,
      misses: this.#misses,
      decodes: this.#decodes,
      abortedConsumers: this.#abortedConsumers,
      canceledQueued: this.#canceledQueued,
      decodeMsTotal: Math.round(this.#decodeMsTotal * 100) / 100,
      queueWaitMsTotal: Math.round(this.#queueWaitMsTotal * 100) / 100,
      createMsTotal: Math.round(this.#createMsTotal * 100) / 100,
      sourceStatMsTotal: Math.round(this.#sourceStatMsTotal * 100) / 100,
      nativeDecodeMsTotal: Math.round(this.#nativeDecodeMsTotal * 100) / 100,
      nativeReadMsTotal: Math.round(this.#nativeReadMsTotal * 100) / 100,
      nativeResizeMsTotal: Math.round(this.#nativeResizeMsTotal * 100) / 100,
      externalDecodeMsTotal: Math.round(this.#externalDecodeMsTotal * 100) / 100,
      jpegEncodeMsTotal: Math.round(this.#jpegEncodeMsTotal * 100) / 100,
      cacheWriteMsTotal: Math.round(this.#cacheWriteMsTotal * 100) / 100,
      cachePayloadWriteMsTotal: Math.round(this.#cachePayloadWriteMsTotal * 100) / 100,
      cachePublishMsTotal: Math.round(this.#cachePublishMsTotal * 100) / 100,
      cacheCleanupMsTotal: Math.round(this.#cacheCleanupMsTotal * 100) / 100,
      eventLoopDelayMaxMs: Math.round(this.#eventLoopDelay.max / 10_000) / 100,
      eventLoopDelayMeanMs: Number.isFinite(this.#eventLoopDelay.mean) ? Math.round(this.#eventLoopDelay.mean / 10_000) / 100 : 0
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

  async getOrCreate(assetId: string, variant: ImageVariant, openedSource?: { path: string; modifiedAt: number; sizeBytes: number }, priority: PreviewPriority = variant === 'preview' ? 'visible' : 'background', signal?: AbortSignal): Promise<string | null> {
    if (this.#closed || signal?.aborted) return null;
    const source = openedSource ?? this.#catalog.resolveAssetFile(assetId);
    if (!source) return null;

    const specification = variants[variant];
    const cacheKey = openedSource
      ? `temporary-${createHash('sha256').update(source.path).digest('hex')}-${source.modifiedAt}-${source.sizeBytes}-${variant}`
      : `${assetId}-${source.modifiedAt}-${source.sizeBytes}-${variant}`;
    const destination = path.join(this.#cacheDirectory, cacheKey.slice(0, 2), `${cacheKey}.jpg`);

    const existing = this.#inFlight.get(cacheKey);
    if (existing) {
      if (priority === 'visible') this.#decodeQueue.promote(cacheKey);
      return this.#waitForConsumer(cacheKey, existing, signal);
    }

    // A cached preview does not need a decoder slot. Keep disk hits responsive
    // while slow source images occupy both workers.
    if (await isRegularFile(destination)) {
      if (signal?.aborted || this.#closed) return null;
      this.#hits += 1;
      await this.#touch(destination);
      return signal?.aborted || this.#closed ? null : destination;
    }
    if (signal?.aborted || this.#closed) return null;
    const pending = this.#inFlight.get(cacheKey);
    if (pending) {
      if (priority === 'visible') this.#decodeQueue.promote(cacheKey);
      return this.#waitForConsumer(cacheKey, pending, signal);
    }

    const startedAt = performance.now();
    let createStartedAt: number | null = null;
    const operation = this.#decodeQueue.enqueue(async () => {
      this.#queueWaitMsTotal += performance.now() - startedAt;
      if (await isRegularFile(destination)) {
        this.#hits += 1;
        await this.#touch(destination);
        return destination;
      }
      this.#misses += 1;
      createStartedAt = performance.now();
      try { return await this.#create(source.path, destination, specification); }
      finally { this.#createMsTotal += performance.now() - createStartedAt; }
    }, priority, cacheKey)
      .then((result) => {
        this.#schedulePrune();
        return result;
      })
      .finally(() => {
        if (createStartedAt !== null) {
          this.#decodes += 1;
          this.#decodeMsTotal += performance.now() - startedAt;
        }
        if (this.#inFlight.get(cacheKey) === operation) this.#inFlight.delete(cacheKey);
      });
    this.#inFlight.set(cacheKey, operation);
    return this.#waitForConsumer(cacheKey, operation, signal);
  }

  #waitForConsumer(key: string, operation: Promise<string>, signal?: AbortSignal): Promise<string | null> {
    this.#inFlightConsumers.set(key, (this.#inFlightConsumers.get(key) ?? 0) + 1);
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = () => {
        if (settled) return false;
        settled = true;
        signal?.removeEventListener('abort', abort);
        const remaining = (this.#inFlightConsumers.get(key) ?? 1) - 1;
        if (remaining > 0) this.#inFlightConsumers.set(key, remaining);
        else {
          this.#inFlightConsumers.delete(key);
          const canceled = this.#decodeQueue.cancel(key);
          if (canceled) this.#canceledQueued += 1;
          if (canceled && this.#inFlight.get(key) === operation) this.#inFlight.delete(key);
        }
        return true;
      };
      const abort = () => {
        if (finish()) {
          this.#abortedConsumers += 1;
          resolve(null);
        }
      };
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      operation.then((value) => { if (finish()) resolve(value); }, (error) => { if (finish()) reject(error); });
    });
  }

  async #touch(filePath: string): Promise<void> {
    const now = Date.now();
    const lastTouch = this.#lastTouches.get(filePath) ?? 0;
    if (now - lastTouch < 5 * 60_000) return;
    const timestamp = new Date(now);
    await utimes(filePath, timestamp, timestamp).catch(() => undefined);
    this.#lastTouches.set(filePath, now);
  }

  async stop(): Promise<void> {
    this.#closed = true;
    this.#eventLoopDelay.disable();
    if (this.#pruneTimer) clearTimeout(this.#pruneTimer);
    this.#pruneTimer = null;
    await this.#decodeQueue.close();
    await Promise.allSettled([...this.#inFlight.values(), this.#pruneQueue]);
  }

  #schedulePrune(): void {
    if (this.#closed) return;
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
    specification: { width: number; height: number; quality: number; resizeQuality: 'good' | 'best' }
  ): Promise<string> {
    // Empty files cannot produce a preview; avoid submitting them to a decoder.
    const statStartedAt = performance.now();
    const sourceMetadata = await stat(sourcePath);
    this.#sourceStatMsTotal += performance.now() - statStartedAt;
    if (!sourceMetadata.isFile() || sourceMetadata.size === 0) throw new Error('IMAGE_PREVIEW_UNAVAILABLE');
    await mkdir(path.dirname(destination), { recursive: true });
    const nativeStartedAt = performance.now();
    let image = nativeImage.createEmpty();
    let encoded: Buffer | null = null;
    const format = identifyMediaFormat(sourcePath);
    if (specification.width === variants.thumbnail.width && sourceMetadata.size >= 8 * 1024 * 1024 && (format?.id === 'jpeg' || format?.id === 'png')) {
      const capabilities = await this.getDecoderCapabilities();
      if (capabilities.imageMagick) {
        const externalStartedAt = performance.now();
        encoded = await this.#decodeWithImageMagick(sourcePath, specification);
        this.#externalDecodeMsTotal += performance.now() - externalStartedAt;
      }
    }
    if (!encoded) {
      const readStartedAt = performance.now();
      image = nativeImage.createFromPath(sourcePath);
      this.#nativeReadMsTotal += performance.now() - readStartedAt;
    }
    if (!encoded && !image.isEmpty()) {
      const size = image.getSize();
      const scale = Math.min(specification.width / size.width, specification.height / size.height, 1);
      const resizeStartedAt = performance.now();
      image = image.resize({
        width: Math.max(1, Math.round(size.width * scale)),
        height: Math.max(1, Math.round(size.height * scale)),
        quality: specification.resizeQuality
      });
      this.#nativeResizeMsTotal += performance.now() - resizeStartedAt;
    } else if (!encoded) {
      const externalStartedAt = performance.now();
      encoded = await this.#decodeWithExternalTools(sourcePath, destination, specification);
      this.#externalDecodeMsTotal += performance.now() - externalStartedAt;
      if (!encoded) {
        if (process.platform === 'darwin') {
          const quickLook = await createQuickLookThumbnail(sourcePath, Math.max(specification.width, specification.height));
          if (quickLook) image = nativeImage.createFromBuffer(quickLook);
        } else {
          image = await nativeImage.createThumbnailFromPath(sourcePath, {
            width: specification.width,
            height: specification.height
          });
        }
      }
    }
    this.#nativeDecodeMsTotal += performance.now() - nativeStartedAt;
    if (image.isEmpty() && !encoded) throw new Error('IMAGE_PREVIEW_UNAVAILABLE');

    const encodeStartedAt = performance.now();
    const bytes = encoded ?? image.toJPEG(specification.quality);
    this.#jpegEncodeMsTotal += performance.now() - encodeStartedAt;
    const writeStartedAt = performance.now();
    const result = await writeCacheFileAtomically(destination, bytes, (stage, durationMs) => {
      if (stage === 'payload') this.#cachePayloadWriteMsTotal += durationMs;
      else if (stage === 'publish') this.#cachePublishMsTotal += durationMs;
      else this.#cacheCleanupMsTotal += durationMs;
    });
    this.#cacheWriteMsTotal += performance.now() - writeStartedAt;
    return result;
  }

  async #decodeWithExternalTools(sourcePath: string, destination: string, specification: { width: number; height: number; quality: number }): Promise<Buffer | null> {
    if (identifyMediaFormat(sourcePath)?.kind === 'video') return this.#decodeVideoFrame(sourcePath, specification);
    const imageMagick = await this.#decodeWithImageMagick(sourcePath, specification);
    if (imageMagick) return imageMagick;
    return this.#decodeWithSips(sourcePath, destination, specification);
  }

  async #decodeVideoFrame(sourcePath: string, specification: { width: number; height: number; quality: number }): Promise<Buffer | null> {
    try {
      const result = await execFile('ffmpeg', [
        '-hide_banner', '-loglevel', 'error', '-nostdin', '-i', sourcePath,
        '-frames:v', '1', '-vf', `scale=${specification.width}:${specification.height}:force_original_aspect_ratio=decrease`,
        '-q:v', '3', '-f', 'image2pipe', '-vcodec', 'mjpeg', 'pipe:1'
      ], { encoding: 'buffer', maxBuffer: 20 * 1024 * 1024, timeout: 15_000, windowsHide: true });
      const output = Buffer.from(result.stdout);
      return output.length > 0 && output.length <= 20 * 1024 * 1024 ? output : null;
    } catch {
      return null;
    }
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

export async function createQuickLookThumbnail(sourcePath: string, size: number): Promise<Buffer | null> {
  if (process.platform !== 'darwin') return null;
  const outputDirectory = await mkdtemp(path.join(tmpdir(), 'photoallisai-quicklook-'));
  try {
    await execFile('qlmanage', ['-t', '-s', String(size), '-o', outputDirectory, sourcePath], {
      timeout: 15_000,
      windowsHide: true
    });
    const files = await readdir(outputDirectory);
    const thumbnail = files.find((name) => name.endsWith('.png'));
    if (!thumbnail) return null;
    const output = await readFile(path.join(outputDirectory, thumbnail));
    return output.length > 0 && output.length <= 20 * 1024 * 1024 ? output : null;
  } catch {
    return null;
  } finally {
    await rm(outputDirectory, { recursive: true, force: true });
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

export async function writeCacheFileAtomically(destination: string, bytes: Buffer, onStage?: (stage: 'payload' | 'publish' | 'cleanup', durationMs: number) => void): Promise<string> {
  const temporaryPath = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  try {
    let startedAt = performance.now();
    try { await writeFile(temporaryPath, bytes, { flag: 'wx' }); }
    finally { onStage?.('payload', performance.now() - startedAt); }
    startedAt = performance.now();
    try { await publishTemporaryFileSafely(destination, temporaryPath); }
    finally { onStage?.('publish', performance.now() - startedAt); }
    return destination;
  } catch (error) {
    if (await isRegularFile(destination)) return destination;
    throw error;
  } finally {
    const startedAt = performance.now();
    await unlink(temporaryPath).catch(() => undefined);
    onStage?.('cleanup', performance.now() - startedAt);
  }
}

async function isRegularFile(filePath: string): Promise<boolean> {
  try {
    return (await lstat(filePath)).isFile();
  } catch {
    return false;
  }
}

function isCacheTemporaryFile(fileName: string): boolean {
  return /\.jpg\.\d+\.(?:\d+|[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.tmp$/iu.test(fileName);
}
