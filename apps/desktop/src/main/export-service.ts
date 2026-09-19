import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, link, realpath, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { nativeImage } from 'electron';

import { exportReportSchema, type ExportPreset, type ExportReport } from '@photoallisai/contracts';

interface ResultResolver {
  resolveResultFile(resultId: string): string | null;
}

export interface ImageEncoder {
  encode(sourcePath: string, options: { format: 'jpeg' | 'png'; quality: number; maxDimension: number | null }): Promise<Buffer>;
}

const electronImageEncoder: ImageEncoder = {
  async encode(sourcePath, options) {
    let image = nativeImage.createFromPath(sourcePath);
    if (image.isEmpty()) throw new Error('EXPORT_DECODE_FAILED');
    const size = image.getSize();
    if (options.maxDimension && Math.max(size.width, size.height) > options.maxDimension) {
      const scale = options.maxDimension / Math.max(size.width, size.height);
      image = image.resize({
        width: Math.max(1, Math.round(size.width * scale)),
        height: Math.max(1, Math.round(size.height * scale)),
        quality: 'best'
      });
    }
    const encoded = options.format === 'jpeg' ? image.toJPEG(options.quality) : image.toPNG();
    if (encoded.length === 0) throw new Error('EXPORT_ENCODE_FAILED');
    return encoded;
  }
};

export class ExportService {
  readonly #database: DatabaseSync;
  readonly #results: ResultResolver;
  readonly #imageEncoder: ImageEncoder;

  constructor(databasePath: string, results: ResultResolver, imageEncoder: ImageEncoder = electronImageEncoder) {
    this.#results = results;
    this.#imageEncoder = imageEncoder;
    this.#database = new DatabaseSync(databasePath);
    this.#database.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS export_runs (
        id TEXT PRIMARY KEY,
        destination_path TEXT NOT NULL,
        status TEXT NOT NULL,
        report_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        completed_at INTEGER
      )
    `);
  }

  close(): void {
    this.#database.close();
  }

  async exportToDirectory(resultIds: readonly string[], requestedDirectory: string, preset?: ExportPreset, signal?: AbortSignal): Promise<ExportReport> {
    signal?.throwIfAborted();
    const destinationDirectory = await realpath(requestedDirectory);
    if (!(await stat(destinationDirectory)).isDirectory()) throw new Error('EXPORT_DESTINATION_NOT_DIRECTORY');
    const uniqueIds = [...new Set(resultIds)];
    const id = randomUUID();
    const createdAt = Date.now();
    this.#database.prepare(`
      INSERT INTO export_runs (id, destination_path, status, report_json, created_at)
      VALUES (?, ?, 'running', '{}', ?)
    `).run(id, destinationDirectory, createdAt);

    const files: ExportReport['files'] = [];
    const failures: ExportReport['failures'] = [];
    for (const resultId of uniqueIds) {
      if (signal?.aborted) break;
      const sourcePath = this.#results.resolveResultFile(resultId);
      if (!sourcePath) {
        failures.push({ resultId, errorCode: 'EXPORT_RESULT_NOT_FOUND' });
        continue;
      }
      try {
        const fileName = await copyWithPreset(sourcePath, destinationDirectory, this.#imageEncoder, preset, signal);
        files.push({ resultId, fileName });
      } catch (error) {
        if (signal?.aborted) break;
        failures.push({
          resultId,
          errorCode: error instanceof Error ? error.message.slice(0, 200) : 'EXPORT_COPY_FAILED'
        });
      }
    }

    const report = exportReportSchema.parse({
      id,
      canceled: signal?.aborted ?? false,
      total: uniqueIds.length,
      succeeded: files.length,
      failed: failures.length,
      files,
      failures
    });
    this.#database.prepare(`
      UPDATE export_runs SET status = ?, report_json = ?, completed_at = ? WHERE id = ?
    `).run(report.canceled ? 'canceled' : failures.length === 0 ? 'completed' : 'partial', JSON.stringify(report), Date.now(), id);
    return report;
  }
}

async function copyWithPreset(sourcePath: string, destinationDirectory: string, imageEncoder: ImageEncoder, preset?: ExportPreset, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  const source = await stat(sourcePath);
  if (!source.isFile()) throw new Error('EXPORT_SOURCE_NOT_FILE');
  const parsed = path.parse(sourcePath);
  const temporaryPath = path.join(destinationDirectory, `.photoallisai-export-${randomUUID()}.tmp`);
  try {
    if (!preset || preset.format === 'original') {
      await copyFile(sourcePath, temporaryPath, constants.COPYFILE_EXCL);
    } else {
      const encoded = await imageEncoder.encode(sourcePath, {
        format: preset.format,
        quality: preset.quality,
        maxDimension: preset.maxDimension
      });
      signal?.throwIfAborted();
      if (encoded.length === 0) throw new Error('EXPORT_ENCODE_FAILED');
      await writeFile(temporaryPath, encoded, { flag: 'wx' });
    }
    signal?.throwIfAborted();
    const copied = await stat(temporaryPath);
    if ((!preset || preset.format === 'original') && copied.size !== source.size) throw new Error('EXPORT_SIZE_MISMATCH');
    if (copied.size === 0) throw new Error('EXPORT_EMPTY_FILE');
    const version = parsed.name.match(/(?:^|[-_])(v\d+)$/i)?.[1] ?? 'original';
    const extension = preset?.format === 'jpeg' ? '.jpg' : preset?.format === 'png' ? '.png' : parsed.ext;
    const requestedName = preset
      ? preset.namingPattern.replaceAll('{name}', parsed.name).replaceAll('{version}', version) + extension
      : parsed.base;
    for (let index = 0; index < 10_000; index += 1) {
      signal?.throwIfAborted();
      if (index > 0 && preset?.conflictPolicy === 'skip') throw new Error('EXPORT_NAME_EXISTS');
      const fileName = index === 0 ? requestedName : `${path.parse(requestedName).name} (${index})${extension}`;
      try {
        await link(temporaryPath, path.join(destinationDirectory, fileName));
        return fileName;
      } catch (error) {
        if (isAlreadyExists(error)) continue;
        throw error;
      }
    }
    throw new Error('EXPORT_NAME_EXHAUSTED');
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
}

function isAlreadyExists(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'EEXIST';
}
