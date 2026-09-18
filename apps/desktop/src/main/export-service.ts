import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, link, realpath, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { exportReportSchema, type ExportPreset, type ExportReport } from '@photoallisai/contracts';

interface ResultResolver {
  resolveResultFile(resultId: string): string | null;
}

export class ExportService {
  readonly #database: DatabaseSync;
  readonly #results: ResultResolver;

  constructor(databasePath: string, results: ResultResolver) {
    this.#results = results;
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

  async exportToDirectory(resultIds: readonly string[], requestedDirectory: string, preset?: ExportPreset): Promise<ExportReport> {
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
      const sourcePath = this.#results.resolveResultFile(resultId);
      if (!sourcePath) {
        failures.push({ resultId, errorCode: 'EXPORT_RESULT_NOT_FOUND' });
        continue;
      }
      try {
        const fileName = await copyWithPreset(sourcePath, destinationDirectory, preset);
        files.push({ resultId, fileName });
      } catch (error) {
        failures.push({
          resultId,
          errorCode: error instanceof Error ? error.message.slice(0, 200) : 'EXPORT_COPY_FAILED'
        });
      }
    }

    const report = exportReportSchema.parse({
      id,
      canceled: false,
      total: uniqueIds.length,
      succeeded: files.length,
      failed: failures.length,
      files,
      failures
    });
    this.#database.prepare(`
      UPDATE export_runs SET status = ?, report_json = ?, completed_at = ? WHERE id = ?
    `).run(failures.length === 0 ? 'completed' : 'partial', JSON.stringify(report), Date.now(), id);
    return report;
  }
}

async function copyWithPreset(sourcePath: string, destinationDirectory: string, preset?: ExportPreset): Promise<string> {
  const source = await stat(sourcePath);
  if (!source.isFile()) throw new Error('EXPORT_SOURCE_NOT_FILE');
  const parsed = path.parse(sourcePath);
  const temporaryPath = path.join(destinationDirectory, `.photoallisai-export-${randomUUID()}.tmp`);
  await copyFile(sourcePath, temporaryPath, constants.COPYFILE_EXCL);
  try {
    const copied = await stat(temporaryPath);
    if (copied.size !== source.size) throw new Error('EXPORT_SIZE_MISMATCH');
    const version = parsed.name.match(/(?:^|[-_])(v\d+)$/i)?.[1] ?? 'original';
    const requestedName = preset
      ? preset.namingPattern.replaceAll('{name}', parsed.name).replaceAll('{version}', version) + parsed.ext
      : parsed.base;
    for (let index = 0; index < 10_000; index += 1) {
      if (index > 0 && preset?.conflictPolicy === 'skip') throw new Error('EXPORT_NAME_EXISTS');
      const fileName = index === 0 ? requestedName : `${path.parse(requestedName).name} (${index})${parsed.ext}`;
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
