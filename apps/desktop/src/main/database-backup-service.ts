import { createHash } from 'node:crypto';
import { mkdir, readdir, rename, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type DatabaseBackupResult = {
  destinationPath: string;
  bytes: number;
  sha256: string;
};

/** Creates a consistent SQLite snapshot without copying live WAL files. */
export class DatabaseBackupService {
  readonly #databasePath: string;

  constructor(databasePath: string) {
    this.#databasePath = path.resolve(databasePath);
  }

  async create(destinationPath: string): Promise<DatabaseBackupResult> {
    const destination = path.resolve(destinationPath);
    if (destination === this.#databasePath) throw new Error('BACKUP_DESTINATION_IS_SOURCE');
    await mkdir(path.dirname(destination), { recursive: true });
    const temporary = `${destination}.${process.pid}.tmp`;
    await unlink(temporary).catch(() => undefined);

    const database = new DatabaseSync(this.#databasePath);
    database.exec('PRAGMA busy_timeout = 10000;');
    try {
      database.prepare('VACUUM INTO ?').run(temporary);
    } finally {
      database.close();
    }
    await rename(temporary, destination);
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

function parseAutomaticBackupTimestamp(fileName: string): number | null {
  const match = /^catalog-(\d+)\.sqlite$/u.exec(fileName);
  if (!match) return null;
  const timestamp = Number(match[1]);
  return Number.isSafeInteger(timestamp) && timestamp >= 0 ? timestamp : null;
}
