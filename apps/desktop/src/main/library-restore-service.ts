import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, statfs, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';

import type { InspectedLibraryBackup, LibraryBackupService, LibraryBackupVerificationResult } from './library-backup-service';

type LibraryRestoreFileSystem = { rename: typeof rename };
const nodeFileSystem: LibraryRestoreFileSystem = { rename };

const pendingRestoreSchema = z.object({
  schemaVersion: z.literal(1),
  stagingName: z.string().regex(/^\.photoallisai-restore-stage-[A-Za-z0-9_-]+$/u),
  createdAt: z.string().datetime()
}).strict();

export type AppliedLibraryRestore = LibraryBackupVerificationResult & { recoveryPath: string | null };

/** Stages verified backup files and swaps them in only before application services open the database. */
export class LibraryRestoreService {
  readonly #libraryDirectory: string;
  readonly #parentDirectory: string;
  readonly #pendingPath: string;
  readonly #backups: LibraryBackupService;
  readonly #fileSystem: LibraryRestoreFileSystem;

  constructor(libraryDirectory: string, backups: LibraryBackupService, fileSystem: LibraryRestoreFileSystem = nodeFileSystem) {
    this.#libraryDirectory = path.resolve(libraryDirectory);
    this.#parentDirectory = path.dirname(this.#libraryDirectory);
    this.#pendingPath = path.join(this.#parentDirectory, 'library-restore-pending.json');
    this.#backups = backups;
    this.#fileSystem = fileSystem;
  }

