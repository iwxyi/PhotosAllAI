import { createHash } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { copyFile, mkdir, mkdtemp, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { DatabaseBackupService } from './database-backup-service';

export type LibraryBackupResult = {
  destinationPath: string;
  databaseBytes: number;
  generatedFiles: number;
  generatedBytes: number;
  manifestSha256: string;
};

export class LibraryBackupService {
  readonly #databasePath: string;
  readonly #generatedDirectory: string;
  readonly #libraryDirectory: string;
  readonly #databaseBackup: DatabaseBackupService;

  constructor(databasePath: string, generatedDirectory: string) {
    this.#databasePath = path.resolve(databasePath);
    this.#generatedDirectory = path.resolve(generatedDirectory);
    this.#libraryDirectory = path.dirname(this.#databasePath);
    this.#databaseBackup = new DatabaseBackupService(this.#databasePath);
  }

  async create(requestedParent: string, now = Date.now()): Promise<LibraryBackupResult> {
    const parent = await realpath(requestedParent);
    if (!(await stat(parent)).isDirectory()) throw new Error('BACKUP_DESTINATION_NOT_DIRECTORY');
    const libraryDirectory = await realpath(this.#libraryDirectory);
    if (isWithin(libraryDirectory, parent)) throw new Error('BACKUP_DESTINATION_INSIDE_LIBRARY');
    const destination = await availableDestination(parent, `PhotoAllIsAI-library-${now}`);
    const temporary = await mkdtemp(path.join(parent, '.photoallisai-library-backup-'));
    try {
      const snapshotPath = path.join(temporary, 'catalog.sqlite');
      const database = await this.#databaseBackup.create(snapshotPath);
      const snapshot = new DatabaseSync(snapshotPath, { readOnly: true });
      let rows: Array<{ id: string; file_path: string }> = [];
      try {
        const table = snapshot.prepare("SELECT 1 AS value FROM sqlite_master WHERE type = 'table' AND name = 'generation_results'").get();
        if (table) {
          rows = snapshot.prepare(`
            SELECT id, file_path FROM generation_results
            WHERE storage_mode = 'managed' ORDER BY id
          `).all() as Array<{ id: string; file_path: string }>;
        }
      } finally {
        snapshot.close();
      }

      const generatedDirectory = rows.length > 0 ? await realpath(this.#generatedDirectory) : null;
      let generatedBytes = 0;
      const files: Array<{ resultId: string; relativePath: string; bytes: number; sha256: string }> = [];
      for (const row of rows) {
        const source = await realpath(row.file_path);
        if (!generatedDirectory || !isWithin(generatedDirectory, source)) throw new Error('BACKUP_MANAGED_PATH_OUTSIDE_LIBRARY');
        const relativePath = path.relative(generatedDirectory, source).split(path.sep).join('/');
        const destinationPath = path.join(temporary, 'generated', ...relativePath.split('/'));
        const sourceStats = await stat(source);
        if (!sourceStats.isFile()) throw new Error('BACKUP_GENERATED_RESULT_NOT_FILE');
        await mkdir(path.dirname(destinationPath), { recursive: true });
        await copyFile(source, destinationPath, constants.COPYFILE_EXCL);
        const [sourceHash, destinationHash] = await Promise.all([hashFile(source), hashFile(destinationPath)]);
        const destinationStats = await stat(destinationPath);
        if (sourceStats.size !== destinationStats.size || sourceHash !== destinationHash) {
          throw new Error('BACKUP_GENERATED_RESULT_CHANGED');
        }
        generatedBytes += destinationStats.size;
        files.push({ resultId: row.id, relativePath, bytes: destinationStats.size, sha256: destinationHash });
      }

      const manifest = Buffer.from(JSON.stringify({
        schemaVersion: 1,
        createdAt: new Date(now).toISOString(),
        catalog: { file: 'catalog.sqlite', bytes: database.bytes, sha256: database.sha256 },
        generated: files
      }, null, 2));
      await writeFile(path.join(temporary, 'manifest.json'), manifest, { flag: 'wx', mode: 0o600 });
      await rename(temporary, destination);
      return {
        destinationPath: destination,
        databaseBytes: database.bytes,
        generatedFiles: files.length,
        generatedBytes,
        manifestSha256: createHash('sha256').update(manifest).digest('hex')
      };
    } catch (error) {
      await rm(temporary, { recursive: true, force: true });
      throw error;
    }
  }
}

async function availableDestination(parent: string, baseName: string): Promise<string> {
  for (let index = 0; index < 10_000; index += 1) {
    const candidate = path.join(parent, index === 0 ? baseName : `${baseName} (${index})`);
    try {
      await stat(candidate);
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return candidate;
      throw error;
    }
  }
  throw new Error('BACKUP_NAME_EXHAUSTED');
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function hashFile(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}
