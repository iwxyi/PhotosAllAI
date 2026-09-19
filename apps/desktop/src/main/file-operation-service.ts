import { createHash, randomUUID } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import {
  copyFile,
  link,
  readdir,
  realpath,
  rename,
  stat,
  statfs,
  unlink
} from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  catalogAssetRemovalInputSchema,
  catalogAssetRemovalReportSchema,
  copyCatalogAssetsInputSchema,
  copyCatalogAssetsReportSchema,
  catalogCompanionPreviewSchema,
  fileOperationHistoryItemSchema,
  moveCatalogAssetsInputSchema,
  moveCatalogAssetsReportSchema,
  renameCatalogAssetInputSchema,
  renameCatalogAssetReportSchema,
  renameCatalogAssetsInputSchema,
  renameCatalogAssetsReportSchema,
  undoFileOperationInputSchema,
  undoFileOperationReportSchema,
  type CatalogAssetRemovalInput,
  type CatalogAssetRemovalReport,
  type CopyCatalogAssetsInput,
  type CopyCatalogAssetsReport,
  type CatalogCompanionPreview,
  type FileOperationHistoryItem,
  type MoveCatalogAssetsInput,
  type MoveCatalogAssetsReport,
  type RenameCatalogAssetInput,
  type RenameCatalogAssetReport,
  type RenameCatalogAssetsInput,
  type RenameCatalogAssetsReport,
  type UndoFileOperationInput, type UndoFileOperationReport
} from '@photoallisai/contracts';

type FileSystemPort = {
  copyFile: typeof copyFile;
  link: typeof link;
  readdir: typeof readdir;
  realpath: typeof realpath;
  rename?: typeof rename;
  stat: typeof stat;
  availableBytes?: (directory: string) => Promise<number>;
  unlink: typeof unlink;
};

type SystemTrashPort = {
  trashItem(path: string): Promise<void>;
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
  resultAssetId: string | null;
  modifiedAt?: number;
  catalogManaged?: boolean;
};

type AssetLocationRow = {
  id: string;
  folder_id: string;
  path: string;
  file_name: string;
  size_bytes: number;
};

const nodeFileSystem: FileSystemPort = {
  copyFile, link, readdir, realpath, rename, stat, unlink,
  availableBytes: async (directory) => {
    const stats = await statfs(directory);
    return stats.bavail * stats.bsize;
  }
};

const RAW_EXTENSIONS = new Set(['.dng', '.cr2', '.cr3', '.nef', '.nrw', '.arw', '.raf', '.rw2', '.orf', '.pef']);
const JPEG_EXTENSIONS = new Set(['.jpg', '.jpeg']);
type CompanionFile = { path: string; fileName: string; bytes: number; kind: 'raw' | 'jpeg' | 'xmp'; asset: AssetLocationRow | null; owner: AssetLocationRow };

export class FileOperationService {
  readonly #database: DatabaseSync;
  readonly #fileSystem: FileSystemPort;
  readonly #systemTrash: SystemTrashPort | null;
  readonly #platform: NodeJS.Platform;
  #pending: Promise<void> = Promise.resolve();

  constructor(
    databasePath: string,
    fileSystem: FileSystemPort = nodeFileSystem,
    systemTrash: SystemTrashPort | null = null,
    platform: NodeJS.Platform = process.platform
  ) {
    this.#database = new DatabaseSync(databasePath);
    this.#database.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    this.#fileSystem = fileSystem;
    this.#systemTrash = systemTrash;
    this.#platform = platform;
    this.#migrate();
  }

  close(): void {
    this.#database.close();
  }

  async move(rawInput: MoveCatalogAssetsInput): Promise<MoveCatalogAssetsReport> {
    const input = moveCatalogAssetsInputSchema.parse(rawInput);
    return this.#serialize(() => this.#executeMove(input));
  }

  async copy(rawInput: CopyCatalogAssetsInput): Promise<CopyCatalogAssetsReport> {
    const input = copyCatalogAssetsInputSchema.parse(rawInput);
    return this.#serialize(() => this.#executeCopy(input));
  }

  async previewCompanions(assetIds: string[]): Promise<CatalogCompanionPreview> {
    const companions = await this.#findCompanions([...new Set(assetIds)]);
    return catalogCompanionPreviewSchema.parse({
      files: companions.map((item) => ({ fileName: item.fileName, kind: item.kind, assetId: item.asset?.id ?? null, bytes: item.bytes })),
      totalBytes: companions.reduce((total, item) => total + item.bytes, 0)
    });
  }

  async rename(rawInput: RenameCatalogAssetInput): Promise<RenameCatalogAssetReport> {
    const input = renameCatalogAssetInputSchema.parse(rawInput);
    return this.#serialize(() => this.#executeRename(input));
  }

