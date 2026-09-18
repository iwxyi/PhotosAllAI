import { createHash, randomUUID } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import {
  copyFile,
  link,
  readdir,
  realpath,
  stat,
  unlink
} from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  moveCatalogAssetsInputSchema,
  moveCatalogAssetsReportSchema,
  type MoveCatalogAssetsInput,
  type MoveCatalogAssetsReport
} from '@photoallisai/contracts';

type FileSystemPort = {
  copyFile: typeof copyFile;
  link: typeof link;
  readdir: typeof readdir;
  realpath: typeof realpath;
  stat: typeof stat;
  unlink: typeof unlink;
};

type PlannedItem = {
  id: string;
  assetId: string;
  sourcePath: string;
  destinationPath: string;
  temporaryPath: string;
  sourceFolderId: string;
  destinationFolderId: string;
  previousFileName: string;
  fileName: string;
  sizeBytes: number;
  skipped: boolean;
  status: string;
};

type AssetLocationRow = {
  id: string;
  folder_id: string;
  path: string;
  file_name: string;
  size_bytes: number;
};

const nodeFileSystem: FileSystemPort = { copyFile, link, readdir, realpath, stat, unlink };

export class FileOperationService {
  readonly #database: DatabaseSync;
  readonly #fileSystem: FileSystemPort;
  #pending: Promise<void> = Promise.resolve();

  constructor(databasePath: string, fileSystem: FileSystemPort = nodeFileSystem) {
    this.#database = new DatabaseSync(databasePath);
    this.#database.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    this.#fileSystem = fileSystem;
    this.#migrate();
  }

  close(): void {
    this.#database.close();
  }

