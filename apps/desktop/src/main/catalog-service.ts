import { createHash, randomUUID } from 'node:crypto';
import { opendir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  catalogAssetSchema,
  catalogAssetPageSchema,
  catalogFolderSchema,
  listCatalogAssetsInputSchema,
  type CatalogAsset,
  type CatalogAssetPage,
  type CatalogFolder,
  type ListCatalogAssetsInput,
  type UpdateCatalogMetadataInput,
  updateCatalogMetadataInputSchema
} from '@photoallisai/contracts';

const SUPPORTED_EXTENSIONS = new Set([
  '.jpg', '.jpeg', '.png', '.webp', '.gif', '.heic', '.heif',
  '.dng', '.cr2', '.cr3', '.nef', '.nrw', '.arw', '.raf', '.rw2', '.orf', '.pef'
]);

const IGNORED_DIRECTORIES = new Set(['_PhotoAllIsAI', '.git', 'node_modules']);

type AssetRow = {
  id: string;
  folder_id: string;
  path: string;
  file_name: string;
  extension: string;
  size_bytes: number;
  modified_at: number;
  rating: number;
  favorite: number;
};

export function isSupportedImage(filePath: string): boolean {
  return SUPPORTED_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function stableFolderId(folderPath: string): string {
  return createHash('sha256').update(folderPath).digest('hex').slice(0, 32);
}

async function* walkImages(root: string): AsyncGenerator<string> {
  const directories = [root];

  while (directories.length > 0) {
    const current = directories.pop();
    if (!current) continue;

    let directory;
    try {
      directory = await opendir(current);
    } catch {
      continue;
    }

    for await (const entry of directory) {
      if (entry.name.startsWith('.')) continue;
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory() && !IGNORED_DIRECTORIES.has(entry.name)) {
        directories.push(entryPath);
      } else if (entry.isFile() && isSupportedImage(entry.name)) {
        yield entryPath;
      }
    }
  }
}

export class CatalogService {
  readonly #database: DatabaseSync;

  constructor(databasePath: string) {
    this.#database = new DatabaseSync(databasePath);
    this.#database.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    this.#migrate();
  }