  async stage(requestedBackup: string, now = Date.now()): Promise<LibraryBackupVerificationResult> {
    await mkdir(this.#parentDirectory, { recursive: true });
    if (await regularFileExists(this.#pendingPath)) throw new Error('LIBRARY_RESTORE_ALREADY_PENDING');
    if (await pathExists(this.#pendingPath)) throw new Error('LIBRARY_RESTORE_MARKER_UNSAFE');
    const inspected = await this.#backups.inspect(requestedBackup);
    await assertAvailableSpace(this.#parentDirectory, inspected.databaseBytes + inspected.generatedBytes);
    const staging = await mkdtemp(path.join(this.#parentDirectory, '.photoallisai-restore-stage-'));
    try {
      await copyInspectedBackup(inspected, staging);
      const verified = await this.#backups.verify(staging);
      const marker = pendingRestoreSchema.parse({
        schemaVersion: 1,
        stagingName: path.basename(staging),
        createdAt: new Date(now).toISOString()
      });
      await writeFile(this.#pendingPath, JSON.stringify(marker, null, 2), { flag: 'wx', mode: 0o600 });
      return verified;
    } catch (error) {
      await rm(staging, { recursive: true, force: true });
      throw error;
    }
  }

  async applyPending(now = Date.now()): Promise<AppliedLibraryRestore | null> {
    if (!(await regularFileExists(this.#pendingPath))) {
      if (await pathExists(this.#pendingPath)) throw new Error('LIBRARY_RESTORE_MARKER_UNSAFE');
      return null;
    }
    const markerRaw = await readFile(this.#pendingPath, 'utf8');
    let marker: z.infer<typeof pendingRestoreSchema>;
    try {
      marker = pendingRestoreSchema.parse(JSON.parse(markerRaw));
    } catch {
      throw new Error('LIBRARY_RESTORE_MARKER_INVALID');
    }
    const parent = await realpath(this.#parentDirectory);
    const liveLibrary = path.join(parent, path.basename(this.#libraryDirectory));
    const expectedStaging = path.join(parent, marker.stagingName);
    const staging = await realpath(expectedStaging);
    if (staging !== expectedStaging || !(await stat(staging)).isDirectory()) throw new Error('LIBRARY_RESTORE_STAGE_UNSAFE');
    const inspected = await this.#backups.inspect(staging);
    await assertAvailableSpace(parent, inspected.databaseBytes + inspected.generatedBytes);

    const replacement = await mkdtemp(path.join(parent, '.photoallisai-restore-ready-'));
    let recoveryPath: string | null = null;
    try {
      await copyInspectedBackup(inspected, replacement);
      rewriteManagedResultPaths(path.join(replacement, 'catalog.sqlite'), path.join(liveLibrary, 'generated'), inspected);
      await unlink(path.join(replacement, 'manifest.json'));
      if (await pathExists(liveLibrary)) {
        recoveryPath = await availableRecoveryPath(parent, now);
        await this.#fileSystem.rename(liveLibrary, recoveryPath);
      }
      try {
        await this.#fileSystem.rename(replacement, liveLibrary);
      } catch (error) {
        if (recoveryPath) {
          try {
            await this.#fileSystem.rename(recoveryPath, liveLibrary);
          } catch (rollbackError) {
            throw new AggregateError([error, rollbackError], 'LIBRARY_RESTORE_ROLLBACK_FAILED');
          }
        }
        throw error;
      }
      await unlink(this.#pendingPath);
      await rm(staging, { recursive: true, force: true });
      return {
        createdAt: inspected.createdAt,
        databaseBytes: inspected.databaseBytes,
        generatedFiles: inspected.generatedFiles,
        generatedBytes: inspected.generatedBytes,
        recoveryPath
      };
    } catch (error) {
      await rm(replacement, { recursive: true, force: true });
      throw error;
    }
  }

  async quarantinePending(now = Date.now()): Promise<string | null> {
    if (!(await regularFileExists(this.#pendingPath))) {
      if (await pathExists(this.#pendingPath)) throw new Error('LIBRARY_RESTORE_MARKER_UNSAFE');
      return null;
    }
    const destination = await availableFailedPath(this.#pendingPath, now);
    await this.#fileSystem.rename(this.#pendingPath, destination);
    return destination;
  }
}

async function copyInspectedBackup(inspected: InspectedLibraryBackup, destination: string): Promise<void> {
  await copyFile(inspected.catalogPath, path.join(destination, 'catalog.sqlite'), constants.COPYFILE_EXCL);
  await copyFile(inspected.manifestPath, path.join(destination, 'manifest.json'), constants.COPYFILE_EXCL);
  for (const file of inspected.files) {
    const output = path.join(destination, 'generated', ...file.relativePath.split('/'));
    await mkdir(path.dirname(output), { recursive: true });
    await copyFile(file.sourcePath, output, constants.COPYFILE_EXCL);
  }
}

function rewriteManagedResultPaths(databasePath: string, generatedDirectory: string, inspected: InspectedLibraryBackup): void {
  const database = new DatabaseSync(databasePath);
  try {
    database.exec('BEGIN IMMEDIATE');
    const update = database.prepare("UPDATE generation_results SET file_path = ? WHERE id = ? AND storage_mode = 'managed'");
    for (const file of inspected.files) {
      const nextPath = path.join(generatedDirectory, ...file.relativePath.split('/'));
      if (update.run(nextPath, file.resultId).changes !== 1) throw new Error('LIBRARY_RESTORE_RESULT_MISSING');
    }
    database.exec('COMMIT');
    const integrity = database.prepare('PRAGMA quick_check').all() as Array<Record<string, unknown>>;
    if (integrity.length !== 1 || !Object.values(integrity[0] ?? {}).includes('ok')) throw new Error('LIBRARY_RESTORE_DATABASE_CORRUPT');
  } catch (error) {
    if (database.isTransaction) database.exec('ROLLBACK');
    throw error;
  } finally {
    database.close();
  }
}

async function assertAvailableSpace(directory: string, requiredBytes: number): Promise<void> {
  const fileSystem = await statfs(directory);
  if (fileSystem.bavail * fileSystem.bsize < requiredBytes) throw new Error('INSUFFICIENT_DISK_SPACE');
}

async function availableRecoveryPath(parent: string, now: number): Promise<string> {
  for (let index = 0; index < 10_000; index += 1) {
    const suffix = index === 0 ? '' : `-${index}`;
    const candidate = path.join(parent, `library.before-restore-${now}${suffix}`);
    if (!(await pathExists(candidate))) return candidate;
  }
  throw new Error('LIBRARY_RESTORE_RECOVERY_NAME_EXHAUSTED');
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await lstat(filePath);
    return true;
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return false;
    throw error;
  }
}

async function regularFileExists(filePath: string): Promise<boolean> {
  try {
    return (await lstat(filePath)).isFile();
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return false;
    throw error;
  }
}

async function availableFailedPath(pendingPath: string, now: number): Promise<string> {
  for (let index = 0; index < 10_000; index += 1) {
    const suffix = index === 0 ? '' : `-${index}`;
    const candidate = `${pendingPath}.failed-${now}${suffix}`;
    if (!(await pathExists(candidate))) return candidate;
  }
  throw new Error('LIBRARY_RESTORE_FAILURE_NAME_EXHAUSTED');
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}