  async move(rawInput: MoveCatalogAssetsInput): Promise<MoveCatalogAssetsReport> {
    const input = moveCatalogAssetsInputSchema.parse(rawInput);
    const previous = this.#pending;
    let release!: () => void;
    this.#pending = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await this.#executeMove(input);
    } finally {
      release();
    }
  }

  async recoverInterruptedOperations(): Promise<number> {
    const operations = this.#database.prepare(`
      SELECT id FROM file_operations WHERE status IN ('planned', 'executing', 'compensating')
      ORDER BY created_at ASC
    `).all() as { id: string }[];
    for (const operation of operations) {
      const items = this.#readOperationItems(operation.id).reverse();
      let recovered = true;
      for (const item of items) {
        if (item.skipped || !['moving', 'moved', 'compensation_failed'].includes(item.status)) continue;
        try {
          await this.#recoverItem(item);
          this.#setItemStatus(item.id, 'rolled_back', null);
        } catch (error) {
          recovered = false;
          this.#setItemStatus(item.id, 'compensation_failed', errorCode(error));
        }
      }
      this.#database.prepare(`
        UPDATE file_operations SET status = ?, completed_at = ?, error_code = ? WHERE id = ?
      `).run(recovered ? 'failed' : 'compensation_failed', Date.now(), recovered ? 'INTERRUPTED_RECOVERED' : 'RECOVERY_FAILED', operation.id);
    }
    return operations.length;
  }

  #migrate(): void {
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS file_operations (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK(kind IN ('move')),
        status TEXT NOT NULL,
        target_folder_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        completed_at INTEGER,
        error_code TEXT
      );
      CREATE TABLE IF NOT EXISTS file_operation_items (
        id TEXT PRIMARY KEY,
        operation_id TEXT NOT NULL REFERENCES file_operations(id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL,
        asset_id TEXT NOT NULL,
        source_folder_id TEXT NOT NULL,
        destination_folder_id TEXT NOT NULL,
        source_path TEXT NOT NULL,
        destination_path TEXT NOT NULL,
        temporary_path TEXT NOT NULL,
        original_file_name TEXT NOT NULL,
        destination_file_name TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        status TEXT NOT NULL,
        error_code TEXT,
        UNIQUE(operation_id, ordinal)
      );
      CREATE INDEX IF NOT EXISTS file_operation_items_operation_idx
        ON file_operation_items(operation_id, ordinal);
    `);
  }

  async #executeMove(input: MoveCatalogAssetsInput): Promise<MoveCatalogAssetsReport> {
    const operationId = randomUUID();
    let items: PlannedItem[] = [];
    const completed: PlannedItem[] = [];
    try {
      items = await this.#plan(operationId, input);
      this.#database.prepare('UPDATE file_operations SET status = ? WHERE id = ?').run('executing', operationId);
      for (const item of items) {
        if (item.skipped) continue;
        this.#setItemStatus(item.id, 'moving', null);
        await this.#transfer(item.sourcePath, item.destinationPath, item.temporaryPath);
        completed.push(item);
        this.#setItemStatus(item.id, 'moved', null);
      }
      this.#commitCatalog(operationId, completed);
      return this.#report(operationId, items, 'completed', false, null);
    } catch (error) {
      const code = errorCode(error);
      let rolledBack = true;
      if (items.length > 0) {
        this.#database.prepare('UPDATE file_operations SET status = ?, error_code = ? WHERE id = ?')
          .run('compensating', code, operationId);
      }
      for (const item of completed.reverse()) {
        try {
          await this.#transfer(item.destinationPath, item.sourcePath, item.temporaryPath);
          this.#setItemStatus(item.id, 'rolled_back', null);
        } catch (compensationError) {
          rolledBack = false;
          this.#setItemStatus(item.id, 'compensation_failed', errorCode(compensationError));
        }
      }
      if (items.length === 0) throw error;
      this.#database.prepare(`
        UPDATE file_operations SET status = ?, completed_at = ?, error_code = ? WHERE id = ?
      `).run(rolledBack ? 'failed' : 'compensation_failed', Date.now(), code, operationId);
      return this.#report(operationId, items, 'failed', rolledBack, code);
    }
  }

  async #plan(operationId: string, input: MoveCatalogAssetsInput): Promise<PlannedItem[]> {
    const assetIds = [...new Set(input.assetIds)];
    if (assetIds.length !== input.assetIds.length) throw new Error('DUPLICATE_ASSET_ID');
    const target = this.#database.prepare('SELECT id, path FROM folders WHERE id = ?')
      .get(input.targetFolderId) as { id: string; path: string } | undefined;
    if (!target) throw new Error('TARGET_FOLDER_NOT_FOUND');
    const targetPath = await this.#fileSystem.realpath(target.path);
    const targetStats = await this.#fileSystem.stat(targetPath);
    if (!targetStats.isDirectory()) throw new Error('TARGET_NOT_DIRECTORY');

    const placeholders = assetIds.map(() => '?').join(', ');
    const rows = this.#database.prepare(`
      SELECT id, folder_id, path, file_name, size_bytes FROM assets WHERE id IN (${placeholders})
    `).all(...assetIds) as AssetLocationRow[];
    if (rows.length !== assetIds.length) throw new Error('CATALOG_ASSET_SET_MISMATCH');
    const byId = new Map(rows.map((row) => [row.id, row]));
    const reserved = new Set((await this.#fileSystem.readdir(targetPath)).map(normalizeFileName));
    const items = assetIds.map((assetId): PlannedItem => {
      const asset = byId.get(assetId)!;
      const skipped = asset.folder_id === target.id;
      const fileName = skipped ? asset.file_name : reserveFileName(asset.file_name, reserved);
      const itemId = randomUUID();
      return {
        id: itemId,
        assetId,
        sourcePath: asset.path,
        destinationPath: skipped ? asset.path : path.join(targetPath, fileName),
        temporaryPath: path.join(targetPath, `.photoallisai-${operationId}-${itemId}.tmp`),
        sourceFolderId: asset.folder_id,
        destinationFolderId: target.id,
        previousFileName: asset.file_name,
        fileName,
        sizeBytes: asset.size_bytes,
        skipped,
        status: skipped ? 'skipped' : 'planned'
      };
    });

    this.#database.exec('BEGIN IMMEDIATE');
    try {
      this.#database.prepare(`
        INSERT INTO file_operations (id, kind, status, target_folder_id, created_at)
        VALUES (?, 'move', 'planned', ?, ?)
      `).run(operationId, target.id, Date.now());
      const insertItem = this.#database.prepare(`
        INSERT INTO file_operation_items (
          id, operation_id, ordinal, asset_id, source_folder_id, destination_folder_id,
          source_path, destination_path, temporary_path, original_file_name,
          destination_file_name, size_bytes, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      items.forEach((item, ordinal) => insertItem.run(
        item.id, operationId, ordinal, item.assetId, item.sourceFolderId,
        item.destinationFolderId, item.sourcePath, item.destinationPath, item.temporaryPath,
        item.previousFileName, item.fileName, item.sizeBytes, item.skipped ? 'skipped' : 'planned'
      ));
      this.#database.exec('COMMIT');
    } catch (error) {
      this.#database.exec('ROLLBACK');
      throw error;
    }
    return items;
  }

  async #transfer(source: string, destination: string, temporary: string): Promise<void> {
    let published = false;
    try {
      await this.#fileSystem.link(source, destination);
      published = true;
    } catch (error) {
      if (!isCopyFallbackError(error)) throw error;
    }
    if (published) {
      try {
        await this.#fileSystem.unlink(source);
      } catch (error) {
        await removeIfPresent(this.#fileSystem, destination);
        throw error;
      }
      return;
    }

    await removeIfPresent(this.#fileSystem, temporary);
    let destinationPublished = false;
    try {
      await this.#fileSystem.copyFile(source, temporary, constants.COPYFILE_EXCL);
      const [sourceStats, temporaryStats] = await Promise.all([
        this.#fileSystem.stat(source),
        this.#fileSystem.stat(temporary)
      ]);
      if (temporaryStats.size !== sourceStats.size) {
        throw new Error('FILE_SIZE_CHANGED');
      }
      const [sourceHash, copiedHash] = await Promise.all([hashFile(source), hashFile(temporary)]);
      if (sourceHash !== copiedHash) throw new Error('FILE_HASH_MISMATCH');
      try {
        await this.#fileSystem.link(temporary, destination);
        destinationPublished = true;
      } catch (error) {
        if (!isCopyFallbackError(error)) throw error;
        try {
          await this.#fileSystem.copyFile(temporary, destination, constants.COPYFILE_EXCL);
          destinationPublished = true;
        } catch (copyError) {
          if (!isNodeError(copyError, 'EEXIST')) await removeIfPresent(this.#fileSystem, destination);
          throw copyError;
        }
        const destinationStats = await this.#fileSystem.stat(destination);
        if (destinationStats.size !== temporaryStats.size || await hashFile(destination) !== copiedHash) {
          await removeIfPresent(this.#fileSystem, destination);
          throw new Error('PUBLISHED_FILE_HASH_MISMATCH');
        }
      }
      await this.#fileSystem.unlink(temporary);
      try {
        await this.#fileSystem.unlink(source);
      } catch (error) {
        await removeIfPresent(this.#fileSystem, destination);
        throw error;
      }
    } catch (error) {
      await removeIfPresent(this.#fileSystem, temporary);
      if (destinationPublished) await removeIfPresent(this.#fileSystem, destination);
      throw error;
    }
  }

  #commitCatalog(operationId: string, items: PlannedItem[]): void {
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      const update = this.#database.prepare(`
        UPDATE assets SET folder_id = ?, path = ?, file_name = ? WHERE id = ? AND path = ?
      `);
      for (const item of items) {
        const result = update.run(
          item.destinationFolderId, item.destinationPath, item.fileName, item.assetId, item.sourcePath
        );
        if (result.changes !== 1) throw new Error('CATALOG_CONCURRENT_CHANGE');
      }
      this.#database.prepare(`
        UPDATE file_operations SET status = 'completed', completed_at = ?, error_code = NULL WHERE id = ?
      `).run(Date.now(), operationId);
      this.#database.exec('COMMIT');
    } catch (error) {
      this.#database.exec('ROLLBACK');
      throw error;
    }
  }

  #report(
    operationId: string,
    items: PlannedItem[],
    status: 'completed' | 'failed',
    rolledBack: boolean,
    code: string | null
  ): MoveCatalogAssetsReport {
    const moved = status === 'completed' ? items.filter((item) => !item.skipped) : [];
    return moveCatalogAssetsReportSchema.parse({
      operationId,
      status,
      total: items.length,
      moved: moved.length,
      skipped: items.filter((item) => item.skipped).length,
      rolledBack,
      files: moved.map((item) => ({
        assetId: item.assetId,
        fileName: item.fileName,
        previousFileName: item.previousFileName
      })),
      errorCode: code
    });
  }

  #readOperationItems(operationId: string): PlannedItem[] {
    const rows = this.#database.prepare(`
      SELECT id, asset_id, source_path, destination_path, temporary_path, source_folder_id,
        destination_folder_id, original_file_name, destination_file_name, size_bytes, status
      FROM file_operation_items WHERE operation_id = ? ORDER BY ordinal ASC
    `).all(operationId) as Array<{
      id: string; asset_id: string; source_path: string; destination_path: string;
      temporary_path: string; source_folder_id: string; destination_folder_id: string;
      original_file_name: string; destination_file_name: string; size_bytes: number; status: string;
    }>;
    return rows.map((row) => ({
      id: row.id,
      assetId: row.asset_id,
      sourcePath: row.source_path,
      destinationPath: row.destination_path,
      temporaryPath: row.temporary_path,
      sourceFolderId: row.source_folder_id,
      destinationFolderId: row.destination_folder_id,
      previousFileName: row.original_file_name,
      fileName: row.destination_file_name,
      sizeBytes: row.size_bytes,
      skipped: row.status === 'skipped',
      status: row.status
    }));
  }

  async #recoverItem(item: PlannedItem): Promise<void> {
    const [sourceExists, destinationExists] = await Promise.all([
      exists(this.#fileSystem, item.sourcePath), exists(this.#fileSystem, item.destinationPath)
    ]);
    if (!sourceExists && destinationExists) {
      await this.#transfer(item.destinationPath, item.sourcePath, item.temporaryPath);
    } else if (sourceExists && destinationExists) {
      const [sourceStats, destinationStats] = await Promise.all([
        this.#fileSystem.stat(item.sourcePath), this.#fileSystem.stat(item.destinationPath)
      ]);
      if (sourceStats.size !== destinationStats.size) {
        throw new Error('RECOVERY_DESTINATION_CONFLICT');
      }
      const [sourceHash, destinationHash] = await Promise.all([
        hashFile(item.sourcePath), hashFile(item.destinationPath)
      ]);
      if (sourceHash !== destinationHash) throw new Error('RECOVERY_DESTINATION_CONFLICT');
      await removeIfPresent(this.#fileSystem, item.destinationPath);
    } else if (!sourceExists) {
      throw new Error('RECOVERY_FILES_MISSING');
    }
    await removeIfPresent(this.#fileSystem, item.temporaryPath);
  }

  #setItemStatus(itemId: string, status: string, code: string | null): void {
    this.#database.prepare('UPDATE file_operation_items SET status = ?, error_code = ? WHERE id = ?')
      .run(status, code, itemId);
  }
}

function reserveFileName(original: string, reserved: Set<string>): string {
  const extension = path.extname(original);
  const stem = path.basename(original, extension);
  let candidate = original;
  let index = 1;
  while (reserved.has(normalizeFileName(candidate))) {
    candidate = `${stem} (${index})${extension}`;
    index += 1;
  }
  reserved.add(normalizeFileName(candidate));
  return candidate;
}

function normalizeFileName(value: string): string {
  return value.normalize('NFC').toLocaleLowerCase('en-US');
}

async function hashFile(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

async function exists(fileSystem: FileSystemPort, filePath: string): Promise<boolean> {
  try {
    await fileSystem.stat(filePath);
    return true;
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return false;
    throw error;
  }
}

async function removeIfPresent(fileSystem: FileSystemPort, filePath: string): Promise<void> {
  try {
    await fileSystem.unlink(filePath);
  } catch (error) {
    if (!isNodeError(error, 'ENOENT')) throw error;
  }
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code;
}

function isCopyFallbackError(error: unknown): boolean {
  return ['EXDEV', 'EPERM', 'ENOTSUP', 'EOPNOTSUPP'].some((code) => isNodeError(error, code));
}

function errorCode(error: unknown): string {
  if (error instanceof Error && 'code' in error && typeof error.code === 'string') return error.code;
  if (error instanceof Error && /^[A-Z][A-Z0-9_]+$/.test(error.message)) return error.message;
  return 'FILE_OPERATION_FAILED';
}