  #migrate(): void {
    const version = this.#database.prepare('PRAGMA user_version').get() as { user_version: number };
    if (version.user_version < 1) {
      this.#database.exec(`
        BEGIN IMMEDIATE;
        CREATE TABLE IF NOT EXISTS folders (
          id TEXT PRIMARY KEY,
          path TEXT NOT NULL UNIQUE,
          name TEXT NOT NULL,
          imported_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS assets (
          id TEXT PRIMARY KEY,
          folder_id TEXT NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
          path TEXT NOT NULL UNIQUE,
          file_name TEXT NOT NULL,
          extension TEXT NOT NULL,
          size_bytes INTEGER NOT NULL,
          modified_at INTEGER NOT NULL,
          imported_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS assets_folder_id_idx ON assets(folder_id);
        CREATE INDEX IF NOT EXISTS assets_modified_at_idx ON assets(modified_at DESC);
        PRAGMA user_version = 1;
        COMMIT;
      `);
    }
    const current = this.#database.prepare('PRAGMA user_version').get() as { user_version: number };
    if (current.user_version < 2) {
      this.#database.exec(`
        BEGIN IMMEDIATE;
        ALTER TABLE assets ADD COLUMN rating INTEGER NOT NULL DEFAULT 0 CHECK(rating BETWEEN 0 AND 5);
        ALTER TABLE assets ADD COLUMN favorite INTEGER NOT NULL DEFAULT 0 CHECK(favorite IN (0, 1));
        PRAGMA user_version = 2;
        COMMIT;
      `);
    }
  }

  close(): void {
    this.#database.close();
  }

  listAssets(limit = 500): CatalogAsset[] {
    const safeLimit = Math.max(1, Math.min(limit, 1_000));
    const rows = this.#database
      .prepare(`
        SELECT id, folder_id, path, file_name, extension, size_bytes, modified_at, rating, favorite
        FROM assets
        ORDER BY modified_at DESC, id ASC
        LIMIT ?
      `)
      .all(safeLimit) as AssetRow[];

    return rows.map((row) => this.#toAsset(row));
  }

  listAssetPage(rawInput: ListCatalogAssetsInput): CatalogAssetPage {
    const input = listCatalogAssetsInputSchema.parse(rawInput);
    const conditions: string[] = [];
    const values: (string | number)[] = [];
    if (input.folderId) {
      conditions.push('folder_id = ?');
      values.push(input.folderId);
    }
    if (input.cursor) {
      conditions.push('(modified_at < ? OR (modified_at = ? AND id > ?))');
      values.push(input.cursor.modifiedAt, input.cursor.modifiedAt, input.cursor.id);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const rows = this.#database.prepare(`
      SELECT id, folder_id, path, file_name, extension, size_bytes, modified_at, rating, favorite
      FROM assets ${where}
      ORDER BY modified_at DESC, id ASC
      LIMIT ?
    `).all(...values, input.limit + 1) as AssetRow[];
    const hasMore = rows.length > input.limit;
    const pageRows = hasMore ? rows.slice(0, input.limit) : rows;
    const count = this.#database.prepare(`
      SELECT COUNT(*) AS value FROM assets ${input.folderId ? 'WHERE folder_id = ?' : ''}
    `).get(...(input.folderId ? [input.folderId] : [])) as { value: number };
    const last = pageRows.at(-1);
    return catalogAssetPageSchema.parse({
      items: pageRows.map((row) => this.#toAsset(row)),
      totalCount: count.value,
      nextCursor: hasMore && last ? { modifiedAt: last.modified_at, id: last.id } : null
    });
  }

  listFolders(): CatalogFolder[] {
    const rows = this.#database.prepare(`
      SELECT folders.id, folders.name, COUNT(assets.id) AS asset_count
      FROM folders
      LEFT JOIN assets ON assets.folder_id = folders.id
      GROUP BY folders.id, folders.name
      HAVING COUNT(assets.id) > 0
      ORDER BY folders.name COLLATE NOCASE ASC, folders.id ASC
    `).all() as { id: string; name: string; asset_count: number }[];
    return rows.map((row) => catalogFolderSchema.parse({
      id: row.id,
      name: row.name,
      assetCount: row.asset_count
    }));
  }

  updateMetadata(rawInput: UpdateCatalogMetadataInput): CatalogAsset[] {
    const input = updateCatalogMetadataInputSchema.parse(rawInput);
    const uniqueIds = [...new Set(input.assetIds)];
    const assignments: string[] = [];
    const values: (number | string)[] = [];
    if (input.rating !== undefined) {
      assignments.push('rating = ?');
      values.push(input.rating);
    }
    if (input.favorite !== undefined) {
      assignments.push('favorite = ?');
      values.push(input.favorite ? 1 : 0);
    }
    const placeholders = uniqueIds.map(() => '?').join(', ');
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      const result = this.#database.prepare(`
        UPDATE assets SET ${assignments.join(', ')} WHERE id IN (${placeholders})
      `).run(...values, ...uniqueIds);
      if (result.changes !== uniqueIds.length) throw new Error('CATALOG_ASSET_SET_MISMATCH');
      this.#database.exec('COMMIT');
    } catch (error) {
      this.#database.exec('ROLLBACK');
      throw error;
    }
    const rows = this.#database.prepare(`
      SELECT id, folder_id, path, file_name, extension, size_bytes, modified_at, rating, favorite
      FROM assets WHERE id IN (${placeholders}) ORDER BY modified_at DESC, id ASC
    `).all(...uniqueIds) as AssetRow[];
    return rows.map((row) => this.#toAsset(row));
  }

  async importFolders(folderPaths: readonly string[]): Promise<number> {
    let importedCount = 0;

    for (const requestedPath of folderPaths) {
      const folderPath = await realpath(requestedPath);
      const folderStats = await stat(folderPath);
      if (!folderStats.isDirectory()) continue;

      const folderId = stableFolderId(folderPath);
      const now = Date.now();
      this.#database
        .prepare(`
          INSERT INTO folders (id, path, name, imported_at)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(path) DO UPDATE SET name = excluded.name
        `)
        .run(folderId, folderPath, path.basename(folderPath), now);

      this.#database.exec('BEGIN IMMEDIATE');
      try {
        const upsert = this.#database.prepare(`
          INSERT INTO assets (
            id, folder_id, path, file_name, extension, size_bytes, modified_at, imported_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(path) DO UPDATE SET
            folder_id = excluded.folder_id,
            file_name = excluded.file_name,
            extension = excluded.extension,
            size_bytes = excluded.size_bytes,
            modified_at = excluded.modified_at
        `);

        for await (const filePath of walkImages(folderPath)) {
          try {
            const fileStats = await stat(filePath);
            const result = upsert.run(
              randomUUID(),
              folderId,
              filePath,
              path.basename(filePath),
              path.extname(filePath).toLowerCase(),
              fileStats.size,
              Math.trunc(fileStats.mtimeMs),
              now
            );
            if (result.changes > 0) importedCount += 1;
          } catch {
            // A single unreadable file must not abort the rest of the import.
          }
        }
        this.#database.exec('COMMIT');
      } catch (error) {
        this.#database.exec('ROLLBACK');
        throw error;
      }
    }

    return importedCount;
  }

  resolveAssetFile(assetId: string): { path: string; fileName: string; modifiedAt: number } | null {
    const row = this.#database
      .prepare('SELECT path, file_name, modified_at FROM assets WHERE id = ?')
      .get(assetId) as Pick<AssetRow, 'path' | 'file_name' | 'modified_at'> | undefined;
    if (!row) return null;
    return { path: row.path, fileName: row.file_name, modifiedAt: row.modified_at };
  }

  #toAsset(row: AssetRow): CatalogAsset {
    return catalogAssetSchema.parse({
      id: row.id,
      folderId: row.folder_id,
      fileName: row.file_name,
      format: row.extension.slice(1).toUpperCase(),
      sizeBytes: row.size_bytes,
      modifiedAt: row.modified_at,
      rating: row.rating,
      favorite: row.favorite === 1,
      thumbnailUrl: `photoasset://thumbnail/${row.id}`,
      previewUrl: `photoasset://preview/${row.id}`
    });
  }
}
