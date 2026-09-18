import { createHash, randomUUID } from 'node:crypto';
import { opendir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  catalogAlbumSchema,
  catalogAssetSchema,
  catalogAssetPageSchema,
  catalogFolderSchema,
  catalogSmartCollectionSchema,
  catalogTagSchema,
  listCatalogAssetsInputSchema,
  saveCatalogAlbumInputSchema,
  updateCatalogAlbumAssetsInputSchema,
  type CatalogAlbum,
  type CatalogAsset,
  type CatalogAssetPage,
  type CatalogFolder,
  type CatalogSmartCollection,
  type CatalogTag,
  type ListCatalogAssetsInput,
  type SaveCatalogAlbumInput,
  type UpdateCatalogAlbumAssetsInput,
  type UpdateCatalogMetadataInput,
  type UpdateCatalogTagsInput,
  updateCatalogTagsInputSchema,
  updateCatalogMetadataInputSchema
} from '@photoallisai/contracts';

import { normalizeSearchText, tokenizeSearchText } from './search-index';

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
  offline_at: number | null;
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
    const metadataVersion = this.#database.prepare('PRAGMA user_version').get() as { user_version: number };
    if (metadataVersion.user_version < 3) {
      this.#database.exec(`
        BEGIN IMMEDIATE;
        CREATE TABLE IF NOT EXISTS asset_search (
          asset_id TEXT PRIMARY KEY,
          normalized_content TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS asset_search_tokens (
          asset_id TEXT NOT NULL,
          token TEXT NOT NULL,
          PRIMARY KEY (asset_id, token)
        );
        CREATE INDEX IF NOT EXISTS asset_search_token_idx ON asset_search_tokens(token, asset_id);
        PRAGMA user_version = 3;
        COMMIT;
      `);
    }
    const searchVersion = this.#database.prepare('PRAGMA user_version').get() as { user_version: number };
    if (searchVersion.user_version < 4) {
      this.#database.exec(`
        BEGIN IMMEDIATE;
        CREATE TABLE IF NOT EXISTS tags (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          normalized_name TEXT NOT NULL UNIQUE
        );
        CREATE TABLE IF NOT EXISTS asset_tags (
          asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
          tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
          created_at INTEGER NOT NULL,
          PRIMARY KEY (asset_id, tag_id)
        );
        CREATE INDEX IF NOT EXISTS asset_tags_tag_idx ON asset_tags(tag_id, asset_id);
        PRAGMA user_version = 4;
        COMMIT;
      `);
    }
    const removalVersion = this.#database.prepare('PRAGMA user_version').get() as { user_version: number };
    if (removalVersion.user_version < 5) {
      this.#database.exec(`
        BEGIN IMMEDIATE;
        ALTER TABLE assets ADD COLUMN removed_at INTEGER;
        ALTER TABLE assets ADD COLUMN trashed_at INTEGER;
        CREATE INDEX assets_active_folder_idx ON assets(removed_at, folder_id);
        PRAGMA user_version = 5;
        COMMIT;
      `);
    }
    const albumVersion = this.#database.prepare('PRAGMA user_version').get() as { user_version: number };
    if (albumVersion.user_version < 6) {
      this.#database.exec(`
        BEGIN IMMEDIATE;
        CREATE TABLE albums (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          normalized_name TEXT NOT NULL UNIQUE,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE album_assets (
          album_id TEXT NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
          asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
          added_at INTEGER NOT NULL,
          PRIMARY KEY (album_id, asset_id)
        );
        CREATE INDEX album_assets_asset_idx ON album_assets(asset_id, album_id);
        PRAGMA user_version = 6;
        COMMIT;
      `);
    }
    const offlineVersion = this.#database.prepare('PRAGMA user_version').get() as { user_version: number };
    if (offlineVersion.user_version < 7) {
      this.#database.exec(`
        BEGIN IMMEDIATE;
        ALTER TABLE assets ADD COLUMN offline_at INTEGER;
        CREATE INDEX assets_offline_idx ON assets(offline_at, folder_id);
        PRAGMA user_version = 7;
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
        SELECT id, folder_id, path, file_name, extension, size_bytes, modified_at, rating, favorite, offline_at
        FROM assets WHERE removed_at IS NULL
        ORDER BY modified_at DESC, id ASC
        LIMIT ?
      `)
      .all(safeLimit) as AssetRow[];

    return this.#toAssets(rows);
  }

  getStats(): { assets: number; offline: number } {
    const row = this.#database.prepare(`
      SELECT COUNT(*) AS assets, SUM(CASE WHEN offline_at IS NOT NULL THEN 1 ELSE 0 END) AS offline
      FROM assets WHERE removed_at IS NULL
    `).get() as { assets: number; offline: number | null };
    return { assets: row.assets, offline: row.offline ?? 0 };
  }

  listAssetPage(rawInput: ListCatalogAssetsInput): CatalogAssetPage {
    const input = listCatalogAssetsInputSchema.parse(rawInput);
    const baseConditions: string[] = ['removed_at IS NULL'];
    const baseValues: (string | number)[] = [];
    if (input.folderId) {
      baseConditions.push('folder_id = ?');
      baseValues.push(input.folderId);
    }
    if (input.tagId) {
      baseConditions.push('id IN (SELECT asset_id FROM asset_tags WHERE tag_id = ?)');
      baseValues.push(input.tagId);
    }
    if (input.albumId) {
      baseConditions.push('id IN (SELECT asset_id FROM album_assets WHERE album_id = ?)');
      baseValues.push(input.albumId);
    }
    if (input.smartCollection === 'favorites') baseConditions.push('favorite = 1');
    if (input.smartCollection === 'unrated') baseConditions.push('rating = 0');
    if (input.smartCollection === 'unanalyzed' && this.#tableExists('analysis_revisions')) {
      baseConditions.push('id NOT IN (SELECT asset_id FROM analysis_revisions)');
    }
    if (input.smartCollection === 'generated') {
      baseConditions.push(this.#tableExists('generation_results')
        ? 'id IN (SELECT asset_id FROM generation_results)'
        : '0');
    }
    if (input.smartCollection === 'to-review') {
      baseConditions.push(this.#tableExists('generation_results')
        ? "id IN (SELECT asset_id FROM generation_results WHERE review_state = 'undecided')"
        : '0');
    }
    if (input.favoriteOnly) baseConditions.push('favorite = 1');
    const query = input.query.trim();
    if (query) {
      const tokens = tokenizeSearchText(query);
      if (tokens.length > 0) {
        const tokenPlaceholders = tokens.map(() => '?').join(', ');
        baseConditions.push(`(
          file_name LIKE ? ESCAPE '\\'
          OR id IN (
            SELECT asset_id FROM asset_search_tokens
            WHERE token IN (${tokenPlaceholders})
            GROUP BY asset_id
            HAVING COUNT(DISTINCT token) = ?
          )
        )`);
        baseValues.push(`%${escapeLike(query)}%`, ...tokens, tokens.length);
      } else {
        baseConditions.push(`file_name LIKE ? ESCAPE '\\'`);
        baseValues.push(`%${escapeLike(query)}%`);
      }
    }
    const conditions = [...baseConditions];
    const values = [...baseValues];
    if (input.cursor) {
      conditions.push('(modified_at < ? OR (modified_at = ? AND id > ?))');
      values.push(input.cursor.modifiedAt, input.cursor.modifiedAt, input.cursor.id);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const rows = this.#database.prepare(`
      SELECT id, folder_id, path, file_name, extension, size_bytes, modified_at, rating, favorite, offline_at
      FROM assets ${where}
      ORDER BY modified_at DESC, id ASC
      LIMIT ?
    `).all(...values, input.limit + 1) as AssetRow[];
    const hasMore = rows.length > input.limit;
    const pageRows = hasMore ? rows.slice(0, input.limit) : rows;
    const countWhere = baseConditions.length > 0 ? `WHERE ${baseConditions.join(' AND ')}` : '';
    const count = this.#database.prepare(`
      SELECT COUNT(*) AS value FROM assets ${countWhere}
    `).get(...baseValues) as { value: number };
    const last = pageRows.at(-1);
    return catalogAssetPageSchema.parse({
      items: this.#toAssets(pageRows),
      totalCount: count.value,
      nextCursor: hasMore && last ? { modifiedAt: last.modified_at, id: last.id } : null
    });
  }

  listFolders(): CatalogFolder[] {
    const rows = this.#database.prepare(`
      SELECT folders.id, folders.name, COUNT(assets.id) AS asset_count
      FROM folders
      LEFT JOIN assets ON assets.folder_id = folders.id AND assets.removed_at IS NULL
      GROUP BY folders.id, folders.name
      ORDER BY folders.name COLLATE NOCASE ASC, folders.id ASC
    `).all() as { id: string; name: string; asset_count: number }[];
    return rows.map((row) => catalogFolderSchema.parse({
      id: row.id,
      name: row.name,
      assetCount: row.asset_count
    }));
  }

  listFolderPaths(): string[] {
    return (this.#database.prepare('SELECT path FROM folders ORDER BY path').all() as { path: string }[]).map((row) => row.path);
  }

  listAlbums(): CatalogAlbum[] {
    const rows = this.#database.prepare(`
      SELECT albums.id, albums.name, albums.created_at, albums.updated_at,
        COUNT(assets.id) AS asset_count
      FROM albums
      LEFT JOIN album_assets ON album_assets.album_id = albums.id
      LEFT JOIN assets ON assets.id = album_assets.asset_id AND assets.removed_at IS NULL
      GROUP BY albums.id
      ORDER BY albums.name COLLATE NOCASE ASC, albums.id ASC
    `).all() as Array<{
      id: string; name: string; created_at: number; updated_at: number; asset_count: number;
    }>;
    return rows.map((row) => catalogAlbumSchema.parse({
      id: row.id,
      name: row.name,
      assetCount: row.asset_count,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }));
  }

  listSmartCollections(): CatalogSmartCollection[] {
    const count = (condition: string): number => {
      const row = this.#database.prepare(`
        SELECT COUNT(*) AS value FROM assets WHERE removed_at IS NULL AND (${condition})
      `).get() as { value: number };
      return row.value;
    };
    const hasAnalysis = this.#tableExists('analysis_revisions');
    const hasGeneration = this.#tableExists('generation_results');
    return [
      catalogSmartCollectionSchema.parse({ id: 'favorites', assetCount: count('favorite = 1') }),
      catalogSmartCollectionSchema.parse({ id: 'unrated', assetCount: count('rating = 0') }),
      catalogSmartCollectionSchema.parse({
        id: 'unanalyzed',
        assetCount: hasAnalysis ? count('id NOT IN (SELECT asset_id FROM analysis_revisions)') : count('1')
      }),
      catalogSmartCollectionSchema.parse({
        id: 'generated',
        assetCount: hasGeneration ? count('id IN (SELECT asset_id FROM generation_results)') : 0
      }),
      catalogSmartCollectionSchema.parse({
        id: 'to-review',
        assetCount: hasGeneration ? count("id IN (SELECT asset_id FROM generation_results WHERE review_state = 'undecided')") : 0
      })
    ];
  }

  saveAlbum(rawInput: SaveCatalogAlbumInput): CatalogAlbum {
    const input = saveCatalogAlbumInputSchema.parse(rawInput);
    const normalizedName = normalizeSearchText(input.name);
    const duplicate = this.#database.prepare(`
      SELECT id FROM albums WHERE normalized_name = ? AND id != ?
    `).get(normalizedName, input.id ?? '') as { id: string } | undefined;
    if (duplicate) throw new Error('ALBUM_NAME_EXISTS');
    const now = Date.now();
    const id = input.id ?? randomUUID();
    if (input.id) {
      const result = this.#database.prepare(`
        UPDATE albums SET name = ?, normalized_name = ?, updated_at = ? WHERE id = ?
      `).run(input.name, normalizedName, now, id);
      if (result.changes !== 1) throw new Error('ALBUM_NOT_FOUND');
    } else {
      this.#database.prepare(`
        INSERT INTO albums (id, name, normalized_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
      `).run(id, input.name, normalizedName, now, now);
    }
    return this.#findAlbum(id);
  }

  deleteAlbum(albumId: string): void {
    if (this.#database.prepare('DELETE FROM albums WHERE id = ?').run(albumId).changes !== 1) {
      throw new Error('ALBUM_NOT_FOUND');
    }
  }

  updateAlbumAssets(rawInput: UpdateCatalogAlbumAssetsInput): CatalogAlbum {
    const input = updateCatalogAlbumAssetsInputSchema.parse(rawInput);
    const album = this.#database.prepare('SELECT id FROM albums WHERE id = ?').get(input.albumId);
    if (!album) throw new Error('ALBUM_NOT_FOUND');
    const assetIds = [...new Set(input.assetIds)];
    if (assetIds.length !== input.assetIds.length) throw new Error('DUPLICATE_ASSET_ID');
    const placeholders = assetIds.map(() => '?').join(', ');
    const active = this.#database.prepare(`
      SELECT COUNT(*) AS value FROM assets WHERE removed_at IS NULL AND id IN (${placeholders})
    `).get(...assetIds) as { value: number };
    if (active.value !== assetIds.length) throw new Error('CATALOG_ASSET_SET_MISMATCH');
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      if (input.mode === 'add') {
        const insert = this.#database.prepare(`
          INSERT OR IGNORE INTO album_assets (album_id, asset_id, added_at) VALUES (?, ?, ?)
        `);
        const now = Date.now();
        for (const assetId of assetIds) insert.run(input.albumId, assetId, now);
      } else {
        const remove = this.#database.prepare('DELETE FROM album_assets WHERE album_id = ? AND asset_id = ?');
        for (const assetId of assetIds) remove.run(input.albumId, assetId);
      }
      this.#database.prepare('UPDATE albums SET updated_at = ? WHERE id = ?').run(Date.now(), input.albumId);
      this.#database.exec('COMMIT');
    } catch (error) {
      this.#database.exec('ROLLBACK');
      throw error;
    }
    return this.#findAlbum(input.albumId);
  }

  listTags(): CatalogTag[] {
    const rows = this.#database.prepare(`
      SELECT tags.id, tags.name, COUNT(asset_tags.asset_id) AS asset_count
      FROM tags
      LEFT JOIN asset_tags ON asset_tags.tag_id = tags.id
        AND asset_tags.asset_id IN (SELECT id FROM assets WHERE removed_at IS NULL)
      GROUP BY tags.id, tags.name
      HAVING COUNT(asset_tags.asset_id) > 0
      ORDER BY tags.name COLLATE NOCASE ASC, tags.id ASC
    `).all() as { id: string; name: string; asset_count: number }[];
    return rows.map((row) => catalogTagSchema.parse({ id: row.id, name: row.name, assetCount: row.asset_count }));
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
        UPDATE assets SET ${assignments.join(', ')} WHERE removed_at IS NULL AND id IN (${placeholders})
      `).run(...values, ...uniqueIds);
      if (result.changes !== uniqueIds.length) throw new Error('CATALOG_ASSET_SET_MISMATCH');
      this.#database.exec('COMMIT');
    } catch (error) {
      this.#database.exec('ROLLBACK');
      throw error;
    }
    const rows = this.#database.prepare(`
      SELECT id, folder_id, path, file_name, extension, size_bytes, modified_at, rating, favorite, offline_at
      FROM assets WHERE id IN (${placeholders}) ORDER BY modified_at DESC, id ASC
    `).all(...uniqueIds) as AssetRow[];
    return this.#toAssets(rows);
  }

  updateTags(rawInput: UpdateCatalogTagsInput): CatalogTag[] {
    const input = updateCatalogTagsInputSchema.parse(rawInput);
    const assetIds = [...new Set(input.assetIds)];
    const assetPlaceholders = assetIds.map(() => '?').join(', ');
    const existing = this.#database.prepare(`
      SELECT COUNT(*) AS value FROM assets WHERE removed_at IS NULL AND id IN (${assetPlaceholders})
    `).get(...assetIds) as { value: number };
    if (existing.value !== assetIds.length) throw new Error('CATALOG_ASSET_SET_MISMATCH');

    this.#database.exec('BEGIN IMMEDIATE');
    try {
      const insertTag = this.#database.prepare(`
        INSERT INTO tags (id, name, normalized_name) VALUES (?, ?, ?)
        ON CONFLICT(normalized_name) DO NOTHING
      `);
      const findTag = this.#database.prepare('SELECT id FROM tags WHERE normalized_name = ?');
      const linkTag = this.#database.prepare(`
        INSERT OR IGNORE INTO asset_tags (asset_id, tag_id, created_at) VALUES (?, ?, ?)
      `);
      for (const rawName of input.addTags) {
        const name = rawName.trim();
        const normalizedName = normalizeSearchText(name);
        if (!normalizedName) continue;
        insertTag.run(randomUUID(), name, normalizedName);
        const tag = findTag.get(normalizedName) as { id: string };
        for (const assetId of assetIds) linkTag.run(assetId, tag.id, Date.now());
      }
      if (input.removeTagIds.length > 0) {
        const tagPlaceholders = input.removeTagIds.map(() => '?').join(', ');
        this.#database.prepare(`
          DELETE FROM asset_tags
          WHERE asset_id IN (${assetPlaceholders}) AND tag_id IN (${tagPlaceholders})
        `).run(...assetIds, ...input.removeTagIds);
        this.#database.prepare('DELETE FROM tags WHERE id NOT IN (SELECT DISTINCT tag_id FROM asset_tags)').run();
      }
      this.#database.exec('COMMIT');
    } catch (error) {
      this.#database.exec('ROLLBACK');
      throw error;
    }
    return this.listTags();
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
            id, folder_id, path, file_name, extension, size_bytes, modified_at, imported_at, offline_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
          ON CONFLICT(path) DO UPDATE SET
            folder_id = excluded.folder_id,
            file_name = excluded.file_name,
            extension = excluded.extension,
            size_bytes = excluded.size_bytes,
            modified_at = excluded.modified_at,
            removed_at = NULL,
            trashed_at = NULL,
            offline_at = NULL
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

  async reconcileImportedFolders(): Promise<{ discovered: number; offline: number }> {
    const folders = this.#database.prepare('SELECT id, path FROM folders').all() as { id: string; path: string }[];
    const before = new Set<string>();
    for (const folder of folders) {
      const rows = this.#database.prepare('SELECT path FROM assets WHERE folder_id = ? AND removed_at IS NULL').all(folder.id) as { path: string }[];
      rows.forEach((row) => before.add(row.path));
      this.#database.prepare('UPDATE assets SET offline_at = ? WHERE folder_id = ? AND removed_at IS NULL').run(Date.now(), folder.id);
    }
    const discovered = await this.importFolders(folders.map((folder) => folder.path));
    const row = this.#database.prepare('SELECT COUNT(*) AS value FROM assets WHERE offline_at IS NOT NULL AND removed_at IS NULL').get() as { value: number };
    return { discovered: Math.max(0, discovered - before.size), offline: row.value };
  }

  resolveAssetFile(assetId: string): { path: string; fileName: string; modifiedAt: number } | null {
    const row = this.#database
      .prepare('SELECT path, file_name, modified_at FROM assets WHERE id = ? AND removed_at IS NULL')
      .get(assetId) as Pick<AssetRow, 'path' | 'file_name' | 'modified_at'> | undefined;
    if (!row) return null;
    return { path: row.path, fileName: row.file_name, modifiedAt: row.modified_at };
  }

  #tableExists(tableName: string): boolean {
    return Boolean(this.#database.prepare(`
      SELECT 1 AS value FROM sqlite_master WHERE type = 'table' AND name = ?
    `).get(tableName));
  }

  #findAlbum(albumId: string): CatalogAlbum {
    const row = this.#database.prepare(`
      SELECT albums.id, albums.name, albums.created_at, albums.updated_at,
        COUNT(assets.id) AS asset_count
      FROM albums
      LEFT JOIN album_assets ON album_assets.album_id = albums.id
      LEFT JOIN assets ON assets.id = album_assets.asset_id AND assets.removed_at IS NULL
      WHERE albums.id = ?
      GROUP BY albums.id
    `).get(albumId) as {
      id: string; name: string; created_at: number; updated_at: number; asset_count: number;
    } | undefined;
    if (!row) throw new Error('ALBUM_NOT_FOUND');
    return catalogAlbumSchema.parse({
      id: row.id,
      name: row.name,
      assetCount: row.asset_count,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    });
  }

  #toAssets(rows: AssetRow[]): CatalogAsset[] {
    if (rows.length === 0) return [];
    const placeholders = rows.map(() => '?').join(', ');
    const tagRows = this.#database.prepare(`
      SELECT asset_tags.asset_id, tags.id, tags.name
      FROM asset_tags JOIN tags ON tags.id = asset_tags.tag_id
      WHERE asset_tags.asset_id IN (${placeholders})
      ORDER BY tags.name COLLATE NOCASE ASC
    `).all(...rows.map((row) => row.id)) as { asset_id: string; id: string; name: string }[];
    const tagsByAsset = new Map<string, { id: string; name: string }[]>();
    for (const tag of tagRows) {
      const tags = tagsByAsset.get(tag.asset_id) ?? [];
      tags.push({ id: tag.id, name: tag.name });
      tagsByAsset.set(tag.asset_id, tags);
    }
    return rows.map((row) => this.#toAsset(row, tagsByAsset.get(row.id) ?? []));
  }

  #toAsset(row: AssetRow, tags: { id: string; name: string }[]): CatalogAsset {
    return catalogAssetSchema.parse({
      id: row.id,
      folderId: row.folder_id,
      fileName: row.file_name,
      format: row.extension.slice(1).toUpperCase(),
      sizeBytes: row.size_bytes,
      modifiedAt: row.modified_at,
      rating: row.rating,
      favorite: row.favorite === 1,
      offline: row.offline_at !== null,
      tags,
      thumbnailUrl: `photoasset://thumbnail/${row.id}`,
      previewUrl: `photoasset://preview/${row.id}`
    });
  }
}

function escapeLike(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');
}
