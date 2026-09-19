import { createHash } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';

import { DatabaseBackupService } from './database-backup-service';

export type LibraryBackupResult = {
  destinationPath: string;
  databaseBytes: number;
  generatedFiles: number;
  generatedBytes: number;
  manifestSha256: string;
};

export type LibraryBackupVerificationResult = {
  createdAt: string;
  databaseBytes: number;
  generatedFiles: number;
  generatedBytes: number;
};

export type InspectedLibraryBackup = LibraryBackupVerificationResult & {
  rootPath: string;
  manifestPath: string;
  catalogPath: string;
  files: Array<{ resultId: string; relativePath: string; bytes: number; sha256: string; sourcePath: string }>;
};

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const libraryBackupManifestSchema = z.object({
  schemaVersion: z.literal(1),
  createdAt: z.string().datetime(),
  catalog: z.object({
    file: z.literal('catalog.sqlite'),
    bytes: z.number().int().nonnegative(),
    sha256: sha256Schema
  }).strict(),
  generated: z.array(z.object({
    resultId: z.string().min(1),
    relativePath: z.string().min(1),
    bytes: z.number().int().nonnegative(),
    sha256: sha256Schema
  }).strict()).max(250_000)
}).strict();

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
      await this.#databaseBackup.create(snapshotPath);
      const snapshot = new DatabaseSync(snapshotPath);
      let rows: Array<{ id: string; file_path: string }> = [];
      try {
        const intentTable = snapshot.prepare("SELECT 1 AS value FROM sqlite_master WHERE type = 'table' AND name = 'generation_write_intents'").get();
        const table = snapshot.prepare("SELECT 1 AS value FROM sqlite_master WHERE type = 'table' AND name = 'generation_results'").get();
        if (table) {
          if (intentTable) {
            snapshot.prepare(`
              DELETE FROM generation_results
              WHERE id IN (SELECT result_id FROM generation_write_intents)
            `).run();
          }
          const hasTrashState = (snapshot.prepare('PRAGMA table_info(generation_results)').all() as { name: string }[])
            .some((column) => column.name === 'trashed_at');
          if (hasTrashState) snapshot.prepare('DELETE FROM generation_results WHERE trashed_at IS NOT NULL').run();
          rows = snapshot.prepare(`
            SELECT id, file_path FROM generation_results
            WHERE storage_mode = 'managed' ORDER BY id
          `).all() as Array<{ id: string; file_path: string }>;
        }
        if (intentTable) snapshot.prepare('DELETE FROM generation_write_intents').run();
      } finally {
        snapshot.close();
      }
      const databaseStats = await stat(snapshotPath);
      const database = { bytes: databaseStats.size, sha256: await hashFile(snapshotPath) };

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

  async verify(requestedBackup: string): Promise<LibraryBackupVerificationResult> {
    const inspected = await this.inspect(requestedBackup);
    return {
      createdAt: inspected.createdAt,
      databaseBytes: inspected.databaseBytes,
      generatedFiles: inspected.generatedFiles,
      generatedBytes: inspected.generatedBytes
    };
  }

  async inspect(requestedBackup: string): Promise<InspectedLibraryBackup> {
    const backup = await realpath(requestedBackup);
    if (!(await stat(backup)).isDirectory()) throw new Error('BACKUP_PACKAGE_NOT_DIRECTORY');
    const manifestPath = await verifiedRegularFile(backup, 'manifest.json');
    const manifestStats = await stat(manifestPath);
    if (manifestStats.size > 64 * 1024 * 1024) throw new Error('BACKUP_MANIFEST_TOO_LARGE');

    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(manifestPath, 'utf8'));
    } catch {
      throw new Error('BACKUP_MANIFEST_INVALID');
    }
    const result = libraryBackupManifestSchema.safeParse(parsed);
    if (!result.success) throw new Error('BACKUP_MANIFEST_INVALID');
    const manifest = result.data;
    const resultIds = new Set<string>();
    const relativePaths = new Set<string>();
    for (const file of manifest.generated) {
      if (!isSafeRelativePath(file.relativePath)) throw new Error('BACKUP_MANIFEST_PATH_INVALID');
      if (resultIds.has(file.resultId) || relativePaths.has(file.relativePath)) throw new Error('BACKUP_MANIFEST_DUPLICATE');
      resultIds.add(file.resultId);
      relativePaths.add(file.relativePath);
    }

    const catalogPath = await verifiedRegularFile(backup, manifest.catalog.file);
    await verifyFile(catalogPath, manifest.catalog.bytes, manifest.catalog.sha256, 'BACKUP_CATALOG_CHECKSUM_MISMATCH');
    const database = new DatabaseSync(catalogPath, { readOnly: true });
    try {
      const integrity = database.prepare('PRAGMA quick_check').all() as Array<Record<string, unknown>>;
      if (integrity.length !== 1 || !Object.values(integrity[0] ?? {}).includes('ok')) throw new Error('BACKUP_CATALOG_CORRUPT');
      const table = database.prepare("SELECT 1 AS value FROM sqlite_master WHERE type = 'table' AND name = 'generation_results'").get();
      const hasTrashState = table && (database.prepare('PRAGMA table_info(generation_results)').all() as { name: string }[])
        .some((column) => column.name === 'trashed_at');
      const managedRows = table
        ? database.prepare(`SELECT id FROM generation_results WHERE storage_mode = 'managed'${hasTrashState ? ' AND trashed_at IS NULL' : ''}`).all() as Array<{ id: string }>
        : [];
      const managedIds = new Set(managedRows.map((row) => row.id));
      if (managedIds.size !== resultIds.size || [...managedIds].some((id) => !resultIds.has(id))) {
        throw new Error('BACKUP_CATALOG_RESULTS_MISSING');
      }
    } finally {
      database.close();
    }

    let generatedBytes = 0;
    const files: InspectedLibraryBackup['files'] = [];
    for (const file of manifest.generated) {
      const filePath = await verifiedRegularFile(backup, path.posix.join('generated', file.relativePath));
      await verifyFile(filePath, file.bytes, file.sha256, 'BACKUP_GENERATED_CHECKSUM_MISMATCH');
      generatedBytes += file.bytes;
      files.push({ ...file, sourcePath: filePath });
    }
    return {
      rootPath: backup,
      manifestPath,
      catalogPath,
      createdAt: manifest.createdAt,
      databaseBytes: manifest.catalog.bytes,
      generatedFiles: manifest.generated.length,
      generatedBytes,
      files
    };
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

function isSafeRelativePath(relativePath: string): boolean {
  if (relativePath.includes('\\') || path.posix.isAbsolute(relativePath) || path.posix.normalize(relativePath) !== relativePath) return false;
  return relativePath.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

async function verifiedRegularFile(root: string, relativePath: string): Promise<string> {
  const expected = path.join(root, ...relativePath.split('/'));
  const actual = await realpath(expected);
  if (actual !== expected || !isWithin(root, actual)) throw new Error('BACKUP_PACKAGE_PATH_UNSAFE');
  if (!(await stat(actual)).isFile()) throw new Error('BACKUP_PACKAGE_FILE_INVALID');
  return actual;
}

async function verifyFile(filePath: string, expectedBytes: number, expectedHash: string, errorCode: string): Promise<void> {
  const fileStats = await stat(filePath);
  if (fileStats.size !== expectedBytes || await hashFile(filePath) !== expectedHash) throw new Error(errorCode);
}
