import { createHash, randomUUID } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { copyFile, link, lstat, realpath, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { nativeImage } from 'electron';

import { exportReportSchema, type ExportPreset, type ExportReport } from '@photoallisai/contracts';

interface ResultResolver {
  resolveResultFile(resultId: string): string | null;
}

type ExportRunItemRow = {
  result_id: string;
  file_name: string;
  sha256: string;
  size_bytes: number;
  status: string;
};

type PreparedExport = {
  temporaryPath: string;
  requestedName: string;
  extension: string;
  sha256: string;
  sizeBytes: number;
};

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
        request_hash TEXT,
        status TEXT NOT NULL,
        report_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        completed_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS export_run_items (
        run_id TEXT NOT NULL REFERENCES export_runs(id) ON DELETE CASCADE,
        result_id TEXT NOT NULL,
        file_name TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        status TEXT NOT NULL,
        PRIMARY KEY (run_id, result_id)
      );
    `);
    const runColumns = this.#database.prepare('PRAGMA table_info(export_runs)').all() as { name: string }[];
    if (!runColumns.some((column) => column.name === 'request_hash')) {
      this.#database.exec('ALTER TABLE export_runs ADD COLUMN request_hash TEXT');
    }
  }

  close(): void {
    this.#database.close();
  }

  async exportToDirectory(
    resultIds: readonly string[],
    requestedDirectory: string,
    preset?: ExportPreset,
    signal?: AbortSignal,
    requestedRunId?: string
  ): Promise<ExportReport> {
    signal?.throwIfAborted();
    const destinationDirectory = await realpath(requestedDirectory);
    if (!(await stat(destinationDirectory)).isDirectory()) throw new Error('EXPORT_DESTINATION_NOT_DIRECTORY');
    const uniqueIds = [...new Set(resultIds)];
    const id = requestedRunId ?? randomUUID();
    const requestHash = createHash('sha256')
      .update(JSON.stringify({ resultIds: uniqueIds, preset: preset ?? null }))
      .digest('hex');
    this.#openRun(id, destinationDirectory, requestHash);
    const completedFiles = await this.#recoverCompletedFiles(id, destinationDirectory);
    const failures: ExportReport['failures'] = [];
    this.#persistRun(id, 'running', uniqueIds, completedFiles, failures, false);

    for (const resultId of uniqueIds) {
      if (signal?.aborted) break;
      if (completedFiles.has(resultId)) continue;
      const sourcePath = this.#results.resolveResultFile(resultId);
      if (!sourcePath) {
        failures.push({ resultId, errorCode: 'EXPORT_RESULT_NOT_FOUND' });
        this.#persistRun(id, 'running', uniqueIds, completedFiles, failures, false);
        continue;
      }
      const temporaryPath = path.join(destinationDirectory, `.photoallisai-export-${id}-${resultId}.tmp`);
      try {
        await removeOwnedTemporaryFile(temporaryPath);
        try {
          const prepared = await prepareWithPreset(sourcePath, temporaryPath, this.#imageEncoder, preset, signal);
          const fileName = await this.#publishPrepared(id, resultId, destinationDirectory, prepared, preset, signal);
          completedFiles.set(resultId, fileName);
        } finally {
          await removeOwnedTemporaryFile(temporaryPath).catch(() => undefined);
        }
      } catch (error) {
        if (signal?.aborted) break;
        failures.push({
          resultId,
          errorCode: toExportErrorCode(error)
        });
      }
      this.#persistRun(id, 'running', uniqueIds, completedFiles, failures, false);
    }

    const canceled = signal?.aborted ?? false;
    return this.#persistRun(
      id,
      canceled ? 'canceled' : failures.length === 0 ? 'completed' : 'partial',
      uniqueIds,
      completedFiles,
      failures,
      canceled
    );
  }

  #openRun(id: string, destinationDirectory: string, requestHash: string): void {
    const existing = this.#database.prepare('SELECT destination_path, request_hash FROM export_runs WHERE id = ?')
      .get(id) as { destination_path: string; request_hash: string | null } | undefined;
    if (existing && existing.destination_path !== destinationDirectory) throw new Error('EXPORT_RUN_DESTINATION_CHANGED');
    if (existing?.request_hash && existing.request_hash !== requestHash) throw new Error('EXPORT_RUN_REQUEST_CHANGED');
    if (!existing) {
      this.#database.prepare(`
        INSERT INTO export_runs (id, destination_path, request_hash, status, report_json, created_at)
        VALUES (?, ?, ?, 'running', '{}', ?)
      `).run(id, destinationDirectory, requestHash, Date.now());
      return;
    }
    this.#database.prepare(`
      UPDATE export_runs SET request_hash = ?, status = 'running', completed_at = NULL WHERE id = ?
    `).run(requestHash, id);
  }

  async #recoverCompletedFiles(id: string, destinationDirectory: string): Promise<Map<string, string>> {
    const rows = this.#database.prepare(`
      SELECT result_id, file_name, sha256, size_bytes, status
      FROM export_run_items WHERE run_id = ?
    `).all(id) as ExportRunItemRow[];
    const completed = new Map<string, string>();
    const discard = this.#database.prepare('DELETE FROM export_run_items WHERE run_id = ? AND result_id = ?');
    const finish = this.#database.prepare(`
      UPDATE export_run_items SET status = 'completed' WHERE run_id = ? AND result_id = ?
    `);
    for (const row of rows) {
      if (!isSafeFileName(row.file_name)) {
        discard.run(id, row.result_id);
        continue;
      }
      const filePath = path.join(destinationDirectory, row.file_name);
      try {
        if (!await verifyFilePayload(filePath, row.size_bytes, row.sha256)) {
          discard.run(id, row.result_id);
          continue;
        }
        finish.run(id, row.result_id);
        completed.set(row.result_id, row.file_name);
      } catch {
        discard.run(id, row.result_id);
      }
    }
    return completed;
  }

  async #publishPrepared(
    runId: string,
    resultId: string,
    destinationDirectory: string,
    prepared: PreparedExport,
    preset?: ExportPreset,
    signal?: AbortSignal
  ): Promise<string> {
    const record = this.#database.prepare(`
      INSERT INTO export_run_items (run_id, result_id, file_name, sha256, size_bytes, status)
      VALUES (?, ?, ?, ?, ?, 'publishing')
      ON CONFLICT(run_id, result_id) DO UPDATE SET
        file_name = excluded.file_name, sha256 = excluded.sha256,
        size_bytes = excluded.size_bytes, status = 'publishing'
    `);
    const discard = this.#database.prepare(`
      DELETE FROM export_run_items WHERE run_id = ? AND result_id = ? AND file_name = ? AND status = 'publishing'
    `);
    for (let index = 0; index < 10_000; index += 1) {
      signal?.throwIfAborted();
      if (index > 0 && preset?.conflictPolicy === 'skip') throw new Error('EXPORT_NAME_EXISTS');
      const fileName = index === 0
        ? prepared.requestedName
        : `${path.parse(prepared.requestedName).name} (${index})${prepared.extension}`;
      record.run(runId, resultId, fileName, prepared.sha256, prepared.sizeBytes);
      const publishedPath = path.join(destinationDirectory, fileName);
      try {
        await link(prepared.temporaryPath, publishedPath);
      } catch (error) {
        discard.run(runId, resultId, fileName);
        if (isAlreadyExists(error)) continue;
        throw error;
      }
      const [temporary, published] = await Promise.all([lstat(prepared.temporaryPath), lstat(publishedPath)]);
      if (!temporary.isFile() || !published.isFile()
        || temporary.dev !== published.dev || temporary.ino !== published.ino
        || published.size !== prepared.sizeBytes) {
        throw new Error('EXPORT_PUBLISHED_FILE_CHANGED');
      }
      const updated = this.#database.prepare(`
        UPDATE export_run_items SET status = 'completed'
        WHERE run_id = ? AND result_id = ? AND file_name = ?
      `).run(runId, resultId, fileName);
      if (updated.changes !== 1) throw new Error('EXPORT_RUN_ITEM_LOST');
      return fileName;
    }
    throw new Error('EXPORT_NAME_EXHAUSTED');
  }

  #persistRun(
    id: string,
    status: 'running' | 'completed' | 'partial' | 'canceled',
    resultIds: readonly string[],
    completedFiles: ReadonlyMap<string, string>,
    failures: ExportReport['failures'],
    canceled: boolean
  ): ExportReport {
    const files = resultIds.flatMap((resultId) => {
      const fileName = completedFiles.get(resultId);
      return fileName ? [{ resultId, fileName }] : [];
    });
    const report = exportReportSchema.parse({
      id,
      canceled,
      total: resultIds.length,
      succeeded: files.length,
      failed: failures.length,
      files,
      failures
    });
    const updated = this.#database.prepare(`
      UPDATE export_runs SET status = ?, report_json = ?, completed_at = ? WHERE id = ?
    `).run(status, JSON.stringify(report), status === 'running' ? null : Date.now(), id);
    if (updated.changes !== 1) throw new Error('EXPORT_RUN_LOST');
    return report;
  }
}

async function prepareWithPreset(
  sourcePath: string,
  temporaryPath: string,
  imageEncoder: ImageEncoder,
  preset?: ExportPreset,
  signal?: AbortSignal
): Promise<PreparedExport> {
  signal?.throwIfAborted();
  const source = await lstat(sourcePath);
  if (!source.isFile()) throw new Error('EXPORT_SOURCE_NOT_FILE');
  const parsed = path.parse(sourcePath);
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
  const currentSource = await lstat(sourcePath);
  if (!currentSource.isFile() || !isSameFileSnapshot(source, currentSource)) {
    throw new Error('EXPORT_SOURCE_CHANGED');
  }
  const copied = await lstat(temporaryPath);
  if (!copied.isFile()) throw new Error('EXPORT_TEMPORARY_FILE_UNSAFE');
  if ((!preset || preset.format === 'original') && copied.size !== source.size) throw new Error('EXPORT_SIZE_MISMATCH');
  if (copied.size === 0) throw new Error('EXPORT_EMPTY_FILE');
  const version = parsed.name.match(/(?:^|[-_])(v\d+)$/i)?.[1] ?? 'original';
  const extension = preset?.format === 'jpeg' ? '.jpg' : preset?.format === 'png' ? '.png' : parsed.ext;
  const requestedName = preset
    ? preset.namingPattern.replaceAll('{name}', parsed.name).replaceAll('{version}', version) + extension
    : parsed.base;
  const sha256 = await sha256File(temporaryPath);
  signal?.throwIfAborted();
  return { temporaryPath, requestedName, extension, sha256, sizeBytes: copied.size };
}

function isAlreadyExists(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'EEXIST';
}

function isSafeFileName(fileName: string): boolean {
  return fileName.length > 0 && fileName !== '.' && fileName !== '..' && !/[\\/]/u.test(fileName);
}

async function removeOwnedTemporaryFile(filePath: string): Promise<void> {
  let metadata;
  try {
    metadata = await lstat(filePath);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return;
    throw error;
  }
  if (!metadata.isFile()) throw new Error('EXPORT_TEMPORARY_FILE_UNSAFE');
  await unlink(filePath);
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

async function verifyFilePayload(filePath: string, expectedSize: number, expectedSha256: string): Promise<boolean> {
  const before = await lstat(filePath);
  if (!before.isFile() || before.size !== expectedSize) return false;
  const sha256 = await sha256File(filePath);
  const after = await lstat(filePath);
  return after.isFile() && isSameFileSnapshot(before, after) && sha256 === expectedSha256;
}

function isSameFileSnapshot(before: Awaited<ReturnType<typeof lstat>>, after: Awaited<ReturnType<typeof lstat>>): boolean {
  return before.dev === after.dev
    && before.ino === after.ino
    && before.size === after.size
    && before.mtimeMs === after.mtimeMs;
}

function toExportErrorCode(error: unknown): string {
  if (error instanceof Error && /^EXPORT_[A-Z0-9_]+$/u.test(error.message)) return error.message;
  return 'EXPORT_COPY_FAILED';
}
