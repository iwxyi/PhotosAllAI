import { createHash } from 'node:crypto';
import { mkdir, rename, stat, unlink } from 'node:fs/promises';
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
}