  async renameMany(rawInput: RenameCatalogAssetsInput): Promise<RenameCatalogAssetsReport> {
    const input = renameCatalogAssetsInputSchema.parse(rawInput);
    return this.#serialize(async () => {
      const reports: RenameCatalogAssetReport[] = [];
      for (const item of input.items) reports.push(await this.#executeRename(item));
      return renameCatalogAssetsReportSchema.parse({
        total: reports.length,
        succeeded: reports.filter((report) => report.status === 'completed').length,
        failed: reports.filter((report) => report.status !== 'completed').length,
        reports
      });
    });
  }

  async removeFromCatalog(rawInput: CatalogAssetRemovalInput): Promise<CatalogAssetRemovalReport> {
    const input = catalogAssetRemovalInputSchema.parse(rawInput);
    return this.#serialize(() => this.#executeRemoval(input, 'remove'));
  }

  async moveToSystemTrash(rawInput: CatalogAssetRemovalInput): Promise<CatalogAssetRemovalReport> {
    const input = catalogAssetRemovalInputSchema.parse(rawInput);
    return this.#serialize(() => this.#executeRemoval(input, 'trash'));
  }

  async undo(rawInput: UndoFileOperationInput): Promise<UndoFileOperationReport> {
    const input = undoFileOperationInputSchema.parse(rawInput);
    return this.#serialize(() => this.#executeUndo(input.operationId));
  }

  getUndoAssetIds(operationId: string): string[] {
    undoFileOperationInputSchema.parse({ operationId });
    return this.#readOperationItems(operationId)
      .filter((item) => !item.skipped && item.catalogManaged !== false)
      .map((item) => item.assetId);
  }

  listHistory(limit = 100): FileOperationHistoryItem[] {
    const rows = this.#database.prepare(`
      SELECT operations.id, operations.kind, operations.status, operations.created_at,
        operations.completed_at, operations.error_code,
        COUNT(CASE WHEN items.catalog_managed = 1 THEN 1 END) AS total,
        SUM(CASE WHEN items.catalog_managed = 1 AND items.status IN ('moved', 'copied', 'removed', 'trashed', 'skipped', 'undone') THEN 1 ELSE 0 END) AS succeeded,
        SUM(CASE WHEN items.catalog_managed = 1 AND items.status IN ('failed', 'compensation_failed') THEN 1 ELSE 0 END) AS failed,
        CASE WHEN operations.status = 'completed' AND operations.kind IN ('move', 'rename')
          AND EXISTS (
            SELECT 1 FROM file_operation_items active_items
            WHERE active_items.operation_id = operations.id AND active_items.catalog_managed = 1
              AND active_items.status <> 'skipped'
          )
          AND NOT EXISTS (
            SELECT 1 FROM file_operation_items current_items
            WHERE current_items.operation_id = operations.id AND current_items.catalog_managed = 1
              AND current_items.status <> 'skipped' AND NOT EXISTS (
                SELECT 1 FROM assets
                WHERE assets.id = current_items.asset_id AND assets.path = current_items.destination_path
                  AND assets.removed_at IS NULL
              )
          ) THEN 1 ELSE 0 END AS undoable
      FROM file_operations operations
      LEFT JOIN file_operation_items items ON items.operation_id = operations.id
      GROUP BY operations.id
      ORDER BY operations.created_at DESC
      LIMIT ?
    `).all(Math.max(1, Math.min(limit, 500))) as Array<{
      id: string; kind: FileOperationHistoryItem['kind']; status: FileOperationHistoryItem['status'];
      created_at: number; completed_at: number | null; error_code: string | null;
      total: number; succeeded: number; failed: number; undoable: number;
    }>;
    const names = this.#database.prepare(`
      SELECT destination_file_name FROM file_operation_items
      WHERE operation_id = ? AND catalog_managed = 1 ORDER BY ordinal ASC LIMIT 4
    `);
    return rows.map((row) => fileOperationHistoryItemSchema.parse({
      id: row.id,
      kind: row.kind,
      status: row.status,
      total: row.total,
      succeeded: row.succeeded ?? 0,
      failed: row.failed ?? 0,
      fileNames: (names.all(row.id) as { destination_file_name: string }[])
        .map((item) => item.destination_file_name),
      createdAt: row.created_at,
      completedAt: row.completed_at,
      errorCode: row.error_code,
      undoable: row.undoable === 1
    }));
  }

  async #serialize<Result>(operation: () => Promise<Result>): Promise<Result> {
    const previous = this.#pending;
    let release!: () => void;
    this.#pending = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  async recoverInterruptedOperations(
    onLocationChange?: (change: { assetId: string; previousPath: string; path: string; previousFileName: string; fileName: string }) => Promise<void>
  ): Promise<number> {
    const operations = this.#database.prepare(`
      SELECT id, kind, status FROM file_operations WHERE status IN ('planned', 'executing', 'compensating', 'undoing')
      ORDER BY created_at ASC
    `).all() as { id: string; kind: FileOperationHistoryItem['kind']; status: string }[];
    for (const operation of operations) {
      const items = this.#readOperationItems(operation.id).reverse();
      if (operation.status === 'undoing') {
        const changed = await this.#recoverInterruptedUndoOperation(operation.id, items);
        if (onLocationChange) await Promise.allSettled(changed.map(onLocationChange));
        continue;
      }
      if (operation.kind === 'trash') {
        await this.#recoverInterruptedTrashOperation(operation.id, items);
        continue;
      }
      let recovered = true;
      for (const item of items) {
        const recoverableStatuses = operation.kind === 'copy'
          ? ['copying', 'copied', 'compensation_failed']
          : ['moving', 'moved', 'compensation_failed'];
        if (item.skipped || !recoverableStatuses.includes(item.status)) continue;
        try {
          if (operation.kind === 'copy') await this.#recoverCopyItem(item);
          else if (operation.kind === 'rename') await this.#recoverRenameItem(item);
          else await this.#recoverItem(item);
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

  async #executeUndo(operationId: string): Promise<UndoFileOperationReport> {
    const operation = this.#database.prepare(`
      SELECT kind, status FROM file_operations WHERE id = ?
    `).get(operationId) as { kind: FileOperationHistoryItem['kind']; status: string } | undefined;
    if (!operation || !['move', 'rename'].includes(operation.kind) || operation.status !== 'completed') {
      throw new Error('FILE_OPERATION_NOT_UNDOABLE');
    }
    const items = this.#readOperationItems(operationId);
    const activeItems = items.filter((item) => !item.skipped);
    if (activeItems.length === 0) throw new Error('FILE_OPERATION_NOT_UNDOABLE');
    const catalogItems = activeItems.filter((item) => item.catalogManaged !== false);
    this.#assertNoActiveTasks(catalogItems.map((item) => item.assetId));
    for (const item of activeItems) await this.#assertUndoReady(item, operation.kind);
    await this.#assertUndoSpace(activeItems);

    this.#database.prepare(`
      UPDATE file_operations SET status = 'undoing', completed_at = NULL, error_code = NULL
      WHERE id = ? AND status = 'completed'
    `).run(operationId);
    const completed: PlannedItem[] = [];
    try {
      for (const item of [...activeItems].reverse()) {
        this.#setItemStatus(item.id, 'undoing', null);
        await this.#reverseItem(item, operation.kind);
        completed.push(item);
        this.#setItemStatus(item.id, 'undone', null);
      }
      this.#commitUndo(operationId, activeItems);
      return this.#undoReport(operationId, activeItems, 'completed', false, null);
    } catch (error) {
      const code = errorCode(error);
      let rolledBack = true;
      for (const item of completed.reverse()) {
        try {
          await this.#forwardItem(item, operation.kind);
          this.#setItemStatus(item.id, 'moved', null);
        } catch (compensationError) {
          rolledBack = false;
          this.#setItemStatus(item.id, 'compensation_failed', errorCode(compensationError));
        }
      }
      if (rolledBack) {
        for (const item of activeItems) this.#setItemStatus(item.id, 'moved', null);
      }
      this.#database.prepare(`
        UPDATE file_operations SET status = ?, completed_at = ?, error_code = ? WHERE id = ?
      `).run(rolledBack ? 'completed' : 'compensation_failed', Date.now(), code, operationId);
      return this.#undoReport(operationId, activeItems, 'failed', rolledBack, code);
    }
  }

  async #assertUndoReady(item: PlannedItem, kind: FileOperationHistoryItem['kind']): Promise<void> {
    if (this.#platform === 'win32' && (item.sourcePath.length >= 260 || undoTemporaryPath(item).length >= 260)) {
      throw new Error('DESTINATION_PATH_TOO_LONG');
    }
    if (item.catalogManaged !== false) {
      const asset = this.#database.prepare(`
        SELECT path FROM assets WHERE id = ? AND removed_at IS NULL
      `).get(item.assetId) as { path: string } | undefined;
      if (!asset || asset.path !== item.destinationPath) throw new Error('FILE_OPERATION_SUPERSEDED');
    }
    const sourceDirectory = path.dirname(item.sourcePath);
    if (!(await this.#fileSystem.stat(sourceDirectory)).isDirectory()) throw new Error('UNDO_SOURCE_DIRECTORY_MISSING');
    if (kind === 'rename' && normalizeFileName(item.previousFileName) === normalizeFileName(item.fileName)) {
      const entries = await this.#fileSystem.readdir(sourceDirectory);
      if (!entries.includes(item.fileName) || entries.includes(item.previousFileName)) {
        throw new Error('UNDO_SOURCE_CONFLICT');
      }
      return;
    }
    const [sourceExists, destinationExists] = await Promise.all([
      exists(this.#fileSystem, item.sourcePath), exists(this.#fileSystem, item.destinationPath)
    ]);
    if (sourceExists) throw new Error('UNDO_SOURCE_CONFLICT');
    if (!destinationExists) throw new Error('UNDO_DESTINATION_MISSING');
  }

  async #assertUndoSpace(items: PlannedItem[]): Promise<void> {
    if (!this.#fileSystem.availableBytes) return;
    const bytesByDirectory = new Map<string, number>();
    for (const item of items) {
      const targetDirectory = path.dirname(item.sourcePath);
      const [sourceStats, targetStats] = await Promise.all([
        this.#fileSystem.stat(item.destinationPath), this.#fileSystem.stat(targetDirectory)
      ]);
      if (sourceStats.dev === targetStats.dev) continue;
      bytesByDirectory.set(targetDirectory, (bytesByDirectory.get(targetDirectory) ?? 0) + sourceStats.size);
    }
    for (const [directory, bytes] of bytesByDirectory) await this.#assertAvailableSpace(directory, bytes);
  }

  async #reverseItem(item: PlannedItem, kind: FileOperationHistoryItem['kind']): Promise<void> {
    if (kind === 'rename') await this.#moveRenameItem(item, true);
    else await this.#transfer(item.destinationPath, item.sourcePath, undoTemporaryPath(item));
  }

  async #forwardItem(item: PlannedItem, kind: FileOperationHistoryItem['kind']): Promise<void> {
    if (kind === 'rename') await this.#moveRenameItem(item, false);
    else await this.#transfer(item.sourcePath, item.destinationPath, item.temporaryPath);
  }

  #commitUndo(operationId: string, items: PlannedItem[]): void {
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      const updateAsset = this.#database.prepare(`
        UPDATE assets SET folder_id = ?, path = ?, file_name = ?
        WHERE id = ? AND path = ? AND removed_at IS NULL
      `);
      const markItem = this.#database.prepare(`
        UPDATE file_operation_items SET status = 'undone', error_code = NULL WHERE id = ?
      `);
      for (const item of items) {
        if (item.catalogManaged !== false) {
          const result = updateAsset.run(
            item.sourceFolderId, item.sourcePath, item.previousFileName, item.assetId, item.destinationPath
          );
          if (result.changes !== 1) throw new Error('CATALOG_CONCURRENT_CHANGE');
        }
        markItem.run(item.id);
      }
      this.#database.prepare(`
        UPDATE file_operations SET status = 'undone', completed_at = ?, error_code = NULL WHERE id = ?
      `).run(Date.now(), operationId);
      this.#database.exec('COMMIT');
    } catch (error) {
      this.#database.exec('ROLLBACK');
      throw error;
    }
  }

  #undoReport(
    operationId: string,
    items: PlannedItem[],
    status: 'completed' | 'failed',
    rolledBack: boolean,
    code: string | null
  ): UndoFileOperationReport {
    const catalogItems = items.filter((item) => item.catalogManaged !== false);
    return undoFileOperationReportSchema.parse({
      operationId,
      status,
      total: catalogItems.length,
      undone: status === 'completed' ? catalogItems.length : 0,
      rolledBack,
      files: status === 'completed' ? catalogItems.map((item) => ({
        assetId: item.assetId,
        previousFileName: item.fileName,
        fileName: item.previousFileName
      })) : [],
      errorCode: code
    });
  }

  async #recoverInterruptedUndoOperation(
    operationId: string,
    items: PlannedItem[]
  ): Promise<Array<{ assetId: string; previousPath: string; path: string; previousFileName: string; fileName: string }>> {
    const operation = this.#database.prepare('SELECT kind FROM file_operations WHERE id = ?')
      .get(operationId) as { kind: FileOperationHistoryItem['kind'] };
    try {
      for (const item of items) {
        if (item.skipped) continue;
        if (operation.kind === 'rename' && normalizeFileName(item.previousFileName) === normalizeFileName(item.fileName)) {
          const entries = await this.#fileSystem.readdir(path.dirname(item.sourcePath));
          const sourceExists = entries.includes(item.previousFileName);
          const destinationExists = entries.includes(item.fileName);
          if (!sourceExists && destinationExists) await this.#reverseItem(item, operation.kind);
          else if (!sourceExists || destinationExists) throw new Error('UNDO_RECOVERY_CONFLICT');
        } else {
          const sourceExists = await exists(this.#fileSystem, item.sourcePath);
          const destinationExists = await exists(this.#fileSystem, item.destinationPath);
          if (!sourceExists && destinationExists) await this.#reverseItem(item, operation.kind);
          else if (!sourceExists || destinationExists) throw new Error('UNDO_RECOVERY_CONFLICT');
        }
        this.#setItemStatus(item.id, 'undone', null);
      }
      const activeItems = items.filter((item) => !item.skipped);
      this.#commitUndo(operationId, activeItems);
      return activeItems.filter((item) => item.catalogManaged !== false).map((item) => ({
        assetId: item.assetId,
        previousPath: item.destinationPath,
        path: item.sourcePath,
        previousFileName: item.fileName,
        fileName: item.previousFileName
      }));
    } catch (error) {
      this.#database.prepare(`
        UPDATE file_operations SET status = 'compensation_failed', completed_at = ?, error_code = ? WHERE id = ?
      `).run(Date.now(), errorCode(error), operationId);
      return [];
    }
  }

  #migrate(): void {
    const existing = this.#database.prepare(`
      SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'file_operations'
    `).get() as { sql: string } | undefined;
    if (existing && !existing.sql.includes("'trash'")) this.#upgradeOperationTables();
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS file_operations (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK(kind IN ('move', 'copy', 'rename', 'remove', 'trash')),
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
        result_asset_id TEXT,
        status TEXT NOT NULL,
        error_code TEXT,
        UNIQUE(operation_id, ordinal)
      );
      CREATE INDEX IF NOT EXISTS file_operation_items_operation_idx
        ON file_operation_items(operation_id, ordinal);
    `);
    const columns = this.#database.prepare('PRAGMA table_info(file_operation_items)').all() as { name: string }[];
    if (!columns.some((column) => column.name === 'catalog_managed')) {
      this.#database.exec('ALTER TABLE file_operation_items ADD COLUMN catalog_managed INTEGER NOT NULL DEFAULT 1 CHECK(catalog_managed IN (0, 1))');
    }
  }

  #upgradeOperationTables(): void {
    const itemColumns = this.#database.prepare('PRAGMA table_info(file_operation_items)').all() as { name: string }[];
    const resultAssetExpression = itemColumns.some((column) => column.name === 'result_asset_id')
      ? 'result_asset_id'
      : 'NULL';
    this.#database.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE file_operations_new (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK(kind IN ('move', 'copy', 'rename', 'remove', 'trash')),
        status TEXT NOT NULL,
        target_folder_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        completed_at INTEGER,
        error_code TEXT
      );
      CREATE TABLE file_operation_items_new (
        id TEXT PRIMARY KEY,
        operation_id TEXT NOT NULL REFERENCES file_operations_new(id) ON DELETE CASCADE,
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
        result_asset_id TEXT,
        status TEXT NOT NULL,
        error_code TEXT,
        UNIQUE(operation_id, ordinal)
      );
      INSERT INTO file_operations_new SELECT * FROM file_operations;
      INSERT INTO file_operation_items_new (
        id, operation_id, ordinal, asset_id, source_folder_id, destination_folder_id,
        source_path, destination_path, temporary_path, original_file_name,
        destination_file_name, size_bytes, result_asset_id, status, error_code
      ) SELECT id, operation_id, ordinal, asset_id, source_folder_id, destination_folder_id,
        source_path, destination_path, temporary_path, original_file_name,
        destination_file_name, size_bytes, ${resultAssetExpression}, status, error_code FROM file_operation_items;
      DROP TABLE file_operation_items;
      DROP TABLE file_operations;
      ALTER TABLE file_operations_new RENAME TO file_operations;
      ALTER TABLE file_operation_items_new RENAME TO file_operation_items;
      CREATE INDEX file_operation_items_operation_idx ON file_operation_items(operation_id, ordinal);
      COMMIT;
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

  async #executeCopy(input: CopyCatalogAssetsInput): Promise<CopyCatalogAssetsReport> {
    const operationId = randomUUID();
    let items: PlannedItem[] = [];
    const completed: PlannedItem[] = [];
    try {
      items = await this.#planCopy(operationId, input);
      this.#database.prepare('UPDATE file_operations SET status = ? WHERE id = ?').run('executing', operationId);
      for (const item of items) {
        this.#setItemStatus(item.id, 'copying', null);
        await this.#copyVerified(item.sourcePath, item.destinationPath, item.temporaryPath);
        const copiedStats = await this.#fileSystem.stat(item.destinationPath);
        item.sizeBytes = copiedStats.size;
        item.modifiedAt = Math.trunc(copiedStats.mtimeMs);
        completed.push(item);
        this.#setItemStatus(item.id, 'copied', null);
      }
      this.#commitCopies(operationId, completed);
      return this.#copyReport(operationId, items, 'completed', false, null);
    } catch (error) {
      const code = errorCode(error);
      let rolledBack = true;
      if (items.length > 0) {
        this.#database.prepare('UPDATE file_operations SET status = ?, error_code = ? WHERE id = ?')
          .run('compensating', code, operationId);
      }
      for (const item of completed.reverse()) {
        try {
          await removeIfPresent(this.#fileSystem, item.destinationPath);
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
      return this.#copyReport(operationId, items, 'failed', rolledBack, code);
    }
  }

  async #executeRename(input: RenameCatalogAssetInput): Promise<RenameCatalogAssetReport> {
    const operationId = randomUUID();
    let item: PlannedItem | null = null;
    let completed = false;
    try {
      item = await this.#planRename(operationId, input);
      this.#database.prepare('UPDATE file_operations SET status = ? WHERE id = ?').run('executing', operationId);
      this.#setItemStatus(item.id, 'moving', null);
      await this.#moveRenameItem(item, false);
      completed = true;
      this.#setItemStatus(item.id, 'moved', null);
      this.#commitCatalog(operationId, [item]);
      return renameCatalogAssetReportSchema.parse({
        operationId, status: 'completed', assetId: item.assetId,
        previousFileName: item.previousFileName, fileName: item.fileName,
        rolledBack: false, errorCode: null
      });
    } catch (error) {
      const code = errorCode(error);
      let rolledBack = true;
      if (item) {
        this.#database.prepare('UPDATE file_operations SET status = ?, error_code = ? WHERE id = ?')
          .run('compensating', code, operationId);
        if (completed) {
          try {
            await this.#moveRenameItem(item, true);
            this.#setItemStatus(item.id, 'rolled_back', null);
          } catch (compensationError) {
            rolledBack = false;
            this.#setItemStatus(item.id, 'compensation_failed', errorCode(compensationError));
          }
        }
        this.#database.prepare(`
          UPDATE file_operations SET status = ?, completed_at = ?, error_code = ? WHERE id = ?
        `).run(rolledBack ? 'failed' : 'compensation_failed', Date.now(), code, operationId);
      }
      if (!item) throw error;
      return renameCatalogAssetReportSchema.parse({
        operationId, status: 'failed', assetId: item.assetId,
        previousFileName: item.previousFileName, fileName: item.fileName,
        rolledBack, errorCode: code
      });
    }
  }

  async #executeRemoval(
    input: CatalogAssetRemovalInput,
    kind: 'remove' | 'trash'
  ): Promise<CatalogAssetRemovalReport> {
    if (kind === 'trash' && !this.#systemTrash) throw new Error('SYSTEM_TRASH_UNAVAILABLE');
    const operationId = randomUUID();
    const items = this.#planRemoval(operationId, input, kind);
    if (kind === 'remove') {
      this.#database.exec('BEGIN IMMEDIATE');
      try {
        const now = Date.now();
        const markRemoved = this.#database.prepare(`
          UPDATE assets SET removed_at = ?, trashed_at = NULL WHERE id = ? AND removed_at IS NULL
        `);
        const markItem = this.#database.prepare(`
          UPDATE file_operation_items SET status = 'removed', error_code = NULL WHERE id = ?
        `);
        for (const item of items) {
          if (markRemoved.run(now, item.assetId).changes !== 1) throw new Error('CATALOG_CONCURRENT_CHANGE');
          markItem.run(item.id);
        }
        this.#database.prepare(`
          UPDATE file_operations SET status = 'completed', completed_at = ?, error_code = NULL WHERE id = ?
        `).run(now, operationId);
        this.#database.exec('COMMIT');
      } catch (error) {
        this.#database.exec('ROLLBACK');
        throw error;
      }
      return catalogAssetRemovalReportSchema.parse({
        operationId, kind, status: 'completed', total: items.length,
        succeeded: items.length, failed: 0, failures: []
      });
    }

    this.#database.prepare('UPDATE file_operations SET status = ? WHERE id = ?').run('executing', operationId);
    const failures: { assetId: string; errorCode: string }[] = [];
    let succeeded = 0;
    for (const item of items) {
      this.#setItemStatus(item.id, 'trashing', null);
      let physicallyTrashed = false;
      try {
        await this.#systemTrash!.trashItem(item.sourcePath);
        physicallyTrashed = true;
        this.#setItemStatus(item.id, 'trashed', null);
        this.#markAssetRemoved(item.assetId, true);
        succeeded += 1;
      } catch (error) {
        const code = errorCode(error);
        if (physicallyTrashed) {
          this.#database.prepare('UPDATE file_operations SET error_code = ? WHERE id = ?')
            .run('CATALOG_COMMIT_PENDING', operationId);
          throw error;
        }
        failures.push({ assetId: item.assetId, errorCode: code });
        this.#setItemStatus(item.id, 'failed', code);
      }
    }
    const status = succeeded === items.length ? 'completed' : succeeded === 0 ? 'failed' : 'partial';
    const operationError = failures.length > 0 ? 'ITEM_FAILURES' : null;
    this.#database.prepare(`
      UPDATE file_operations SET status = ?, completed_at = ?, error_code = ? WHERE id = ?
    `).run(status, Date.now(), operationError, operationId);
    return catalogAssetRemovalReportSchema.parse({
      operationId, kind, status, total: items.length,
      succeeded, failed: failures.length, failures
    });
  }

  #planRemoval(
    operationId: string,
    input: CatalogAssetRemovalInput,
    kind: 'remove' | 'trash'
  ): PlannedItem[] {
    const assetIds = [...new Set(input.assetIds)];
    if (assetIds.length !== input.assetIds.length) throw new Error('DUPLICATE_ASSET_ID');
    const placeholders = assetIds.map(() => '?').join(', ');
    const rows = this.#database.prepare(`
      SELECT id, folder_id, path, file_name, size_bytes FROM assets
      WHERE removed_at IS NULL AND id IN (${placeholders})
    `).all(...assetIds) as AssetLocationRow[];
    if (rows.length !== assetIds.length) throw new Error('CATALOG_ASSET_SET_MISMATCH');
    this.#assertNoActiveTasks(assetIds);
    const byId = new Map(rows.map((row) => [row.id, row]));
    const items = assetIds.map((assetId): PlannedItem => {
      const asset = byId.get(assetId)!;
      return {
        id: randomUUID(), assetId, sourcePath: asset.path, destinationPath: asset.path,
        temporaryPath: asset.path, sourceFolderId: asset.folder_id,
        destinationFolderId: asset.folder_id, previousFileName: asset.file_name,
        fileName: asset.file_name, sizeBytes: asset.size_bytes, skipped: false,
        status: 'planned', resultAssetId: null
      };
    });
    this.#persistPlan(operationId, kind, items[0]!.sourceFolderId, items);
    return items;
  }

  #assertNoActiveTasks(assetIds: string[]): void {
    const taskTable = this.#database.prepare(`
      SELECT 1 AS value FROM sqlite_master WHERE type = 'table' AND name = 'tasks'
    `).get() as { value: number } | undefined;
    if (!taskTable) return;
    const placeholders = assetIds.map(() => '?').join(', ');
    const active = this.#database.prepare(`
      SELECT COUNT(*) AS value FROM tasks
      WHERE asset_id IN (${placeholders})
        AND status IN ('draft', 'queued', 'preparing', 'uploading', 'processing', 'downloading', 'saving')
    `).get(...assetIds) as { value: number };
    if (active.value > 0) throw new Error('ASSET_HAS_ACTIVE_TASKS');
  }

  #markAssetRemoved(assetId: string, trashed: boolean): void {
    const now = Date.now();
    const result = this.#database.prepare(`
      UPDATE assets SET removed_at = ?, trashed_at = ? WHERE id = ? AND removed_at IS NULL
    `).run(now, trashed ? now : null, assetId);
    if (result.changes !== 1) throw new Error('CATALOG_CONCURRENT_CHANGE');
  }

  async #planCopy(operationId: string, input: CopyCatalogAssetsInput): Promise<PlannedItem[]> {
    const assetIds = [...new Set(input.assetIds)];
    if (assetIds.length !== input.assetIds.length) throw new Error('DUPLICATE_ASSET_ID');
    const target = this.#database.prepare('SELECT id, path FROM folders WHERE id = ? AND removed_at IS NULL')
      .get(input.targetFolderId) as { id: string; path: string } | undefined;
    if (!target) throw new Error('TARGET_FOLDER_NOT_FOUND');
    const targetPath = await this.#fileSystem.realpath(target.path);
    if (!(await this.#fileSystem.stat(targetPath)).isDirectory()) throw new Error('TARGET_NOT_DIRECTORY');
    const placeholders = assetIds.map(() => '?').join(', ');
    const rows = this.#database.prepare(`
      SELECT id, folder_id, path, file_name, size_bytes FROM assets
      WHERE removed_at IS NULL AND id IN (${placeholders})
    `).all(...assetIds) as AssetLocationRow[];
    if (rows.length !== assetIds.length) throw new Error('CATALOG_ASSET_SET_MISMATCH');
    const companions = input.includeCompanions ? await this.#findCompanions(assetIds) : [];
    const operationRows = [...rows, ...companions.flatMap((item) => item.asset ? [item.asset] : [])];
    const uniqueRows = [...new Map(operationRows.map((row) => [row.id, row])).values()];
    const reserved = new Set((await this.#fileSystem.readdir(targetPath)).map(normalizeFileName));
    const destinationNames = reserveGroupedFileNames([
      ...uniqueRows.map((asset) => ({ path: asset.path, fileName: asset.file_name })),
      ...companions.filter((item) => !item.asset).map((item) => ({ path: item.path, fileName: item.fileName }))
    ], reserved);
    const items = uniqueRows.map((asset): PlannedItem => {
      const fileName = destinationNames.get(asset.path)!;
      const itemId = randomUUID();
      return {
        id: itemId, assetId: asset.id, sourcePath: asset.path,
        destinationPath: path.join(targetPath, fileName),
        temporaryPath: path.join(targetPath, `.photoallisai-${operationId}-${itemId}.tmp`),
        sourceFolderId: asset.folder_id, destinationFolderId: target.id,
        previousFileName: asset.file_name, fileName, sizeBytes: asset.size_bytes,
        skipped: false, status: 'planned', resultAssetId: randomUUID()
      };
    });
    for (const companion of companions.filter((item) => !item.asset)) {
      const itemId = randomUUID();
      const fileName = destinationNames.get(companion.path)!;
      items.push({
        id: itemId, assetId: `sidecar:${createHash('sha256').update(companion.path).digest('hex').slice(0, 24)}`,
        sourcePath: companion.path, destinationPath: path.join(targetPath, fileName),
        temporaryPath: path.join(targetPath, `.photoallisai-${operationId}-${itemId}.tmp`),
        sourceFolderId: companion.owner.folder_id, destinationFolderId: target.id,
        previousFileName: companion.fileName, fileName, sizeBytes: companion.bytes,
        skipped: false, status: 'planned', resultAssetId: null, catalogManaged: false
      });
    }
    this.#assertDestinationPaths(items);
    await this.#assertAvailableSpace(targetPath, items.reduce((total, item) => total + item.sizeBytes, 0));
    this.#persistPlan(operationId, 'copy', target.id, items);
    return items;
  }

  async #planRename(operationId: string, input: RenameCatalogAssetInput): Promise<PlannedItem> {
    const asset = this.#database.prepare(`
      SELECT id, folder_id, path, file_name, size_bytes FROM assets WHERE id = ? AND removed_at IS NULL
    `).get(input.assetId) as AssetLocationRow | undefined;
    if (!asset) throw new Error('CATALOG_ASSET_NOT_FOUND');
    const fileName = validateRenamedFileName(input.fileName, asset.file_name);
    if (fileName === asset.file_name) throw new Error('FILE_NAME_UNCHANGED');
    const directory = await this.#fileSystem.realpath(path.dirname(asset.path));
    const entries = await this.#fileSystem.readdir(directory);
    if (entries.some((entry) => entry !== asset.file_name && normalizeFileName(entry) === normalizeFileName(fileName))) {
      throw new Error('EEXIST');
    }
    const itemId = randomUUID();
    const item: PlannedItem = {
      id: itemId, assetId: asset.id, sourcePath: asset.path,
      destinationPath: path.join(directory, fileName),
      temporaryPath: path.join(directory, `.photoallisai-${operationId}-${itemId}.tmp`),
      sourceFolderId: asset.folder_id, destinationFolderId: asset.folder_id,
      previousFileName: asset.file_name, fileName, sizeBytes: asset.size_bytes,
      skipped: false, status: 'planned', resultAssetId: null
    };
    this.#assertDestinationPaths([item]);
    this.#persistPlan(operationId, 'rename', asset.folder_id, [item]);
    return item;
  }

  #persistPlan(
    operationId: string,
    kind: 'copy' | 'rename' | 'remove' | 'trash',
    targetFolderId: string,
    items: PlannedItem[]
  ): void {
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      this.#database.prepare(`
        INSERT INTO file_operations (id, kind, status, target_folder_id, created_at)
        VALUES (?, ?, 'planned', ?, ?)
      `).run(operationId, kind, targetFolderId, Date.now());
      const insertItem = this.#database.prepare(`
        INSERT INTO file_operation_items (
          id, operation_id, ordinal, asset_id, source_folder_id, destination_folder_id,
          source_path, destination_path, temporary_path, original_file_name,
          destination_file_name, size_bytes, result_asset_id, status, catalog_managed
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'planned', ?)
      `);
      items.forEach((item, ordinal) => insertItem.run(
        item.id, operationId, ordinal, item.assetId, item.sourceFolderId,
        item.destinationFolderId, item.sourcePath, item.destinationPath, item.temporaryPath,
        item.previousFileName, item.fileName, item.sizeBytes, item.resultAssetId, item.catalogManaged === false ? 0 : 1
      ));
      this.#database.exec('COMMIT');
    } catch (error) {
      this.#database.exec('ROLLBACK');
      throw error;
    }
  }

  async #plan(operationId: string, input: MoveCatalogAssetsInput): Promise<PlannedItem[]> {
    const assetIds = [...new Set(input.assetIds)];
    if (assetIds.length !== input.assetIds.length) throw new Error('DUPLICATE_ASSET_ID');
    const target = this.#database.prepare('SELECT id, path FROM folders WHERE id = ? AND removed_at IS NULL')
      .get(input.targetFolderId) as { id: string; path: string } | undefined;
    if (!target) throw new Error('TARGET_FOLDER_NOT_FOUND');
    const targetPath = await this.#fileSystem.realpath(target.path);
    const targetStats = await this.#fileSystem.stat(targetPath);
    if (!targetStats.isDirectory()) throw new Error('TARGET_NOT_DIRECTORY');

    const placeholders = assetIds.map(() => '?').join(', ');
    const rows = this.#database.prepare(`
      SELECT id, folder_id, path, file_name, size_bytes FROM assets
      WHERE removed_at IS NULL AND id IN (${placeholders})
    `).all(...assetIds) as AssetLocationRow[];
    if (rows.length !== assetIds.length) throw new Error('CATALOG_ASSET_SET_MISMATCH');
    const companions = input.includeCompanions ? await this.#findCompanions(assetIds) : [];
    const operationRows = [...rows, ...companions.flatMap((item) => item.asset ? [item.asset] : [])];
    const uniqueRows = [...new Map(operationRows.map((row) => [row.id, row])).values()];
    const reserved = new Set((await this.#fileSystem.readdir(targetPath)).map(normalizeFileName));
    const movingSources = [
      ...uniqueRows.filter((asset) => asset.folder_id !== target.id).map((asset) => ({ path: asset.path, fileName: asset.file_name })),
      ...companions.filter((item) => !item.asset && item.owner.folder_id !== target.id).map((item) => ({ path: item.path, fileName: item.fileName }))
    ];
    const destinationNames = reserveGroupedFileNames(movingSources, reserved);
    const items = uniqueRows.map((asset): PlannedItem => {
      const skipped = asset.folder_id === target.id;
      const fileName = skipped ? asset.file_name : destinationNames.get(asset.path)!;
      const itemId = randomUUID();
      return {
        id: itemId,
        assetId: asset.id,
        sourcePath: asset.path,
        destinationPath: skipped ? asset.path : path.join(targetPath, fileName),
        temporaryPath: path.join(targetPath, `.photoallisai-${operationId}-${itemId}.tmp`),
        sourceFolderId: asset.folder_id,
        destinationFolderId: target.id,
        previousFileName: asset.file_name,
        fileName,
        sizeBytes: asset.size_bytes,
        skipped,
        status: skipped ? 'skipped' : 'planned',
        resultAssetId: null
      };
    });
    for (const companion of companions.filter((item) => !item.asset)) {
      const skipped = companion.owner.folder_id === target.id;
      const fileName = skipped ? companion.fileName : destinationNames.get(companion.path)!;
      const itemId = randomUUID();
      items.push({
        id: itemId, assetId: `sidecar:${createHash('sha256').update(companion.path).digest('hex').slice(0, 24)}`,
        sourcePath: companion.path, destinationPath: skipped ? companion.path : path.join(targetPath, fileName),
        temporaryPath: path.join(targetPath, `.photoallisai-${operationId}-${itemId}.tmp`),
        sourceFolderId: companion.owner.folder_id, destinationFolderId: target.id,
        previousFileName: companion.fileName, fileName, sizeBytes: companion.bytes,
        skipped, status: skipped ? 'skipped' : 'planned', resultAssetId: null, catalogManaged: false
      });
    }
    this.#assertDestinationPaths(items.filter((item) => !item.skipped));

    const crossVolumeBytes = (await Promise.all(items.filter((item) => !item.skipped).map(async (item) => {
      const sourceStats = await this.#fileSystem.stat(item.sourcePath);
      return sourceStats.dev === targetStats.dev ? 0 : item.sizeBytes;
    }))).reduce((total, size) => total + size, 0);
    await this.#assertAvailableSpace(targetPath, crossVolumeBytes);

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
          destination_file_name, size_bytes, result_asset_id, status, catalog_managed
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      items.forEach((item, ordinal) => insertItem.run(
        item.id, operationId, ordinal, item.assetId, item.sourceFolderId,
        item.destinationFolderId, item.sourcePath, item.destinationPath, item.temporaryPath,
        item.previousFileName, item.fileName, item.sizeBytes, item.resultAssetId,
        item.skipped ? 'skipped' : 'planned', item.catalogManaged === false ? 0 : 1
      ));
      this.#database.exec('COMMIT');
    } catch (error) {
      this.#database.exec('ROLLBACK');
      throw error;
    }
    return items;
  }

  async #assertAvailableSpace(directory: string, requiredBytes: number): Promise<void> {
    if (requiredBytes <= 0 || !this.#fileSystem.availableBytes) return;
    const availableBytes = await this.#fileSystem.availableBytes(directory);
    if (!Number.isFinite(availableBytes) || availableBytes < requiredBytes) {
      throw new Error('INSUFFICIENT_DISK_SPACE');
    }
  }

  async #findCompanions(assetIds: string[]): Promise<CompanionFile[]> {
    if (assetIds.length === 0) return [];
    const placeholders = assetIds.map(() => '?').join(', ');
    const selected = this.#database.prepare(`
      SELECT id, folder_id, path, file_name, size_bytes FROM assets
      WHERE removed_at IS NULL AND id IN (${placeholders})
    `).all(...assetIds) as AssetLocationRow[];
    if (selected.length !== assetIds.length) throw new Error('CATALOG_ASSET_SET_MISMATCH');
    const selectedPaths = new Set(selected.map((item) => item.path));
    const found = new Map<string, CompanionFile>();
    const entriesByDirectory = new Map<string, string[]>();
    const assetByPath = this.#database.prepare(`
      SELECT id, folder_id, path, file_name, size_bytes FROM assets
      WHERE removed_at IS NULL AND path = ?
    `);
    for (const owner of selected) {
      const extension = path.extname(owner.file_name).toLocaleLowerCase('en-US');
      if (!RAW_EXTENSIONS.has(extension) && !JPEG_EXTENSIONS.has(extension)) continue;
      const directory = path.dirname(owner.path);
      let entries = entriesByDirectory.get(directory);
      if (!entries) {
        entries = await this.#fileSystem.readdir(directory);
        entriesByDirectory.set(directory, entries);
      }
      const stem = path.basename(owner.file_name, path.extname(owner.file_name)).normalize('NFC').toLocaleLowerCase('en-US');
      for (const entry of entries) {
        const entryExtension = path.extname(entry).toLocaleLowerCase('en-US');
        const entryStem = path.basename(entry, path.extname(entry)).normalize('NFC').toLocaleLowerCase('en-US');
        if (entryStem !== stem) continue;
        const kind = entryExtension === '.xmp'
          ? 'xmp'
          : RAW_EXTENSIONS.has(extension) && JPEG_EXTENSIONS.has(entryExtension)
            ? 'jpeg'
            : JPEG_EXTENSIONS.has(extension) && RAW_EXTENSIONS.has(entryExtension)
              ? 'raw'
              : null;
        if (!kind) continue;
        const candidatePath = path.join(directory, entry);
        if (selectedPaths.has(candidatePath) || found.has(candidatePath)) continue;
        const metadata = await this.#fileSystem.stat(candidatePath);
        if (!metadata.isFile()) continue;
        const asset = kind === 'xmp' ? null : assetByPath.get(candidatePath) as AssetLocationRow | undefined;
        if (kind !== 'xmp' && !asset) continue;
        found.set(candidatePath, { path: candidatePath, fileName: entry, bytes: metadata.size, kind, asset: asset ?? null, owner });
      }
    }
    return [...found.values()].sort((left, right) => left.fileName.localeCompare(right.fileName));
  }

  #assertDestinationPaths(items: readonly PlannedItem[]): void {
    if (this.#platform !== 'win32') return;
    for (const item of items) {
      if (item.destinationPath.length >= 260 || item.temporaryPath.length >= 260) {
        throw new Error('DESTINATION_PATH_TOO_LONG');
      }
    }
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

    await this.#copyVerified(source, destination, temporary);
    try {
      await this.#fileSystem.unlink(source);
    } catch (error) {
      await removeIfPresent(this.#fileSystem, destination);
      throw error;
    }
  }

  async #copyVerified(source: string, destination: string, temporary: string): Promise<void> {
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
      const finalSourceStats = await this.#fileSystem.stat(source);
      if (
        finalSourceStats.size !== sourceStats.size
        || finalSourceStats.mtimeMs !== sourceStats.mtimeMs
        || finalSourceStats.ctimeMs !== sourceStats.ctimeMs
      ) {
        throw new Error('FILE_CHANGED_DURING_COPY');
      }
      await this.#fileSystem.unlink(temporary);
    } catch (error) {
      await removeIfPresent(this.#fileSystem, temporary);
      if (destinationPublished) await removeIfPresent(this.#fileSystem, destination);
      throw error;
    }
  }

  async #moveRenameItem(item: PlannedItem, reverse: boolean): Promise<void> {
    const source = reverse ? item.destinationPath : item.sourcePath;
    const destination = reverse ? item.sourcePath : item.destinationPath;
    if (normalizeFileName(item.previousFileName) === normalizeFileName(item.fileName)) {
      if (!this.#fileSystem.rename) throw new Error('CASE_ONLY_RENAME_UNSUPPORTED');
      await this.#fileSystem.rename(source, destination);
      return;
    }
    await this.#transfer(source, destination, item.temporaryPath);
  }

  #commitCatalog(operationId: string, items: PlannedItem[]): void {
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      const update = this.#database.prepare(`
        UPDATE assets SET folder_id = ?, path = ?, file_name = ?
        WHERE id = ? AND path = ? AND removed_at IS NULL
      `);
      for (const item of items) {
        if (item.catalogManaged === false) continue;
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

  #commitCopies(operationId: string, items: PlannedItem[]): void {
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      const insertAsset = this.#database.prepare(`
        INSERT INTO assets (
          id, folder_id, path, file_name, extension, size_bytes, modified_at,
          imported_at, rating, favorite
        )
        SELECT ?, ?, ?, ?, extension, ?, ?, ?, rating, favorite FROM assets
        WHERE id = ? AND removed_at IS NULL
      `);
      const copyTags = this.#database.prepare(`
        INSERT INTO asset_tags (asset_id, tag_id, created_at)
        SELECT ?, tag_id, ? FROM asset_tags WHERE asset_id = ?
      `);
      for (const item of items) {
        if (item.catalogManaged === false) continue;
        if (!item.resultAssetId || item.modifiedAt === undefined) throw new Error('COPY_RESULT_INCOMPLETE');
        const now = Date.now();
        const result = insertAsset.run(
          item.resultAssetId, item.destinationFolderId, item.destinationPath, item.fileName,
          item.sizeBytes, item.modifiedAt, now, item.assetId
        );
        if (result.changes !== 1) throw new Error('CATALOG_CONCURRENT_CHANGE');
        copyTags.run(item.resultAssetId, now, item.assetId);
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
    const catalogItems = items.filter((item) => item.catalogManaged !== false);
    const moved = status === 'completed' ? catalogItems.filter((item) => !item.skipped) : [];
    return moveCatalogAssetsReportSchema.parse({
      operationId,
      status,
      total: catalogItems.length,
      moved: moved.length,
      skipped: catalogItems.filter((item) => item.skipped).length,
      rolledBack,
      files: moved.map((item) => ({
        assetId: item.assetId,
        fileName: item.fileName,
        previousFileName: item.previousFileName
      })),
      errorCode: code
    });
  }

  #copyReport(
    operationId: string,
    items: PlannedItem[],
    status: 'completed' | 'failed',
    rolledBack: boolean,
    code: string | null
  ): CopyCatalogAssetsReport {
    const catalogItems = items.filter((item) => item.catalogManaged !== false);
    const copied = status === 'completed' ? catalogItems : [];
    return copyCatalogAssetsReportSchema.parse({
      operationId,
      status,
      total: catalogItems.length,
      copied: copied.length,
      rolledBack,
      files: copied.map((item) => ({
        sourceAssetId: item.assetId,
        assetId: item.resultAssetId,
        fileName: item.fileName
      })),
      errorCode: code
    });
  }

  #readOperationItems(operationId: string): PlannedItem[] {
    const rows = this.#database.prepare(`
      SELECT id, asset_id, source_path, destination_path, temporary_path, source_folder_id,
        destination_folder_id, original_file_name, destination_file_name, size_bytes, result_asset_id, status, catalog_managed
      FROM file_operation_items WHERE operation_id = ? ORDER BY ordinal ASC
    `).all(operationId) as Array<{
      id: string; asset_id: string; source_path: string; destination_path: string;
      temporary_path: string; source_folder_id: string; destination_folder_id: string;
      original_file_name: string; destination_file_name: string; size_bytes: number;
      result_asset_id: string | null; status: string; catalog_managed: number;
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
      status: row.status,
      resultAssetId: row.result_asset_id,
      catalogManaged: row.catalog_managed === 1
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

  async #recoverCopyItem(item: PlannedItem): Promise<void> {
    const [sourceExists, destinationExists] = await Promise.all([
      exists(this.#fileSystem, item.sourcePath), exists(this.#fileSystem, item.destinationPath)
    ]);
    if (!sourceExists) throw new Error('RECOVERY_SOURCE_MISSING');
    if (destinationExists) {
      const [sourceStats, destinationStats] = await Promise.all([
        this.#fileSystem.stat(item.sourcePath), this.#fileSystem.stat(item.destinationPath)
      ]);
      if (sourceStats.size !== destinationStats.size) throw new Error('RECOVERY_DESTINATION_CONFLICT');
      const [sourceHash, destinationHash] = await Promise.all([
        hashFile(item.sourcePath), hashFile(item.destinationPath)
      ]);
      if (sourceHash !== destinationHash) throw new Error('RECOVERY_DESTINATION_CONFLICT');
      await removeIfPresent(this.#fileSystem, item.destinationPath);
    }
    await removeIfPresent(this.#fileSystem, item.temporaryPath);
  }

  async #recoverRenameItem(item: PlannedItem): Promise<void> {
    if (normalizeFileName(item.previousFileName) !== normalizeFileName(item.fileName)) {
      await this.#recoverItem(item);
      return;
    }
    const entries = await this.#fileSystem.readdir(path.dirname(item.sourcePath));
    const hasSourceName = entries.includes(item.previousFileName);
    const hasDestinationName = entries.includes(item.fileName);
    if (hasSourceName && !hasDestinationName) {
      await removeIfPresent(this.#fileSystem, item.temporaryPath);
      return;
    }
    if (!hasSourceName && hasDestinationName) {
      if (!this.#fileSystem.rename) throw new Error('CASE_ONLY_RENAME_UNSUPPORTED');
      await this.#fileSystem.rename(item.destinationPath, item.sourcePath);
      await removeIfPresent(this.#fileSystem, item.temporaryPath);
      return;
    }
    throw new Error('RECOVERY_DESTINATION_CONFLICT');
  }

  async #recoverInterruptedTrashOperation(operationId: string, items: PlannedItem[]): Promise<void> {
    let succeeded = 0;
    let failed = 0;
    for (const item of items) {
      if (!['trashing', 'trashed'].includes(item.status)) {
        this.#setItemStatus(item.id, 'failed', 'APP_INTERRUPTED');
        failed += 1;
        continue;
      }
      try {
        if (await exists(this.#fileSystem, item.sourcePath)) {
          this.#setItemStatus(item.id, 'failed', 'TRASH_NOT_COMPLETED');
          failed += 1;
        } else {
          this.#ensureAssetRemoved(item.assetId, true);
          this.#setItemStatus(item.id, 'trashed', null);
          succeeded += 1;
        }
      } catch (error) {
        this.#setItemStatus(item.id, 'failed', errorCode(error));
        failed += 1;
      }
    }
    const status = failed === 0 ? 'completed' : succeeded === 0 ? 'failed' : 'partial';
    this.#database.prepare(`
      UPDATE file_operations SET status = ?, completed_at = ?, error_code = ? WHERE id = ?
    `).run(status, Date.now(), failed > 0 ? 'INTERRUPTED_RECOVERED' : null, operationId);
  }

  #ensureAssetRemoved(assetId: string, trashed: boolean): void {
    const row = this.#database.prepare('SELECT removed_at FROM assets WHERE id = ?')
      .get(assetId) as { removed_at: number | null } | undefined;
    if (!row) throw new Error('CATALOG_ASSET_NOT_FOUND');
    if (row.removed_at !== null) return;
    this.#markAssetRemoved(assetId, trashed);
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

function undoTemporaryPath(item: PlannedItem): string {
  return path.join(path.dirname(item.sourcePath), `.photoallisai-undo-${item.id}.tmp`);
}

function reserveGroupedFileNames(
  files: readonly { path: string; fileName: string }[],
  reserved: Set<string>
): Map<string, string> {
  const groups = new Map<string, Array<{ path: string; fileName: string }>>();
  for (const file of files) {
    const extension = path.extname(file.fileName);
    const stem = path.basename(file.fileName, extension);
    const key = `${normalizeFileName(path.dirname(file.path))}\0${normalizeFileName(stem)}`;
    const group = groups.get(key);
    if (group) group.push(file);
    else groups.set(key, [file]);
  }

  const result = new Map<string, string>();
  const orderedGroups = [...groups.entries()]
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([, group]) => group.sort((left, right) => {
      const leftKey = `${normalizeFileName(left.path)}\0${left.fileName}`;
      const rightKey = `${normalizeFileName(right.path)}\0${right.fileName}`;
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
    }));
  for (const group of orderedGroups) {
    if (group.length === 1) {
      const file = group[0]!;
      result.set(file.path, reserveFileName(file.fileName, reserved));
      continue;
    }
    const maximumSuffix = reserved.size;
    for (let suffixIndex = 0; suffixIndex <= maximumSuffix; suffixIndex += 1) {
      const suffix = suffixIndex === 0 ? '' : ` (${suffixIndex})`;
      const candidates = group.map((file) => {
        const extension = path.extname(file.fileName);
        const stem = path.basename(file.fileName, extension);
        return { file, fileName: `${stem}${suffix}${extension}` };
      });
      const normalized = candidates.map((candidate) => normalizeFileName(candidate.fileName));
      if (new Set(normalized).size !== normalized.length) throw new Error('DUPLICATE_GROUP_FILE_NAME');
      if (normalized.some((candidate) => reserved.has(candidate))) continue;
      for (let index = 0; index < candidates.length; index += 1) {
        const candidate = candidates[index]!;
        reserved.add(normalized[index]!);
        result.set(candidate.file.path, candidate.fileName);
      }
      break;
    }
  }
  if (result.size !== files.length) throw new Error('FILE_NAME_RESERVATION_EXHAUSTED');
  return result;
}

function normalizeFileName(value: string): string {
  return value.normalize('NFC').toLocaleLowerCase('en-US');
}

function validateRenamedFileName(requested: string, current: string): string {
  const fileName = requested.normalize('NFC');
  if (fileName !== fileName.trim() || fileName === '.' || fileName === '..') throw new Error('INVALID_FILE_NAME');
  const hasControlCharacter = [...fileName].some((character) => character.charCodeAt(0) < 32);
  if (path.basename(fileName) !== fileName || /[<>:"/\\|?*]/u.test(fileName) || hasControlCharacter) {
    throw new Error('INVALID_FILE_NAME');
  }
  if (fileName.endsWith('.') || fileName.endsWith(' ') || Buffer.byteLength(fileName, 'utf8') > 255) {
    throw new Error('INVALID_FILE_NAME');
  }
  const deviceStem = fileName.split('.')[0]!.toUpperCase();
  if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/u.test(deviceStem)) throw new Error('INVALID_FILE_NAME');
  if (path.extname(fileName).toLocaleLowerCase('en-US') !== path.extname(current).toLocaleLowerCase('en-US')) {
    throw new Error('FILE_EXTENSION_CHANGE_NOT_ALLOWED');
  }
  return fileName;
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
