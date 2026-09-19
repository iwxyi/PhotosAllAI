import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, lstat, mkdir, readFile, realpath, rename, rm, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';

import { DatabaseBackupService } from './database-backup-service';
import { replaceRegularFileSafely } from './safe-file-write';

const stateSchema = z.object({ schemaVersion: z.number().int().nonnegative() }).strict();
const checkpointSchema = z.object({
  formatVersion: z.literal(1),
  sourceVersion: z.number().int().nonnegative(),
  targetVersion: z.number().int().positive(),
  backupFile: z.string().regex(/^pre-migration-schema-\d+-to-\d+-\d+\.sqlite$/u),
  backupSha256: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: z.string().datetime()
}).strict();

export type DatabaseMigrationCheckpoint = z.infer<typeof checkpointSchema>;

/** Guards service-owned schema changes with a crash-recoverable database checkpoint. */
export class DatabaseMigrationService {
  readonly #databasePath: string;
  readonly #libraryDirectory: string;
  readonly #backupDirectory: string;
  readonly #statePath: string;
  readonly #pendingPath: string;

  constructor(databasePath: string) {
    this.#databasePath = path.resolve(databasePath);
    this.#libraryDirectory = path.dirname(this.#databasePath);
    this.#backupDirectory = path.join(this.#libraryDirectory, 'backups');
    this.#statePath = path.join(this.#libraryDirectory, 'schema-state.json');
    this.#pendingPath = path.join(this.#libraryDirectory, 'migration-pending.json');
  }

  async prepare(targetVersion: number, now = Date.now()): Promise<DatabaseMigrationCheckpoint | null> {
    if (!Number.isSafeInteger(targetVersion) || targetVersion < 1) throw new Error('MIGRATION_TARGET_INVALID');
    await mkdir(this.#libraryDirectory, { recursive: true });
    await this.recoverPending(now);
    const sourceVersion = await this.#readStateVersion();
    if (sourceVersion > targetVersion) throw new Error('MIGRATION_DATABASE_NEWER_THAN_APP');
    if (sourceVersion === targetVersion || !(await isRegularFile(this.#databasePath))) return null;

    await mkdir(this.#backupDirectory, { recursive: true });
    const backupFile = `pre-migration-schema-${sourceVersion}-to-${targetVersion}-${now}.sqlite`;
    const backup = await new DatabaseBackupService(this.#databasePath).create(path.join(this.#backupDirectory, backupFile));
    const checkpoint = checkpointSchema.parse({
      formatVersion: 1,
      sourceVersion,
      targetVersion,
      backupFile,
      backupSha256: backup.sha256,
      createdAt: new Date(now).toISOString()
    });
    await writeJsonAtomic(this.#pendingPath, checkpoint);
    return checkpoint;
  }

  async complete(targetVersion: number, checkpoint: DatabaseMigrationCheckpoint | null): Promise<void> {
    if (checkpoint && checkpoint.targetVersion !== targetVersion) throw new Error('MIGRATION_CHECKPOINT_MISMATCH');
    await writeJsonAtomic(this.#statePath, { schemaVersion: targetVersion });
    if (checkpoint) await unlink(this.#pendingPath);
  }

  async recoverPending(now = Date.now()): Promise<boolean> {
    let raw: string;
    try {
      raw = await readFile(this.#pendingPath, 'utf8');
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) return false;
      throw error;
    }
    let checkpoint: DatabaseMigrationCheckpoint;
    try {
      checkpoint = checkpointSchema.parse(JSON.parse(raw));
    } catch {
      throw new Error('MIGRATION_CHECKPOINT_INVALID');
    }
    const backupDirectory = await realpath(this.#backupDirectory);
    const expectedBackup = path.join(backupDirectory, checkpoint.backupFile);
    const backupPath = await realpath(expectedBackup);
    if (backupPath !== expectedBackup || !(await stat(backupPath)).isFile()) throw new Error('MIGRATION_BACKUP_PATH_UNSAFE');
    if (await hashFile(backupPath) !== checkpoint.backupSha256) throw new Error('MIGRATION_BACKUP_CHECKSUM_MISMATCH');
    assertHealthyDatabase(backupPath);

    // Recovery may be invoked concurrently by multiple app processes. A
    // fixed pid-based path lets one invocation delete or publish another
    // invocation's staged database. Use a per-attempt nonce instead.
    const temporary = `${this.#databasePath}.${process.pid}.${randomUUID()}.restore.tmp`;
    await rm(temporary, { force: true });
    await copyFile(backupPath, temporary);
    assertHealthyDatabase(temporary);
    const failedPath = await uniquePath(`${this.#databasePath}.migration-failed-${now}`);
    const moved: Array<{ from: string; to: string }> = [];
    try {
      if (await isRegularFile(this.#databasePath)) {
        await rename(this.#databasePath, failedPath);
        moved.push({ from: failedPath, to: this.#databasePath });
      }
      for (const suffix of ['-wal', '-shm']) {
        const source = `${this.#databasePath}${suffix}`;
        if (await isRegularFile(source)) {
          const failed = `${failedPath}${suffix}`;
          await rename(source, failed);
          moved.push({ from: failed, to: source });
        }
      }
      await rename(temporary, this.#databasePath);
    } catch (error) {
      await rm(temporary, { force: true });
      const rollbackErrors = await rollbackMigrationMoves(moved);
      if (rollbackErrors.length > 0) {
        throw new Error('MIGRATION_RESTORE_ROLLBACK_FAILED', { cause: { original: error, rollback: rollbackErrors } });
      }
      throw error;
    }
    if (checkpoint.sourceVersion === 0) await rm(this.#statePath, { force: true });
    else await writeJsonAtomic(this.#statePath, { schemaVersion: checkpoint.sourceVersion });
    await unlink(this.#pendingPath);
    return true;
  }

  async #readStateVersion(): Promise<number> {
    try {
      return stateSchema.parse(JSON.parse(await readFile(this.#statePath, 'utf8'))).schemaVersion;
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) return 0;
      throw new Error('MIGRATION_STATE_INVALID');
    }
  }
}

export async function rollbackMigrationMoves(
  moved: ReadonlyArray<{ from: string; to: string }>,
  renameFile: (from: string, to: string) => Promise<void> = rename
): Promise<unknown[]> {
  const errors: unknown[] = [];
  for (const item of [...moved].reverse()) {
    try {
      await renameFile(item.from, item.to);
    } catch (error) {
      errors.push(error);
    }
  }
  return errors;
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await replaceRegularFileSafely(filePath, Buffer.from(JSON.stringify(value, null, 2)));
}

async function isRegularFile(filePath: string): Promise<boolean> {
  try {
    return (await stat(filePath)).isFile();
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return false;
    throw error;
  }
}

async function uniquePath(basePath: string): Promise<string> {
  for (let index = 0; ; index += 1) {
    const candidate = index === 0 ? basePath : `${basePath}-${index}`;
    try {
      await lstat(candidate);
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) return candidate;
      throw error;
    }
  }
}

function assertHealthyDatabase(filePath: string): void {
  const database = new DatabaseSync(filePath, { readOnly: true });
  try {
    const rows = database.prepare('PRAGMA quick_check').all() as Array<Record<string, unknown>>;
    if (rows.length !== 1 || !Object.values(rows[0] ?? {}).includes('ok')) throw new Error('MIGRATION_BACKUP_CORRUPT');
  } finally {
    database.close();
  }
}

async function hashFile(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}
