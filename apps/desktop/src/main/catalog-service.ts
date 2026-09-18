import { createHash, randomUUID } from 'node:crypto';
import { opendir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { catalogAssetSchema, type CatalogAsset } from '@photoallisai/contracts';

const SUPPORTED_EXTENSIONS = new Set([
  '.jpg', '.jpeg', '.png', '.webp', '.gif', '.heic', '.heif',
  '.dng', '.cr2', '.cr3', '.nef', '.nrw', '.arw', '.raf', '.rw2', '.orf', '.pef'
]);

const IGNORED_DIRECTORIES = new Set(['_PhotoAllIsAI', '.git', 'node_modules']);

type AssetRow = {
  id: string;
  path: string;
  file_name: string;
  extension: string;
  size_bytes: number;
  modified_at: number;
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
    if (version.user_version >= 1) return;

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

  close(): void {
    this.#database.close();
  }

  listAssets(limit = 500): CatalogAsset[] {
    const safeLimit = Math.max(1, Math.min(limit, 1_000));
    const rows = this.#database
      .prepare(`
        SELECT id, path, file_name, extension, size_bytes, modified_at
        FROM assets
        ORDER BY modified_at DESC, id ASC
        LIMIT ?
      `)
      .all(safeLimit) as AssetRow[];

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

  resolveAssetFile(assetId: string): { path: string; modifiedAt: number } | null {
    const row = this.#database
      .prepare('SELECT path, modified_at FROM assets WHERE id = ?')
      .get(assetId) as Pick<AssetRow, 'path' | 'modified_at'> | undefined;
    if (!row) return null;
    return { path: row.path, modifiedAt: row.modified_at };
  }

  #toAsset(row: AssetRow): CatalogAsset {
    return catalogAssetSchema.parse({
      id: row.id,
      fileName: row.file_name,
      format: row.extension.slice(1).toUpperCase(),
      sizeBytes: row.size_bytes,
      modifiedAt: row.modified_at,
      thumbnailUrl: `photoasset://thumbnail/${row.id}`,
      previewUrl: `photoasset://preview/${row.id}`
    });
  }
}
