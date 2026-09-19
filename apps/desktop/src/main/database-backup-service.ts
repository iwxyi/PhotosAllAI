import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { publishTemporaryFileSafely } from './safe-file-write';

export type DatabaseBackupResult = {
  destinationPath: string;
  bytes: number;
  sha256: string;
};

/** Creates a consistent SQLite snapshot without copying live WAL files. */
export class DatabaseBackupService {
  readonly #databasePath: string;
  #automaticBackupTail: Promise<void> = Promise.resolve();

  constructor(databasePath: string) {
    this.#databasePath = path.resolve(databasePath);
  }

  async create(destinationPath: string): Promise<DatabaseBackupResult> {
    const destination = path.resolve(destinationPath);
    if (destination === this.#databasePath) throw new Error('BACKUP_DESTINATION_IS_SOURCE');
    await mkdir(path.dirname(destination), { recursive: true });
    const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
    await unlink(temporary).catch(() => undefined);

    const database = new DatabaseSync(this.#databasePath);
    database.exec('PRAGMA busy_timeout = 10000;');
    try {
      database.prepare('VACUUM INTO ?').run(temporary);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    } finally {
      database.close();
    }
    await publishTemporaryFileSafely(destination, temporary);
    const file = await stat(destination);
    const hash = createHash('sha256');
    const { createReadStream } = await import('node:fs');
    for await (const chunk of createReadStream(destination)) hash.update(chunk as Buffer);
    return { destinationPath: destination, bytes: file.size, sha256: hash.digest('hex') };
  }

  async createAutomatic(
    directory: string,
    options: { now?: number; minimumIntervalMs?: number; retention?: number } = {}
  ): Promise<DatabaseBackupResult | null> {
    const previous = this.#automaticBackupTail;
    let release!: () => void;
    this.#automaticBackupTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await this.#createAutomatic(directory, options);
    } finally {
      release();
    }
  }

  async #createAutomatic(
    directory: string,
    options: { now?: number; minimumIntervalMs?: number; retention?: number }
  ): Promise<DatabaseBackupResult | null> {
    const lockPath = path.join(path.resolve(directory), '.automatic-backup.lock');
    const releaseLock = await acquireBackupLock(lockPath);
    try {
      return await this.#createAutomaticLocked(directory, options);
    } finally {
      await releaseLock();
    }
  }

  async #createAutomaticLocked(
    directory: string,
    options: { now?: number; minimumIntervalMs?: number; retention?: number }
  ): Promise<DatabaseBackupResult | null> {
    const now = options.now ?? Date.now();
    const minimumIntervalMs = Math.max(0, options.minimumIntervalMs ?? 24 * 60 * 60 * 1_000);
    const retention = Math.max(1, Math.trunc(options.retention ?? 7));
    await mkdir(directory, { recursive: true });
    const backups = (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isFile())
      .map((entry) => ({ name: entry.name, timestamp: parseAutomaticBackupTimestamp(entry.name) }))
      .filter((entry): entry is { name: string; timestamp: number } => entry.timestamp !== null)
      .sort((left, right) => right.timestamp - left.timestamp);
    if (backups[0] && (now <= backups[0].timestamp || now - backups[0].timestamp < minimumIntervalMs)) return null;

    const result = await this.create(path.join(directory, `catalog-${now}.sqlite`));
    const expired = [{ name: path.basename(result.destinationPath), timestamp: now }, ...backups]
      .sort((left, right) => right.timestamp - left.timestamp)
      .slice(retention);
    await Promise.all(expired.map((entry) => unlink(path.join(directory, entry.name)).catch(() => undefined)));
    return result;
  }
}

async function acquireBackupLock(lockPath: string): Promise<() => Promise<void>> {
  const deadline = Date.now() + 30_000;
  await mkdir(path.dirname(lockPath), { recursive: true });
  while (true) {
    let created = false;
    const token = randomUUID();
    try {
      await mkdir(lockPath);
      created = true;
      await writeFile(
        path.join(lockPath, 'owner.json'),
        JSON.stringify({ pid: process.pid, createdAt: Date.now(), token }),
        { flag: 'wx' }
      );
      return async () => {
        try {
          const owner = JSON.parse(await readFile(path.join(lockPath, 'owner.json'), 'utf8')) as { token?: unknown };
          if (owner.token === token) await rm(lockPath, { recursive: true, force: true });
        } catch (error) {
          if (!isNodeError(error, 'ENOENT')) throw error;
        }
      };
    } catch (error) {
      if (created) {
        await rm(lockPath, { recursive: true, force: true });
        throw error;
      }
      if (!isNodeError(error, 'EEXIST')) throw error;
      if (await reclaimStaleBackupLock(lockPath)) {
        continue;
      }
      if (Date.now() >= deadline) throw new Error('AUTOMATIC_BACKUP_LOCK_TIMEOUT');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

async function reclaimStaleBackupLock(lockPath: string): Promise<boolean> {
  if (!(await isStaleBackupLock(lockPath))) return false;
  const quarantinePath = `${lockPath}.${process.pid}.${randomUUID()}.stale`;
  try {
    await rename(lockPath, quarantinePath);
    await rm(quarantinePath, { recursive: true, force: true });
    return true;
  } catch (error) {
    await rm(quarantinePath, { recursive: true, force: true }).catch(() => undefined);
    if (isNodeError(error, 'ENOENT')) return true;
    return false;
  }
}

async function isStaleBackupLock(lockPath: string): Promise<boolean> {
  try {
    const owner = JSON.parse(await readFile(path.join(lockPath, 'owner.json'), 'utf8')) as { pid?: unknown };
    if (typeof owner.pid !== 'number' || !Number.isInteger(owner.pid) || owner.pid <= 0) return false;
    try {
      process.kill(owner.pid, 0);
      return false;
    } catch (error) {
      return isNodeError(error, 'ESRCH');
    }
  } catch {
    return false;
  }
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code;
}

function parseAutomaticBackupTimestamp(fileName: string): number | null {
  const match = /^catalog-(\d+)\.sqlite$/u.exec(fileName);
  if (!match) return null;
  const timestamp = Number(match[1]);
  return Number.isSafeInteger(timestamp) && timestamp >= 0 ? timestamp : null;
}
