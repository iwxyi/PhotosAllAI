import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, opendir, realpath, rename, rmdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { naturalSortKey } from '@photoallisai/domain';

import {
  catalogAlbumSchema,
  catalogAssetSchema,
  catalogAssetPageSchema,
  catalogFolderSchema,
  relinkCatalogFolderResultSchema,
  catalogSmartCollectionSchema,
  saveSmartCollectionInputSchema,
  smartCollectionRuleSchema,
  catalogTagSchema,
  deleteCatalogTagInputSchema,
  listCatalogAssetsInputSchema,
  saveCatalogAlbumInputSchema,
  updateCatalogAlbumAssetsInputSchema,
  type CatalogAlbum,
  type CatalogAsset,
  type CatalogAssetPage,
  type CatalogFolder,
  type MoveCatalogFolderInput,
  type MoveCatalogFolderResult,
  type RelinkCatalogFolderResult,
  type RenameCatalogFolderInput,
  type RenameCatalogFolderResult,
  type CreateCatalogFolderInput,
  type UnregisterCatalogFolderReport,
  unregisterCatalogFolderReportSchema,
  type CatalogSmartCollection,
  type FileDetails,
  type SmartCollectionRule,
  type SaveSmartCollectionInput,
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
import { isSupportedBrowseMedia } from './media-format-registry';
export { isSupportedImage } from './media-format-registry';

const IGNORED_DIRECTORIES = new Set(['_PhotoAllIsAI', '.git', 'node_modules']);
const IMPORT_BATCH_SIZE = 256;
const IMPORT_STAT_CONCURRENCY = 16;
const RECONCILE_BATCH_SIZE = 256;
const COUNT_CACHE_LIMIT = 64;
const EXIF_FIELDS = new Set(['width', 'height', 'cameraMake', 'cameraModel', 'lensMake', 'lensModel', 'city', 'country', 'takenAt', 'exposureSeconds', 'aperture', 'focalLength', 'iso']);

type AssetRow = {
  id: string;
  folder_id: string;
  path: string;
  file_name: string;
  extension: string;
  size_bytes: number;
  modified_at: number;
  rating: number;
  label_color: 'red' | 'yellow' | 'green' | 'blue' | 'purple' | null;
  favorite: number;
  flag: 'picked' | 'rejected' | 'unflagged';
  offline_at: number | null;
  content_hash: string | null;
  width?: number | null;
  height?: number | null;
};

export type RelinkCatalogFolderOperationResult = RelinkCatalogFolderResult & {
  relocations: Array<{
    assetId: string;
    previousPath: string;
    nextPath: string;
    previousFileName: string;
    nextFileName: string;
  }>;
};

export type MoveCatalogFolderOperationResult = MoveCatalogFolderResult & {
  relocations: Array<{ assetId: string; previousPath: string; nextPath: string; previousFileName: string; nextFileName: string }>;
};

function stableFolderId(folderPath: string): string {
  return createHash('sha256').update(folderPath).digest('hex').slice(0, 32);
}

function stableDirectoryId(rootId: string, relativePath: string): string {
  return createHash('sha256').update(`${rootId}\0${normalizeRelativePath(relativePath)}`).digest('hex').slice(0, 32);
}

async function* walkImages(root: string, strict = false): AsyncGenerator<string> {
  const directories = [root];

  while (directories.length > 0) {
    const current = directories.pop();
    if (!current) continue;

    let directory;
    try {
      directory = await opendir(current);
    } catch (error) {
      if (strict) throw error;
      continue;
    }

    for await (const entry of directory) {
      if (entry.name.startsWith('.')) continue;
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory() && !IGNORED_DIRECTORIES.has(entry.name)) {
        directories.push(entryPath);
      } else if (entry.isFile() && isSupportedBrowseMedia(entry.name)) {
        yield entryPath;
      }
    }
  }
}

export class CatalogService {
  readonly #database: DatabaseSync;
  readonly #countCache = new Map<string, number>();
  #countCacheVersion = '';
  #folderCache: CatalogFolder[] | null = null;
  #folderCacheVersion = '';
  #directoryLookup = new Map<string, { rootId: string; rootPath: string; relativePath: string }>();
  #externalRelocations: RelinkCatalogFolderOperationResult['relocations'] = [];

  constructor(databasePath: string) {
    this.#database = new DatabaseSync(databasePath);
    this.#database.function('smart_regexp', (pattern: unknown, candidate: unknown) =>
      typeof pattern === 'string' && typeof candidate === 'string' && validateSmartRegex(pattern).test(candidate) ? 1 : 0);
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
    const contentHashVersion = this.#database.prepare('PRAGMA user_version').get() as { user_version: number };
    if (contentHashVersion.user_version < 8) {
      this.#database.exec(`
        BEGIN IMMEDIATE;
        ALTER TABLE assets ADD COLUMN content_hash TEXT CHECK(content_hash IS NULL OR length(content_hash) = 64);
        CREATE INDEX assets_content_hash_idx ON assets(content_hash) WHERE content_hash IS NOT NULL;
        PRAGMA user_version = 8;
        COMMIT;
      `);
    }
    const folderRemovalVersion = this.#database.prepare('PRAGMA user_version').get() as { user_version: number };
    if (folderRemovalVersion.user_version < 9) {
      this.#database.exec(`
        BEGIN IMMEDIATE;
        ALTER TABLE folders ADD COLUMN removed_at INTEGER;
        CREATE INDEX folders_active_idx ON folders(removed_at, name);
        PRAGMA user_version = 9;
        COMMIT;
      `);
    }
    const labelColorVersion = this.#database.prepare('PRAGMA user_version').get() as { user_version: number };
    if (labelColorVersion.user_version < 10) {
      this.#database.exec(`
        BEGIN IMMEDIATE;
        ALTER TABLE assets ADD COLUMN label_color TEXT CHECK(label_color IS NULL OR label_color IN ('red', 'yellow', 'green', 'blue', 'purple'));
        PRAGMA user_version = 10;
        COMMIT;
      `);
    }
    const flagVersion = this.#database.prepare('PRAGMA user_version').get() as { user_version: number };
    if (flagVersion.user_version < 11) {
      this.#database.exec(`
        BEGIN IMMEDIATE;
        ALTER TABLE assets ADD COLUMN flag TEXT NOT NULL DEFAULT 'unflagged' CHECK(flag IN ('picked', 'rejected', 'unflagged'));
        PRAGMA user_version = 11;
        COMMIT;
      `);
    }
    const browseIndexVersion = this.#database.prepare('PRAGMA user_version').get() as { user_version: number };
    if (browseIndexVersion.user_version < 12) {
      this.#database.exec(`
        BEGIN IMMEDIATE;
        CREATE INDEX assets_browse_name_asc_idx ON assets(folder_id, file_name COLLATE NOCASE ASC, id ASC) WHERE removed_at IS NULL;
        CREATE INDEX assets_browse_name_desc_idx ON assets(folder_id, file_name COLLATE NOCASE DESC, id ASC) WHERE removed_at IS NULL;
        CREATE INDEX assets_browse_rating_asc_idx ON assets(folder_id, rating ASC, id ASC) WHERE removed_at IS NULL;
        CREATE INDEX assets_browse_rating_desc_idx ON assets(folder_id, rating DESC, id ASC) WHERE removed_at IS NULL;
        CREATE INDEX assets_browse_modified_asc_idx ON assets(folder_id, modified_at ASC, id ASC) WHERE removed_at IS NULL;
        CREATE INDEX assets_browse_modified_desc_idx ON assets(folder_id, modified_at DESC, id ASC) WHERE removed_at IS NULL;
        CREATE INDEX assets_browse_all_name_asc_idx ON assets(file_name COLLATE NOCASE ASC, id ASC) WHERE removed_at IS NULL;
        CREATE INDEX assets_browse_all_name_desc_idx ON assets(file_name COLLATE NOCASE DESC, id ASC) WHERE removed_at IS NULL;
        CREATE INDEX assets_browse_all_rating_asc_idx ON assets(rating ASC, id ASC) WHERE removed_at IS NULL;
        CREATE INDEX assets_browse_all_rating_desc_idx ON assets(rating DESC, id ASC) WHERE removed_at IS NULL;
        CREATE INDEX assets_browse_all_modified_asc_idx ON assets(modified_at ASC, id ASC) WHERE removed_at IS NULL;
        CREATE INDEX assets_browse_all_modified_desc_idx ON assets(modified_at DESC, id ASC) WHERE removed_at IS NULL;
        PRAGMA user_version = 12;
        COMMIT;
      `);
    }
    const smartVersion = this.#database.prepare('PRAGMA user_version').get() as { user_version: number };
    const hadSmartCollections = this.#tableExists('smart_collections');
    if (smartVersion.user_version < 13 || !hadSmartCollections) {
      this.#database.exec(`
        BEGIN IMMEDIATE;
        CREATE TABLE IF NOT EXISTS smart_collections (
          id TEXT PRIMARY KEY, name TEXT NOT NULL, rule_json TEXT NOT NULL,
          is_default INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
        );
        ${smartVersion.user_version < 13 ? 'PRAGMA user_version = 13;' : ''}
        COMMIT;
      `);
      if (!hadSmartCollections) this.#seedDefaultSmartCollections();
    }
    const exifVersion = this.#database.prepare('PRAGMA user_version').get() as { user_version: number };
    if (exifVersion.user_version < 14 || !this.#tableExists('asset_exif')) {
      this.#database.exec(`
        BEGIN IMMEDIATE;
        CREATE TABLE IF NOT EXISTS asset_exif (
          asset_id TEXT PRIMARY KEY REFERENCES assets(id) ON DELETE CASCADE,
          source_size INTEGER NOT NULL, source_modified_at INTEGER NOT NULL,
          width REAL, height REAL, camera_make TEXT, camera_model TEXT,
          lens_make TEXT, lens_model TEXT, city TEXT, country TEXT,
          taken_at INTEGER, exposure_seconds REAL, aperture REAL, focal_length REAL, iso REAL
        );
        CREATE INDEX IF NOT EXISTS asset_exif_camera_idx ON asset_exif(camera_make, camera_model);
        CREATE INDEX IF NOT EXISTS asset_exif_taken_idx ON asset_exif(taken_at);
        CREATE INDEX IF NOT EXISTS asset_exif_iso_idx ON asset_exif(iso);
        ${exifVersion.user_version < 14 ? 'PRAGMA user_version = 14;' : ''}
        COMMIT;
      `);
    }
    const naturalSortVersion = this.#database.prepare('PRAGMA user_version').get() as { user_version: number };
    if (naturalSortVersion.user_version < 15) {
      const hasSortKey = (this.#database.prepare('PRAGMA table_info(assets)').all() as Array<{ name: string }>).some((column) => column.name === 'name_sort_key');
      this.#database.exec(`
        BEGIN IMMEDIATE;
        ${hasSortKey ? '' : 'ALTER TABLE assets ADD COLUMN name_sort_key TEXT;'}
        CREATE INDEX IF NOT EXISTS assets_browse_natural_name_asc_idx ON assets(folder_id, name_sort_key ASC, id ASC) WHERE removed_at IS NULL;
        CREATE INDEX IF NOT EXISTS assets_browse_natural_name_desc_idx ON assets(folder_id, name_sort_key DESC, id ASC) WHERE removed_at IS NULL;
        CREATE INDEX IF NOT EXISTS assets_browse_all_natural_name_asc_idx ON assets(name_sort_key ASC, id ASC) WHERE removed_at IS NULL;
        CREATE INDEX IF NOT EXISTS assets_browse_all_natural_name_desc_idx ON assets(name_sort_key DESC, id ASC) WHERE removed_at IS NULL;
        PRAGMA user_version = 15;
        COMMIT;
      `);
    }
    this.#ensureCreatedDirectories();
  }

  #seedDefaultSmartCollections(): void {
    const defaults: Array<[string, string, SmartCollectionRule['conditions']]> = [
      ['recent', '最近 30 天', [{ field: 'importedWithinDays', operator: 'lte', value: 30 }]],
      ['favorites', '收藏', [{ field: 'favorite', operator: 'eq', value: true }]],
      ['unrated', '未评分', [{ field: 'rating', operator: 'eq', value: 0 }]],
      ['unanalyzed', '等待 AI 分析', [{ field: 'analyzed', operator: 'eq', value: false }]],
      ['generated', '已生成', [{ field: 'generated', operator: 'eq', value: true }]],
      ['to-review', '待审阅', [{ field: 'reviewState', operator: 'eq', value: 'undecided' }]]
    ];
    const insert = this.#database.prepare('INSERT OR IGNORE INTO smart_collections (id, name, rule_json, is_default, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)');
    const now = Date.now();
    for (const [id, name, conditions] of defaults) {
      insert.run(id, name, JSON.stringify({ version: 1, scope: { all: true, favorites: false, folderIds: [], albumIds: [] }, match: 'all', conditions }), now, now);
    }
  }

  close(): void {
    this.#countCache.clear();
    this.#folderCache = null;
    this.#directoryLookup.clear();
    this.#externalRelocations = [];
    this.#database.close();
  }

  #databaseVersion(): string {
    const changes = this.#database.prepare('SELECT total_changes() AS value').get() as { value: number };
    const dataVersion = this.#database.prepare('PRAGMA data_version').get() as { data_version: number };
    return `${changes.value}:${dataVersion.data_version}`;
  }

  #countAssets(where: string, values: (string | number)[]): number {
    const version = this.#databaseVersion();
    if (this.#countCacheVersion !== version) {
      this.#countCache.clear();
      this.#countCacheVersion = version;
    }
    const key = JSON.stringify([where, values]);
    const cached = this.#countCache.get(key);
    if (cached !== undefined) {
      this.#countCache.delete(key);
      this.#countCache.set(key, cached);
      return cached;
    }
    const row = this.#database.prepare(`SELECT COUNT(*) AS value FROM assets ${where}`).get(...values) as { value: number };
    this.#countCache.set(key, row.value);
    if (this.#countCache.size > COUNT_CACHE_LIMIT) this.#countCache.delete(this.#countCache.keys().next().value!);
    return row.value;
  }

  listAssets(limit = 500): CatalogAsset[] {
    const safeLimit = Math.max(1, Math.min(limit, 1_000));
    const rows = this.#database
      .prepare(`
        SELECT id, folder_id, path, file_name, extension, size_bytes, modified_at, rating, label_color, flag, favorite, offline_at
        FROM assets WHERE removed_at IS NULL
        ORDER BY modified_at DESC, id ASC
        LIMIT ?
      `)
      .all(safeLimit) as AssetRow[];

    return this.#toAssets(rows);
  }

  listLightroomImportAssets(): Array<{ id: string; path: string; fileName: string; rating: number; labelColor: AssetRow['label_color'] }> {
    return this.#database.prepare(`
      SELECT id, path, file_name AS fileName, rating, label_color AS labelColor
      FROM assets WHERE removed_at IS NULL
    `).all() as Array<{ id: string; path: string; fileName: string; rating: number; labelColor: AssetRow['label_color'] }>;
  }

  applyLightroomMetadata(changes: Array<{ id: string; previousRating: number; previousColor: AssetRow['label_color']; rating: number; labelColor: AssetRow['label_color'] }>): { updated: number; skipped: number } {
    const update = this.#database.prepare(`
      UPDATE assets SET rating = ?, label_color = ?
      WHERE id = ? AND removed_at IS NULL AND rating = ? AND label_color IS ?
    `);
    let updated = 0;
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      for (const item of changes) updated += Number(update.run(item.rating, item.labelColor, item.id, item.previousRating, item.previousColor).changes);
      this.#database.exec('COMMIT');
    } catch (error) {
      this.#database.exec('ROLLBACK');
      throw error;
    }
    this.#countCache.clear();
    return { updated, skipped: changes.length - updated };
  }

  getStats(): { assets: number; offline: number } {
    const row = this.#database.prepare(`
      SELECT COUNT(*) AS assets, SUM(CASE WHEN offline_at IS NOT NULL THEN 1 ELSE 0 END) AS offline
      FROM assets WHERE removed_at IS NULL
    `).get() as { assets: number; offline: number | null };
    return { assets: row.assets, offline: row.offline ?? 0 };
  }

  #populateMissingNameSortKeys(): void {
    const missing = this.#database.prepare('SELECT id, file_name FROM assets WHERE removed_at IS NULL AND name_sort_key IS NULL').all() as Array<{ id: string; file_name: string }>;
    if (!missing.length) return;
    const update = this.#database.prepare('UPDATE assets SET name_sort_key = ? WHERE id = ?');
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      for (const row of missing) update.run(naturalSortKey(row.file_name), row.id);
      this.#database.exec('COMMIT');
    } catch (error) { this.#database.exec('ROLLBACK'); throw error; }
  }

  listAssetIdsInFolder(folderId: string): string[] {
    const directory = this.#resolveDirectory(folderId);
    if (!directory) throw new Error('FOLDER_NOT_FOUND');
    const absolute = path.join(directory.rootPath, directory.relativePath);
    const rows = directory.relativePath
      ? this.#database.prepare("SELECT id FROM assets WHERE removed_at IS NULL AND folder_id = ? AND (path = ? OR path LIKE ? ESCAPE '\\')")
        .all(directory.rootId, absolute, `${escapeLike(absolute + path.sep)}%`) as Array<{ id: string }>
      : this.#database.prepare('SELECT id FROM assets WHERE removed_at IS NULL AND folder_id = ?')
        .all(directory.rootId) as Array<{ id: string }>;
    return rows.map((row) => row.id);
  }

  listAssetPage(rawInput: ListCatalogAssetsInput): CatalogAssetPage {
    const input = listCatalogAssetsInputSchema.parse(rawInput);
    if (input.sortBy === 'fileName') this.#populateMissingNameSortKeys();
    if (input.cursor && input.offset !== undefined) throw new RangeError('Use either cursor or offset for catalog paging');
    const baseConditions: string[] = ['removed_at IS NULL'];
    const baseValues: (string | number)[] = [];
    if (input.assetIds) {
      baseConditions.push(`id IN (${input.assetIds.map(() => '?').join(',')})`);
      baseValues.push(...input.assetIds);
    }
    if (input.folderId) {
      const directory = this.#resolveDirectory(input.folderId);
      if (directory?.relativePath) {
        baseConditions.push('folder_id = ? AND (path = ? OR path LIKE ? ESCAPE \'\\\')');
        const absolute = path.join(directory.rootPath, directory.relativePath);
        baseValues.push(directory.rootId, absolute, `${escapeLike(absolute + path.sep)}%`);
      } else {
        baseConditions.push('folder_id = ?');
        baseValues.push(directory?.rootId ?? input.folderId);
      }
    }
    if (input.tagId) {
      baseConditions.push('id IN (SELECT asset_id FROM asset_tags WHERE tag_id = ?)');
      baseValues.push(input.tagId);
    }
    if (input.albumId) {
      baseConditions.push('id IN (SELECT asset_id FROM album_assets WHERE album_id = ?)');
      baseValues.push(input.albumId);
    }
    if (input.smartCollection) {
      const rule = this.#findSmartCollectionRule(input.smartCollection);
      const compiled = rule ? this.#compileSmartCollection(rule) : { sql: '0', values: [] };
      baseConditions.push(compiled.sql);
      baseValues.push(...compiled.values);
    }
    if (input.favoriteOnly) baseConditions.push('favorite = 1');
    if (input.folderIds.length) {
      const directories: string[] = [];
      for (const id of input.folderIds) {
        const directory = this.#resolveDirectory(id);
        if (!directory) continue;
        if (!directory.relativePath) {
          directories.push('folder_id = ?');
          baseValues.push(directory.rootId);
        } else {
          directories.push("(folder_id = ? AND path LIKE ? ESCAPE '\\')");
          baseValues.push(directory.rootId, `${escapeLike(path.join(directory.rootPath, directory.relativePath) + path.sep)}%`);
        }
      }
      baseConditions.push(directories.length ? `(${directories.join(' OR ')})` : '0');
    }
    if (input.dateFrom !== null) {
      baseConditions.push('modified_at >= ?');
      baseValues.push(input.dateFrom);
    }
    if (input.dateTo !== null) {
      baseConditions.push('modified_at < ?');
      baseValues.push(input.dateTo);
    }
    if (input.months.length) {
      baseConditions.push(`strftime('%Y-%m', modified_at / 1000, 'unixepoch', 'localtime') IN (${input.months.map(() => '?').join(', ')})`);
      baseValues.push(...input.months);
    }
    if (input.formats.length) {
      baseConditions.push(`UPPER(SUBSTR(extension, 2)) IN (${input.formats.map(() => '?').join(', ')})`);
      baseValues.push(...input.formats.map((format) => format.toUpperCase()));
    }
    if (input.minimumRating !== null) {
      const operator = input.ratingOperator === 'eq' ? '=' : input.ratingOperator === 'lte' ? '<=' : '>=';
      baseConditions.push(`rating ${operator} ?`);
      baseValues.push(input.minimumRating);
    }
    if (input.flags.length) {
      baseConditions.push(`flag IN (${input.flags.map(() => '?').join(', ')})`);
      baseValues.push(...input.flags);
    }
    if (input.colors.length) {
      baseConditions.push(`label_color IN (${input.colors.map(() => '?').join(', ')})`);
      baseValues.push(...input.colors);
    }

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
    const direction = input.sortDirection ?? (input.sortBy === 'fileName' ? 'asc' : 'desc');
    const comparison = direction === 'asc' ? '>' : '<';
    if (input.cursor) {
      if (input.sortBy === 'fileName') {
        conditions.push(`(name_sort_key ${comparison} ? OR (name_sort_key = ? AND id > ?))`);
        const key = naturalSortKey(typeof input.cursor.sortValue === 'string' ? input.cursor.sortValue : '');
        values.push(key, key, input.cursor.id);
      } else if (input.sortBy === 'rating') {
        conditions.push(`(rating ${comparison} ? OR (rating = ? AND id > ?))`);
        const rating = typeof input.cursor.sortValue === 'number' ? input.cursor.sortValue : 0;
        values.push(rating, rating, input.cursor.id);
      } else {
        conditions.push(`(modified_at ${comparison} ? OR (modified_at = ? AND id > ?))`);
        values.push(input.cursor.modifiedAt, input.cursor.modifiedAt, input.cursor.id);
      }
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const orderBy = input.sortBy === 'fileName'
      ? `name_sort_key ${direction}, id ASC`
      : input.sortBy === 'rating'
        ? `rating ${direction}, id ASC`
        : `modified_at ${direction}, id ASC`;
    const plainFolder = baseConditions.length === 2 && baseConditions[1] === 'folder_id = ?';
    const plainCatalog = baseConditions.length === 1;
    const browseField = input.sortBy === 'fileName' ? 'name' : input.sortBy === 'rating' ? 'rating' : 'modified';
    const browseDirection = direction === 'asc' ? 'asc' : 'desc';
    const browseIndex = plainFolder
      ? input.sortBy === 'fileName' ? `assets_browse_natural_name_${browseDirection}_idx` : `assets_browse_${browseField}_${browseDirection}_idx`
      : plainCatalog
        ? input.sortBy === 'fileName' ? `assets_browse_all_natural_name_${browseDirection}_idx` : `assets_browse_all_${browseField}_${browseDirection}_idx`
        : null;
    const indexedBy = browseIndex ? `INDEXED BY ${browseIndex}` : '';
    const rows = this.#database.prepare(`
      SELECT id, folder_id, path, file_name, extension, size_bytes, modified_at, rating, label_color, flag, favorite, offline_at,
        (SELECT width FROM asset_exif WHERE asset_id = assets.id AND source_size = assets.size_bytes AND source_modified_at = assets.modified_at) AS width,
        (SELECT height FROM asset_exif WHERE asset_id = assets.id AND source_size = assets.size_bytes AND source_modified_at = assets.modified_at) AS height
      FROM assets ${indexedBy} ${where}
      ORDER BY ${orderBy}
      LIMIT ? ${input.offset === undefined ? '' : 'OFFSET ?'}
    `).all(...values, input.limit + 1, ...(input.offset === undefined ? [] : [input.offset])) as AssetRow[];
    const hasMore = rows.length > input.limit;
    const pageRows = hasMore ? rows.slice(0, input.limit) : rows;
    const countWhere = baseConditions.length > 0 ? `WHERE ${baseConditions.join(' AND ')}` : '';
    const totalCount = this.#countAssets(countWhere, baseValues);
    const last = pageRows.at(-1);
    const sortValue = last
      ? input.sortBy === 'fileName'
        ? last.file_name
        : input.sortBy === 'rating'
          ? last.rating
          : undefined
      : undefined;
    return catalogAssetPageSchema.parse({
      items: this.#toAssets(pageRows),
      totalCount,
      nextCursor: hasMore && last ? { modifiedAt: last.modified_at, id: last.id, ...(sortValue === undefined ? {} : { sortValue }) } : null
    });
  }

  workflowFileLocations(): Map<string, { rootId: string; relativePath: string; ancestors: { id: string; relativePath: string }[] }> {
    const rows = this.#database.prepare(`SELECT a.id, a.folder_id, a.path, f.path AS root_path FROM assets a JOIN folders f ON f.id = a.folder_id WHERE a.removed_at IS NULL AND f.removed_at IS NULL`).all() as { id: string; folder_id: string; path: string; root_path: string }[];
    return new Map(rows.map((row) => {
      const relativePath = path.relative(row.root_path, row.path);
      const ancestors = [{ id: row.folder_id, relativePath: '' }];
      let directory = path.dirname(relativePath);
      while (directory !== '.' && directory && !directory.startsWith(`..${path.sep}`)) {
        ancestors.push({ id: stableDirectoryId(row.folder_id, directory), relativePath: directory.split(path.sep).join('/') });
        directory = path.dirname(directory);
      }
      return [row.id, { rootId: row.folder_id, relativePath: relativePath.split(path.sep).join('/'), ancestors }];
    }));
  }

  listFolders(): CatalogFolder[] {
    const version = this.#databaseVersion();
    if (this.#folderCache && this.#folderCacheVersion === version) return this.#folderCache;
    const roots = this.#database.prepare(`
      SELECT id, path, name FROM folders WHERE removed_at IS NULL
      ORDER BY name COLLATE NOCASE ASC, id ASC
    `).all() as { id: string; path: string; name: string }[];
    const rootCounts = new Map((this.#database.prepare(`
      SELECT folder_id, COUNT(*) AS asset_count,
        SUM(CASE WHEN offline_at IS NOT NULL THEN 1 ELSE 0 END) AS offline_count
      FROM assets WHERE removed_at IS NULL GROUP BY folder_id
    `).all() as { folder_id: string; asset_count: number; offline_count: number }[])
      .map((row) => [row.folder_id, row]));
    const paths = this.#database.prepare('SELECT path, offline_at FROM assets WHERE folder_id = ? AND removed_at IS NULL');
    const result: CatalogFolder[] = [];
    const lookup = new Map<string, { rootId: string; rootPath: string; relativePath: string }>();
    for (const root of roots) {
      lookup.set(root.id, { rootId: root.id, rootPath: root.path, relativePath: '' });
      const counts = rootCounts.get(root.id);
      result.push(catalogFolderSchema.parse({ id: root.id, name: root.name, assetCount: counts?.asset_count ?? 0, offlineCount: counts?.offline_count ?? 0, parentId: null, rootId: root.id, depth: 0, isRoot: true }));
      const directories = new Map<string, { assetCount: number; offlineCount: number }>();
      for (const item of this.#database.prepare('SELECT path FROM created_directories WHERE root_id = ?').all(root.id) as { path: string }[]) {
        let relative = path.relative(root.path, item.path);
        while (relative && relative !== '.' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) {
          directories.set(relative, { assetCount: 0, offlineCount: 0 });
          relative = path.dirname(relative);
        }
      }
      for (const asset of paths.iterate(root.id) as Iterable<{ path: string; offline_at: number | null }>) {
        const relativeDirectory = path.relative(root.path, path.dirname(asset.path));
        if (!relativeDirectory || relativeDirectory === '.' || relativeDirectory.startsWith(`..${path.sep}`) || path.isAbsolute(relativeDirectory)) continue;
        const parts = relativeDirectory.split(path.sep).filter(Boolean);
        for (let depth = 1; depth <= parts.length; depth += 1) {
          const relativePath = parts.slice(0, depth).join(path.sep);
          const current = directories.get(relativePath) ?? { assetCount: 0, offlineCount: 0 };
          current.assetCount += 1;
          if (asset.offline_at !== null) current.offlineCount += 1;
          directories.set(relativePath, current);
        }
      }
      for (const [relativePath, counts] of [...directories].sort(([left], [right]) => left.localeCompare(right))) {
        const parentPath = path.dirname(relativePath);
        const directoryId = stableDirectoryId(root.id, relativePath);
        lookup.set(directoryId, { rootId: root.id, rootPath: root.path, relativePath });
        result.push(catalogFolderSchema.parse({
          id: directoryId,
          name: path.basename(relativePath),
          assetCount: counts.assetCount,
          offlineCount: counts.offlineCount,
          parentId: parentPath === '.' ? root.id : stableDirectoryId(root.id, parentPath),
          rootId: root.id,
          depth: relativePath.split(path.sep).length,
          isRoot: false
        }));
      }
    }
    this.#folderCache = result;
    this.#folderCacheVersion = version;
    this.#directoryLookup = lookup;
    return result;
  }

  #resolveDirectory(directoryId: string): { rootId: string; rootPath: string; relativePath: string } | null {
    const root = this.#database.prepare('SELECT id, path FROM folders WHERE id = ? AND removed_at IS NULL').get(directoryId) as { id: string; path: string } | undefined;
    if (root) return { rootId: root.id, rootPath: root.path, relativePath: '' };
    if (!this.#folderCache || this.#folderCacheVersion !== this.#databaseVersion()) this.listFolders();
    return this.#directoryLookup.get(directoryId) ?? null;
  }

  unregisterFolder(folderId: string): UnregisterCatalogFolderReport {
    const folder = this.#database.prepare(`
      SELECT id FROM folders WHERE id = ? AND removed_at IS NULL
    `).get(folderId) as { id: string } | undefined;
    if (!folder) throw new Error('CATALOG_FOLDER_NOT_FOUND');
    const assetCount = (this.#database.prepare(`
      SELECT COUNT(*) AS value FROM assets WHERE folder_id = ? AND removed_at IS NULL
    `).get(folderId) as { value: number }).value;
    if (assetCount > 0 && this.#tableExists('tasks')) {
      const activeTask = this.#database.prepare(`
        SELECT 1 FROM tasks
        JOIN assets ON assets.id = tasks.asset_id
        WHERE assets.folder_id = ? AND assets.removed_at IS NULL
          AND tasks.status IN ('draft', 'queued', 'preparing', 'uploading', 'processing', 'downloading', 'saving')
        LIMIT 1
      `).get(folderId);
      if (activeTask) throw new Error('FOLDER_HAS_ACTIVE_TASKS');
    }
    if (this.#tableExists('file_operations') && this.#tableExists('file_operation_items')) {
      const activeOperation = this.#database.prepare(`
        SELECT 1 FROM file_operation_items items
        JOIN file_operations operations ON operations.id = items.operation_id
        WHERE (items.source_folder_id = ? OR items.destination_folder_id = ?)
          AND operations.status IN ('planned', 'executing', 'compensating', 'undoing')
        LIMIT 1
      `).get(folderId, folderId);
      if (activeOperation) throw new Error('FOLDER_HAS_ACTIVE_FILE_OPERATIONS');
    }
    const now = Date.now();
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      this.#database.prepare(`
        UPDATE assets SET removed_at = ?, trashed_at = NULL WHERE folder_id = ? AND removed_at IS NULL
      `).run(now, folderId);
      const result = this.#database.prepare(`
        UPDATE folders SET removed_at = ? WHERE id = ? AND removed_at IS NULL
      `).run(now, folderId);
      if (result.changes !== 1) throw new Error('CATALOG_CONCURRENT_CHANGE');
      this.#database.exec('COMMIT');
    } catch (error) {
      this.#database.exec('ROLLBACK');
      throw error;
    }
    return unregisterCatalogFolderReportSchema.parse({ folderId, assetCount });
  }

  async trashFolder(folderId: string, trashItem: (folderPath: string) => Promise<void>): Promise<void> {
    const directory = this.#resolveDirectory(folderId);
    if (!directory) throw new Error('CATALOG_FOLDER_NOT_FOUND');
    const folderPath = path.join(directory.rootPath, directory.relativePath);
    const prefix = `${escapeLike(folderPath + path.sep)}%`;
    if (this.#tableExists('tasks')) {
      const activeTask = this.#database.prepare(`
        SELECT 1 FROM tasks JOIN assets ON assets.id = tasks.asset_id
        WHERE assets.folder_id = ? AND assets.removed_at IS NULL
          AND assets.path LIKE ? ESCAPE '\\'
          AND tasks.status IN ('draft', 'queued', 'preparing', 'uploading', 'processing', 'downloading', 'saving')
        LIMIT 1
      `).get(directory.rootId, prefix);
      if (activeTask) throw new Error('FOLDER_HAS_ACTIVE_TASKS');
    }
    if (this.#tableExists('file_operations') && this.#tableExists('file_operation_items')) {
      const activeOperation = this.#database.prepare(`
        SELECT 1 FROM file_operation_items items
        JOIN file_operations operations ON operations.id = items.operation_id
        WHERE (items.source_folder_id = ? OR items.destination_folder_id = ?)
          AND operations.status IN ('planned', 'executing', 'compensating', 'undoing')
        LIMIT 1
      `).get(directory.rootId, directory.rootId);
      if (activeOperation) throw new Error('FOLDER_HAS_ACTIVE_FILE_OPERATIONS');
    }
    await trashItem(folderPath);
    const now = Date.now();
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      if (directory.relativePath) {
        this.#database.prepare(`
          UPDATE assets SET removed_at = ?, trashed_at = ?
          WHERE folder_id = ? AND removed_at IS NULL AND path LIKE ? ESCAPE '\\'
        `).run(now, now, directory.rootId, prefix);
        this.#database.prepare(`
          DELETE FROM created_directories WHERE root_id = ? AND (path = ? OR path LIKE ? ESCAPE '\\')
        `).run(directory.rootId, folderPath, prefix);
      } else {
        this.#database.prepare('UPDATE assets SET removed_at = ?, trashed_at = ? WHERE folder_id = ? AND removed_at IS NULL')
          .run(now, now, directory.rootId);
        this.#database.prepare('UPDATE folders SET removed_at = ? WHERE id = ? AND removed_at IS NULL')
          .run(now, directory.rootId);
      }
      this.#database.exec('COMMIT');
    } catch (error) {
      this.#database.exec('ROLLBACK');
      throw error;
    }
  }

  async relinkFolder(folderId: string, requestedPath: string): Promise<RelinkCatalogFolderOperationResult> {
    const directory = this.#resolveDirectory(folderId);
    if (directory?.relativePath) return this.#relinkChildFolder(folderId, directory, requestedPath);
    const folder = this.#database.prepare('SELECT id, path FROM folders WHERE id = ? AND removed_at IS NULL')
      .get(folderId) as { id: string; path: string } | undefined;
    if (!folder) throw new Error('CATALOG_FOLDER_NOT_FOUND');
    const nextRoot = await realpath(requestedPath);
    if (!(await stat(nextRoot)).isDirectory()) throw new Error('TARGET_NOT_DIRECTORY');
    const collision = this.#database.prepare('SELECT id FROM folders WHERE path = ? AND id <> ?').get(nextRoot, folderId);
    if (collision) throw new Error('RELINK_TARGET_ALREADY_IMPORTED');

    const existing = this.#database.prepare(`
      SELECT id, path, file_name, size_bytes, modified_at, content_hash FROM assets WHERE folder_id = ? AND removed_at IS NULL
    `).all(folderId) as RelinkAsset[];
    const exact = new Map(existing.map((asset) => [path.relative(folder.path, asset.path), asset]));
    const normalized = new Map<string, RelinkAsset | null>();
    for (const [relative, asset] of exact) {
      const key = normalizeRelativePath(relative);
      normalized.set(key, normalized.has(key) ? null : asset);
    }
    const files: RelinkFile[] = [];
    for await (const filePath of walkImages(nextRoot)) {
      const metadata = await stat(filePath);
      files.push({ path: filePath, relative: path.relative(nextRoot, filePath), size: metadata.size, modifiedAt: Math.trunc(metadata.mtimeMs) });
    }
    const foreignPath = this.#database.prepare('SELECT folder_id FROM assets WHERE path = ? AND folder_id <> ? LIMIT 1');
    for (const file of files) {
      if (foreignPath.get(file.path, folderId)) throw new Error('RELINK_PATH_ALREADY_CATALOGED');
    }

    const matches = new Map<string, RelinkAsset>();
    const usedAssetIds = new Set<string>();
    for (const file of files) {
      const asset = exact.get(file.relative) ?? normalized.get(normalizeRelativePath(file.relative));
      if (!asset || usedAssetIds.has(asset.id)) continue;
      matches.set(file.path, asset);
      usedAssetIds.add(asset.id);
    }
    const remainingAssets = groupUnique(existing.filter((asset) => !usedAssetIds.has(asset.id)), relinkMetadataKey);
    const remainingFiles = groupUnique(files.filter((file) => !matches.has(file.path)), relinkMetadataKey);
    for (const [key, asset] of remainingAssets) {
      const file = remainingFiles.get(key);
      if (!asset || !file) continue;
      matches.set(file.path, asset);
      usedAssetIds.add(asset.id);
    }

    const hashAssets = groupUnique(
      existing.filter((asset) => !usedAssetIds.has(asset.id) && asset.content_hash),
      (asset) => asset.content_hash!
    );
    const relevantSizes = new Set(
      existing.filter((asset) => !usedAssetIds.has(asset.id) && asset.content_hash).map((asset) => asset.size_bytes)
    );
    const hashFiles: RelinkFile[] = [];
    for (const file of files) {
      if (matches.has(file.path) || !relevantSizes.has(file.size)) continue;
      try {
        file.contentHash = await hashFile(file.path);
        hashFiles.push(file);
      } catch {
        // Unreadable candidates remain unmatched and are handled as new files.
      }
    }
    const uniqueHashFiles = groupUnique(hashFiles, (file) => file.contentHash!);
    for (const [hash, asset] of hashAssets) {
      const file = uniqueHashFiles.get(hash);
      if (!asset || !file) continue;
      matches.set(file.path, asset);
      usedAssetIds.add(asset.id);
    }

    let matched = 0;
    let discovered = 0;
    const relocations: RelinkCatalogFolderOperationResult['relocations'] = [];
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      this.#database.prepare('UPDATE folders SET path = ?, name = ? WHERE id = ?')
        .run(nextRoot, path.basename(nextRoot), folderId);
      this.#relocateCreatedDirectories(folderId, folder.path, folderId, nextRoot);
      this.#database.prepare('UPDATE assets SET offline_at = ? WHERE folder_id = ? AND removed_at IS NULL')
        .run(Date.now(), folderId);
      const update = this.#database.prepare(`
        UPDATE assets SET path = ?, file_name = ?, name_sort_key = NULL, extension = ?,
          content_hash = CASE WHEN size_bytes = ? AND modified_at = ? THEN COALESCE(?, content_hash) ELSE ? END,
          size_bytes = ?, modified_at = ?, offline_at = NULL
        WHERE id = ?
      `);
      const insert = this.#database.prepare(`
        INSERT OR IGNORE INTO assets (
          id, folder_id, path, file_name, extension, size_bytes, modified_at, imported_at, offline_at, content_hash
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
      `);
      for (const file of files) {
        const asset = matches.get(file.path);
        if (asset) {
          const nextFileName = path.basename(file.path);
          update.run(
            file.path, nextFileName, path.extname(file.path).toLowerCase(),
            file.size, file.modifiedAt, file.contentHash ?? null, file.contentHash ?? null,
            file.size, file.modifiedAt, asset.id
          );
          relocations.push({
            assetId: asset.id,
            previousPath: asset.path,
            nextPath: file.path,
            previousFileName: asset.file_name,
            nextFileName
          });
          matched += 1;
        } else if (insert.run(randomUUID(), folderId, file.path, path.basename(file.path), path.extname(file.path).toLowerCase(), file.size, file.modifiedAt, Date.now(), file.contentHash ?? null).changes === 1) {
          discovered += 1;
        }
      }
      this.#database.exec('COMMIT');
    } catch (error) {
      this.#database.exec('ROLLBACK');
      throw error;
    }
    const relinked = this.listFolders().find((item) => item.id === folderId);
    if (!relinked) throw new Error('CATALOG_FOLDER_NOT_FOUND');
    return {
      ...relinkCatalogFolderResultSchema.parse({ folder: relinked, matched, discovered, offline: relinked.offlineCount }),
      relocations
    };
  }

  async #relinkChildFolder(
    folderId: string,
    directory: { rootId: string; rootPath: string; relativePath: string },
    requestedPath: string
  ): Promise<RelinkCatalogFolderOperationResult> {
    const oldPath = path.join(directory.rootPath, directory.relativePath);
    const nextPath = await realpath(requestedPath);
    if (!(await stat(nextPath)).isDirectory()) throw new Error('TARGET_NOT_DIRECTORY');
    if (!nextPath.startsWith(`${directory.rootPath}${path.sep}`) || nextPath === oldPath)
      throw new Error('RELINK_TARGET_OUTSIDE_ASSOCIATED_ROOT');
    if (await stat(oldPath).then(() => true).catch(() => false)) throw new Error('RELINK_SOURCE_STILL_PRESENT');
    const prefix = `${oldPath}${path.sep}`;
    const existing = (this.#database.prepare(`
      SELECT id, path, file_name, size_bytes, modified_at, content_hash FROM assets
      WHERE folder_id = ? AND path >= ? AND path < ? AND removed_at IS NULL
    `).all(directory.rootId, prefix, `${prefix}\uffff`) as RelinkAsset[]);
    const files: RelinkFile[] = [];
    for await (const filePath of walkImages(nextPath)) {
      const metadata = await stat(filePath);
      files.push({ path: filePath, relative: path.relative(nextPath, filePath), size: metadata.size, modifiedAt: Math.trunc(metadata.mtimeMs) });
    }
    const exact = new Map(existing.map((asset) => [path.relative(oldPath, asset.path), asset]));
    const matches = new Map<string, RelinkAsset>();
    const usedAssetIds = new Set<string>();
    for (const file of files) {
      const asset = exact.get(file.relative);
      if (!asset) continue;
      matches.set(file.path, asset);
      usedAssetIds.add(asset.id);
    }
    const remainingAssets = groupUnique(existing.filter((asset) => !usedAssetIds.has(asset.id)), relinkMetadataKey);
    const remainingFiles = groupUnique(files.filter((file) => !matches.has(file.path)), relinkMetadataKey);
    for (const [key, asset] of remainingAssets) {
      const file = remainingFiles.get(key);
      if (!asset || !file) continue;
      matches.set(file.path, asset);
      usedAssetIds.add(asset.id);
    }
    const indexed = this.#database.prepare('SELECT id, rating, favorite, label_color, flag FROM assets WHERE path = ? AND removed_at IS NULL');
    for (const file of files) {
      const target = indexed.get(file.path) as { id: string; rating: number; favorite: number; label_color: string | null; flag: string } | undefined;
      if (!target || target.id === matches.get(file.path)?.id) continue;
      if (!matches.has(file.path)) continue;
      const hasLinks = ['asset_tags', 'album_assets', 'analysis_revisions', 'generation_results', 'generation_write_intents', 'tasks', 'file_operation_items'].some((table) =>
        this.#tableExists(table) && Boolean(this.#database.prepare(`SELECT 1 FROM ${table} WHERE asset_id = ? LIMIT 1`).get(target.id))
      ) || (this.#tableExists('file_operation_items') && Boolean(this.#database.prepare('SELECT 1 FROM file_operation_items WHERE result_asset_id = ? LIMIT 1').get(target.id)));
      if (target.rating || target.favorite || target.label_color || target.flag !== 'unflagged' || hasLinks)
        throw new Error('RELINK_TARGET_HAS_EDITED_ASSETS');
    }
    const scopeChanges = this.#scopeRelocations(oldPath, nextPath, directory.rootId, directory.rootPath);
    const relocations: RelinkCatalogFolderOperationResult['relocations'] = [];
    let discovered = 0;
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      const removeDuplicate = this.#database.prepare('DELETE FROM assets WHERE path = ? AND id <> ?');
      const update = this.#database.prepare(`
        UPDATE assets SET path = ?, file_name = ?, name_sort_key = NULL, extension = ?, size_bytes = ?, modified_at = ?, offline_at = NULL,
          content_hash = CASE WHEN size_bytes = ? AND modified_at = ? THEN content_hash ELSE NULL END WHERE id = ?
      `);
      const insert = this.#database.prepare(`
        INSERT OR IGNORE INTO assets (id, folder_id, path, file_name, extension, size_bytes, modified_at, imported_at, offline_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
      `);
      for (const file of files) {
        const asset = matches.get(file.path);
        if (asset) {
          const duplicate = indexed.get(file.path) as { id: string } | undefined;
          if (duplicate && duplicate.id !== asset.id) {
            this.#database.prepare('DELETE FROM asset_search WHERE asset_id = ?').run(duplicate.id);
            this.#database.prepare('DELETE FROM asset_search_tokens WHERE asset_id = ?').run(duplicate.id);
          }
          removeDuplicate.run(file.path, asset.id);
          const nextFileName = path.basename(file.path);
          update.run(file.path, nextFileName, path.extname(file.path).toLowerCase(), file.size, file.modifiedAt,
            file.size, file.modifiedAt, asset.id);
          relocations.push({ assetId: asset.id, previousPath: asset.path, nextPath: file.path,
            previousFileName: asset.file_name, nextFileName });
        } else if (insert.run(randomUUID(), directory.rootId, file.path, path.basename(file.path),
          path.extname(file.path).toLowerCase(), file.size, file.modifiedAt, Date.now()).changes === 1) discovered += 1;
      }
      this.#relocateCreatedDirectories(directory.rootId, oldPath, directory.rootId, nextPath);
      this.#applyScopeRelocations(scopeChanges);
      this.#database.exec('COMMIT');
    } catch (error) {
      this.#database.exec('ROLLBACK');
      throw error;
    }
    const nextId = stableDirectoryId(directory.rootId, path.relative(directory.rootPath, nextPath));
    const folder = this.listFolders().find((item) => item.id === nextId);
    if (!folder) throw new Error('CATALOG_FOLDER_NOT_FOUND');
    return { ...relinkCatalogFolderResultSchema.parse({ folder, matched: matches.size, discovered, offline: folder.offlineCount }), relocations };
  }

  #ensureCreatedDirectories(): void {
    this.#database.exec('CREATE TABLE IF NOT EXISTS created_directories (root_id TEXT NOT NULL REFERENCES folders(id) ON DELETE CASCADE, path TEXT NOT NULL, PRIMARY KEY(root_id, path))');
  }

  #relocateCreatedDirectories(rootId: string, oldPath: string, nextRootId: string, nextPath: string): void {
    const rows = this.#database.prepare('SELECT path FROM created_directories WHERE root_id = ?').all(rootId) as { path: string }[];
    for (const row of rows) {
      if (row.path !== oldPath && !row.path.startsWith(`${oldPath}${path.sep}`)) continue;
      this.#database.prepare('DELETE FROM created_directories WHERE root_id = ? AND path = ?').run(rootId, row.path);
      this.#database.prepare('INSERT OR IGNORE INTO created_directories (root_id, path) VALUES (?, ?)').run(nextRootId, nextPath + row.path.slice(oldPath.length));
    }
  }

  async createFolder(input: CreateCatalogFolderInput): Promise<RenameCatalogFolderResult> {
    const parent = this.#resolveDirectory(input.parentFolderId);
    if (!parent) throw new Error('CATALOG_FOLDER_NOT_FOUND');
    const parentPath = path.join(parent.rootPath, parent.relativePath);
    for (let suffix = 1; ; suffix += 1) {
      const name = suffix === 1 ? '新建文件夹' : `新建文件夹 ${suffix}`;
      const destination = path.join(parentPath, name);
      try { await mkdir(destination); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
        throw error;
      }
      try {
        this.#database.prepare('INSERT INTO created_directories (root_id, path) VALUES (?, ?)').run(parent.rootId, destination);
      } catch (error) { await rmdir(destination).catch(() => undefined); throw error; }
      const id = stableDirectoryId(parent.rootId, path.relative(parent.rootPath, destination));
      return { folder: this.listFolders().find((folder) => folder.id === id)! };
    }
  }

  async renameFolder(input: RenameCatalogFolderInput): Promise<RenameCatalogFolderResult & { relocations: MoveCatalogFolderOperationResult['relocations'] }> {
    if (!input.name.trim() || input.name === '.' || input.name === '..' || /[\\/]/u.test(input.name) || input.name.includes('\0')) throw new Error('INVALID_FOLDER_NAME');
    const directory = this.#resolveDirectory(input.folderId);
    if (!directory) throw new Error('CATALOG_FOLDER_NOT_FOUND');
    const oldPath = path.join(directory.rootPath, directory.relativePath);
    const nextPath = path.join(path.dirname(oldPath), input.name);
    const scopeChanges = this.#scopeRelocations(oldPath, nextPath, directory.rootId, directory.relativePath ? directory.rootPath : nextPath);
    if (oldPath === nextPath) {
      const folder = this.listFolders().find((item) => item.id === input.folderId);
      if (!folder) throw new Error('CATALOG_FOLDER_NOT_FOUND');
      return { folder, relocations: [] };
    }
    try {
      await stat(nextPath);
      throw new Error('FOLDER_NAME_ALREADY_EXISTS');
    } catch (error) {
      if (error instanceof Error && error.message === 'FOLDER_NAME_ALREADY_EXISTS') throw error;
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await rename(oldPath, nextPath);
    const prefix = `${oldPath}${path.sep}`;
    const nextPrefix = `${nextPath}${path.sep}`;
    const relocations: MoveCatalogFolderOperationResult['relocations'] = [];
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      const assets = this.#database.prepare('SELECT id, path FROM assets WHERE folder_id = ? AND removed_at IS NULL').all(directory.rootId) as Array<{ id: string; path: string }>;
      const updateAsset = this.#database.prepare('UPDATE assets SET path = ?, offline_at = NULL WHERE id = ?');
      for (const asset of assets) {
        const relocated = asset.path === oldPath ? nextPath : asset.path.startsWith(prefix) ? `${nextPrefix}${asset.path.slice(prefix.length)}` : null;
        if (relocated) {
          updateAsset.run(relocated, asset.id);
          relocations.push({ assetId: asset.id, previousPath: asset.path, nextPath: relocated, previousFileName: path.basename(asset.path), nextFileName: path.basename(relocated) });
        }
      }
      if (directory.relativePath === '') this.#database.prepare('UPDATE folders SET path = ?, name = ? WHERE id = ?').run(nextPath, input.name, directory.rootId);
      this.#relocateCreatedDirectories(directory.rootId, oldPath, directory.rootId, nextPath);
      this.#applyScopeRelocations(scopeChanges);
      this.#database.exec('COMMIT');
    } catch (error) {
      this.#database.exec('ROLLBACK');
      try { await rename(nextPath, oldPath); } catch { /* preserve the database error */ }
      throw error;
    }
    const nextId = directory.relativePath ? stableDirectoryId(directory.rootId, path.relative(directory.rootPath, nextPath)) : directory.rootId;
    const folder = this.listFolders().find((item) => item.id === nextId);
    if (!folder) throw new Error('CATALOG_FOLDER_NOT_FOUND');
    return { folder, relocations };
  }

  async moveFolder(input: MoveCatalogFolderInput): Promise<MoveCatalogFolderOperationResult> {
    if (input.sourceFolderId === input.targetFolderId) throw new Error('FOLDER_MOVE_INTO_SELF');
    const source = this.#resolveDirectory(input.sourceFolderId);
    const target = this.#resolveDirectory(input.targetFolderId);
    if (!source || !target) throw new Error('CATALOG_FOLDER_NOT_FOUND');
    const sourcePath = path.join(source.rootPath, source.relativePath);
    const targetPath = path.join(target.rootPath, target.relativePath);
    const nextPath = path.join(targetPath, path.basename(sourcePath));
    const scopeChanges = this.#scopeRelocations(sourcePath, nextPath, target.rootId, target.rootPath);
    const sourcePrefix = `${sourcePath}${path.sep}`;
    if (targetPath === sourcePath || targetPath.startsWith(sourcePrefix)) throw new Error('FOLDER_MOVE_INTO_DESCENDANT');
    if (path.dirname(sourcePath) === targetPath) throw new Error('FOLDER_ALREADY_IN_TARGET');
    try {
      await stat(nextPath);
      throw new Error('FOLDER_NAME_ALREADY_EXISTS');
    } catch (error) {
      if (error instanceof Error && error.message === 'FOLDER_NAME_ALREADY_EXISTS') throw error;
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const affected = (this.#database.prepare(`
      SELECT id, path, file_name FROM assets WHERE folder_id = ? AND removed_at IS NULL
    `).all(source.rootId) as Array<{ id: string; path: string; file_name: string }>).filter((asset) => asset.path === sourcePath || asset.path.startsWith(sourcePrefix));
    await rename(sourcePath, nextPath);
    const nextPrefix = `${nextPath}${path.sep}`;
    const relocations = affected.map((asset) => {
      const nextAssetPath = asset.path === sourcePath ? nextPath : `${nextPrefix}${asset.path.slice(sourcePrefix.length)}`;
      return { assetId: asset.id, previousPath: asset.path, nextPath: nextAssetPath, previousFileName: asset.file_name, nextFileName: path.basename(nextAssetPath) };
    });
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      const update = this.#database.prepare('UPDATE assets SET folder_id = ?, path = ?, offline_at = NULL WHERE id = ?');
      for (const item of relocations) update.run(target.rootId, item.nextPath, item.assetId);
      this.#relocateCreatedDirectories(source.rootId, sourcePath, target.rootId, nextPath);
      this.#applyScopeRelocations(scopeChanges);
      this.#database.prepare('INSERT OR IGNORE INTO created_directories (root_id, path) VALUES (?, ?)').run(target.rootId, nextPath);
      if (source.relativePath === '') this.#database.prepare('UPDATE folders SET removed_at = ? WHERE id = ? AND removed_at IS NULL').run(Date.now(), source.rootId);
      this.#database.exec('COMMIT');
    } catch (error) {
      this.#database.exec('ROLLBACK');
      try { await rename(nextPath, sourcePath); } catch { /* preserve the database error */ }
      throw error;
    }
    const relativePath = path.relative(target.rootPath, nextPath);
    const nextId = relativePath ? stableDirectoryId(target.rootId, relativePath) : target.rootId;
    const folder = this.listFolders().find((item) => item.id === nextId);
    if (!folder) throw new Error('CATALOG_FOLDER_NOT_FOUND');
    return { folder, relocations };
  }

  listFolderPaths(): string[] {
    return (this.#database.prepare('SELECT path FROM folders WHERE removed_at IS NULL ORDER BY path').all() as { path: string }[]).map((row) => row.path);
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
    const rows = this.#database.prepare('SELECT id, name, rule_json, is_default FROM smart_collections ORDER BY is_default DESC, created_at, name COLLATE NOCASE').all() as Array<{ id: string; name: string; rule_json: string; is_default: number }>;
    let missingExif: boolean | null = null;
    return rows.map((row) => {
      const rule = smartCollectionRuleSchema.parse(JSON.parse(row.rule_json));
      const { sql, values } = this.#compileSmartCollection(rule);
      const count = this.#database.prepare(`SELECT COUNT(*) AS value FROM assets WHERE removed_at IS NULL AND (${sql})`).get(...values) as { value: number };
      if (rule.conditions.some((condition) => EXIF_FIELDS.has(condition.field)) && missingExif === null) missingExif = this.listExifIndexCandidates(1).length > 0;
      return catalogSmartCollectionSchema.parse({ id: row.id, name: row.name, rule, assetCount: count.value, isDefault: Boolean(row.is_default), indexing: rule.conditions.some((condition) => EXIF_FIELDS.has(condition.field)) && missingExif });
    });
  }

  hasExifSmartCollections(): boolean {
    const rows = this.#database.prepare('SELECT rule_json FROM smart_collections').all() as Array<{ rule_json: string }>;
    return rows.some((row) => smartCollectionRuleSchema.parse(JSON.parse(row.rule_json)).conditions.some((condition) => EXIF_FIELDS.has(condition.field)));
  }

  listExifIndexCandidates(limit = 16, afterId = ''): string[] {
    return (this.#database.prepare(`
      SELECT assets.id FROM assets LEFT JOIN asset_exif ON asset_exif.asset_id = assets.id
      WHERE assets.removed_at IS NULL AND assets.offline_at IS NULL
        AND assets.id > ? AND (asset_exif.asset_id IS NULL OR asset_exif.source_size != assets.size_bytes OR asset_exif.source_modified_at != assets.modified_at)
      ORDER BY assets.id LIMIT ?
    `).all(afterId, limit) as Array<{ id: string }>).map((row) => row.id);
  }

  saveExifDetails(assetId: string, details: FileDetails): void {
    const asset = this.resolveAssetFile(assetId);
    if (!asset || asset.sizeBytes !== details.sizeBytes || asset.modifiedAt !== Math.trunc(details.modifiedAt)) return;
    this.#database.prepare(`
      INSERT INTO asset_exif (asset_id, source_size, source_modified_at, width, height, camera_make, camera_model, lens_make, lens_model, city, country, taken_at, exposure_seconds, aperture, focal_length, iso)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(asset_id) DO UPDATE SET
        source_size = excluded.source_size, source_modified_at = excluded.source_modified_at,
        width = excluded.width, height = excluded.height, camera_make = excluded.camera_make, camera_model = excluded.camera_model,
        lens_make = excluded.lens_make, lens_model = excluded.lens_model, city = excluded.city, country = excluded.country,
        taken_at = excluded.taken_at, exposure_seconds = excluded.exposure_seconds, aperture = excluded.aperture,
        focal_length = excluded.focal_length, iso = excluded.iso
    `).run(assetId, asset.sizeBytes, asset.modifiedAt, details.width ?? null, details.height ?? null,
      details.cameraMake ?? null, details.cameraModel ?? null, details.lensMake ?? null, details.lensModel ?? null,
      details.city ?? null, details.country ?? null, details.takenAt ? Date.parse(details.takenAt) : null,
      details.exposureSeconds ?? null, details.aperture ?? null, details.focalLength ?? null, details.iso ?? null);
    this.#countCache.clear();
  }

  hasCurrentDimensions(assetId: string): boolean {
    return Boolean(this.#database.prepare(`
      SELECT 1 FROM assets JOIN asset_exif ON asset_exif.asset_id = assets.id
      WHERE assets.id = ? AND assets.removed_at IS NULL AND assets.size_bytes = asset_exif.source_size
        AND assets.modified_at = asset_exif.source_modified_at AND asset_exif.width > 0 AND asset_exif.height > 0
    `).get(assetId));
  }

  saveSmartCollection(rawInput: SaveSmartCollectionInput): CatalogSmartCollection {
    const input = saveSmartCollectionInputSchema.parse(rawInput);
    this.#compileSmartCollection(input.rule);
    const id = input.id ?? randomUUID();
    const now = Date.now();
    if (input.id) {
      if (!this.#database.prepare('SELECT 1 FROM smart_collections WHERE id = ?').get(id)) throw new Error('SMART_COLLECTION_NOT_FOUND');
      this.#database.prepare('UPDATE smart_collections SET name = ?, rule_json = ?, updated_at = ? WHERE id = ?').run(input.name, JSON.stringify(input.rule), now, id);
    } else {
      this.#database.prepare('INSERT INTO smart_collections (id, name, rule_json, is_default, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)').run(id, input.name, JSON.stringify(input.rule), now, now);
    }
    return this.listSmartCollections().find((item) => item.id === id)!;
  }

  deleteSmartCollection(id: string): void {
    this.#database.prepare('DELETE FROM smart_collections WHERE id = ?').run(id);
  }

  #findSmartCollectionRule(id: string): SmartCollectionRule | null {
    const row = this.#database.prepare('SELECT rule_json FROM smart_collections WHERE id = ?').get(id) as { rule_json: string } | undefined;
    return row ? smartCollectionRuleSchema.parse(JSON.parse(row.rule_json)) : null;
  }

  #scopeRelocations(sourcePath: string, nextPath: string, targetRootId: string, targetRootPath: string): Map<string, string> {
    const changes = new Map<string, string>();
    for (const folder of this.listFolders()) {
      const directory = this.#resolveDirectory(folder.id);
      if (!directory) continue;
      const currentPath = path.join(directory.rootPath, directory.relativePath);
      if (currentPath !== sourcePath && !currentPath.startsWith(`${sourcePath}${path.sep}`)) continue;
      const relocated = currentPath === sourcePath ? nextPath : path.join(nextPath, path.relative(sourcePath, currentPath));
      const relative = path.relative(targetRootPath, relocated);
      changes.set(folder.id, relative && relative !== '.' ? stableDirectoryId(targetRootId, relative) : targetRootId);
    }
    return changes;
  }

  #applyScopeRelocations(changes: Map<string, string>): void {
    if (!changes.size) return;
    const rows = this.#database.prepare('SELECT id, rule_json FROM smart_collections').all() as Array<{ id: string; rule_json: string }>;
    const update = this.#database.prepare('UPDATE smart_collections SET rule_json = ?, updated_at = ? WHERE id = ?');
    for (const row of rows) {
      const rule = smartCollectionRuleSchema.parse(JSON.parse(row.rule_json));
      const nextIds = [...new Set(rule.scope.folderIds.map((id) => changes.get(id) ?? id))];
      if (nextIds.every((id, index) => id === rule.scope.folderIds[index]) && nextIds.length === rule.scope.folderIds.length) continue;
      update.run(JSON.stringify({ ...rule, scope: { ...rule.scope, folderIds: nextIds } }), Date.now(), row.id);
    }
  }

  #compileSmartCollection(rule: SmartCollectionRule): { sql: string; values: Array<string | number> } {
    const values: Array<string | number> = [];
    const scopeParts: string[] = [];
    if (rule.scope.all) scopeParts.push('1');
    if (rule.scope.favorites) scopeParts.push('favorite = 1');
    if (rule.scope.folders) scopeParts.push('folder_id IN (SELECT id FROM folders WHERE removed_at IS NULL)');
    if (rule.scope.albums) scopeParts.push('id IN (SELECT asset_id FROM album_assets)');
    for (const id of rule.scope.folderIds) {
      const directory = this.#resolveDirectory(id);
      if (!directory) continue;
      if (!directory.relativePath) {
        scopeParts.push('folder_id = ?');
        values.push(directory.rootId);
      } else {
        const absolute = path.join(directory.rootPath, directory.relativePath);
        scopeParts.push("(folder_id = ? AND (path LIKE ? ESCAPE '\\' OR path = ?))");
        values.push(directory.rootId, `${escapeLike(absolute + path.sep)}%`, absolute);
      }
    }
    if (rule.scope.albumIds.length) {
      scopeParts.push(`id IN (SELECT asset_id FROM album_assets WHERE album_id IN (${rule.scope.albumIds.map(() => '?').join(',')}))`);
      values.push(...rule.scope.albumIds);
    }
    const conditions: string[] = [];
    for (const condition of rule.conditions) {
      const { field, operator, value } = condition;
      const compare = (expression: string, kind: 'number' | 'string' | 'boolean'): string => {
        if (operator === 'isSet' || operator === 'isNotSet') return `${expression} IS ${operator === 'isSet' ? 'NOT ' : ''}NULL`;
        if (kind === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) throw new Error('SMART_COLLECTION_INVALID_VALUE');
        if (kind === 'string' && typeof value !== 'string') throw new Error('SMART_COLLECTION_INVALID_VALUE');
        if (kind === 'boolean' && typeof value !== 'boolean') throw new Error('SMART_COLLECTION_INVALID_VALUE');
        if (operator === 'regex') {
          if (kind !== 'string' || typeof value !== 'string') throw new Error('SMART_COLLECTION_INVALID_OPERATOR');
          validateSmartRegex(value);
          values.push(value);
          return `smart_regexp(?, ${expression}) = 1`;
        }
        if (operator === 'contains' || operator === 'notContains' || operator === 'startsWith' || operator === 'endsWith') {
          if (kind !== 'string') throw new Error('SMART_COLLECTION_INVALID_OPERATOR');
          const escaped = escapeLike(value as string);
          values.push(operator === 'startsWith' ? `${escaped}%` : operator === 'endsWith' ? `%${escaped}` : `%${escaped}%`);
          return `${expression} ${operator === 'notContains' ? 'NOT ' : ''}LIKE ? ESCAPE '\\'`;
        }
        const sqlOperator = { eq: '=', ne: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=' }[operator];
        if (!sqlOperator || (kind === 'boolean' && !['eq', 'ne'].includes(operator))) throw new Error('SMART_COLLECTION_INVALID_OPERATOR');
        values.push(kind === 'boolean' ? Number(value) : value as string | number);
        return `${expression}${kind === 'string' ? ' COLLATE NOCASE' : ''} ${sqlOperator} ?`;
      };
      const columns: Partial<Record<typeof field, [string, 'number' | 'string' | 'boolean']>> = {
        rating: ['rating', 'number'], favorite: ['favorite', 'boolean'], flag: ['flag', 'string'], labelColor: ['label_color', 'string'],
        fileName: ['file_name', 'string'], format: ["SUBSTR(extension, 2)", 'string'], sizeBytes: ['size_bytes', 'number'],
        modifiedAt: ['modified_at', 'number'], importedAt: ['imported_at', 'number'], offline: ['(offline_at IS NOT NULL)', 'boolean']
      };
      if (columns[field]) {
        const [expression, kind] = columns[field]!;
        conditions.push(compare(expression, kind));
      } else if (EXIF_FIELDS.has(field)) {
        const exifColumns: Record<string, [string, 'number' | 'string']> = {
          width: ['width', 'number'], height: ['height', 'number'], cameraMake: ['camera_make', 'string'],
          cameraModel: ['camera_model', 'string'], lensMake: ['lens_make', 'string'], lensModel: ['lens_model', 'string'],
          city: ['city', 'string'], country: ['country', 'string'], takenAt: ['taken_at', 'number'],
          exposureSeconds: ['exposure_seconds', 'number'], aperture: ['aperture', 'number'], focalLength: ['focal_length', 'number'], iso: ['iso', 'number']
        };
        const [column, kind] = exifColumns[field]!;
        const comparison = compare(`asset_exif.${column}`, kind);
        conditions.push(`EXISTS (SELECT 1 FROM asset_exif WHERE asset_exif.asset_id = assets.id AND asset_exif.source_size = assets.size_bytes AND asset_exif.source_modified_at = assets.modified_at AND ${comparison})`);
      } else if (field === 'importedWithinDays') {
        if (typeof value !== 'number' || value < 0 || !Number.isFinite(value) || operator !== 'lte') throw new Error('SMART_COLLECTION_INVALID_VALUE');
        values.push(Date.now() - value * 86_400_000);
        conditions.push('imported_at >= ?');
      } else if (field === 'analyzed' || field === 'generated') {
        if (typeof value !== 'boolean' || !['eq', 'ne'].includes(operator)) throw new Error('SMART_COLLECTION_INVALID_VALUE');
        const table = field === 'analyzed' ? 'analysis_revisions' : 'generation_results';
        const exists = this.#tableExists(table);
        const active = field === 'generated' && exists && this.#columnExists(table, 'trashed_at') ? ' AND trashed_at IS NULL' : '';
        const expression = exists ? `EXISTS (SELECT 1 FROM ${table} WHERE asset_id = assets.id${active})` : '0';
        conditions.push((operator === 'eq') === value ? expression : `NOT (${expression})`);
      } else if (field === 'reviewState') {
        if (typeof value !== 'string' || !['undecided', 'accepted', 'preferred', 'rejected'].includes(value) || !['eq', 'ne'].includes(operator)) throw new Error('SMART_COLLECTION_INVALID_VALUE');
        if (!this.#tableExists('generation_results')) { conditions.push('0'); continue; }
        const active = this.#columnExists('generation_results', 'trashed_at') ? ' AND trashed_at IS NULL' : '';
        values.push(value);
        conditions.push(`${operator === 'ne' ? 'NOT ' : ''}EXISTS (SELECT 1 FROM generation_results WHERE asset_id = assets.id AND review_state = ?${active})`);
      } else if (field === 'tag' || field === 'albumName') {
        if (typeof value !== 'string' || !['eq', 'ne', 'contains', 'notContains', 'startsWith', 'endsWith', 'regex'].includes(operator)) throw new Error('SMART_COLLECTION_INVALID_VALUE');
        const table = field === 'tag' ? 'asset_tags JOIN tags ON tags.id = asset_tags.tag_id' : 'album_assets JOIN albums ON albums.id = album_assets.album_id';
        const assetColumn = field === 'tag' ? 'asset_tags.asset_id' : 'album_assets.asset_id';
        const nameColumn = field === 'tag' ? 'tags.name' : 'albums.name';
        const negative = operator === 'ne' || operator === 'notContains';
        const positiveOperator = operator === 'ne' ? 'eq' : operator === 'notContains' ? 'contains' : operator;
        if (operator === 'regex') validateSmartRegex(value);
        const pattern = positiveOperator === 'eq' || positiveOperator === 'regex' ? value : positiveOperator === 'startsWith' ? `${escapeLike(value)}%` : positiveOperator === 'endsWith' ? `%${escapeLike(value)}` : `%${escapeLike(value)}%`;
        values.push(pattern);
        conditions.push(`${negative ? 'NOT ' : ''}EXISTS (SELECT 1 FROM ${table} WHERE ${assetColumn} = assets.id AND ${positiveOperator === 'regex' ? `smart_regexp(?, ${nameColumn}) = 1` : `${nameColumn} ${positiveOperator === 'eq' ? 'COLLATE NOCASE = ?' : "LIKE ? ESCAPE '\\'"}`})`);
      } else if (field === 'folderName') {
        if (typeof value !== 'string' || !['eq', 'ne', 'contains', 'notContains', 'regex'].includes(operator)) throw new Error('SMART_COLLECTION_INVALID_VALUE');
        const regex = operator === 'regex' ? validateSmartRegex(value) : null;
        const folders = this.listFolders().filter((folder) => regex ? regex.test(folder.name) : operator === 'eq' || operator === 'ne' ? folder.name.toLocaleLowerCase() === value.toLocaleLowerCase() : folder.name.toLocaleLowerCase().includes(value.toLocaleLowerCase()));
        const ids = folders.map((folder) => folder.id);
        const clauses = ids.map((id) => {
          const directory = this.#resolveDirectory(id)!;
          if (!directory.relativePath) { values.push(directory.rootId); return 'folder_id = ?'; }
          const absolute = path.join(directory.rootPath, directory.relativePath);
          values.push(directory.rootId, `${escapeLike(absolute + path.sep)}%`);
          return "(folder_id = ? AND path LIKE ? ESCAPE '\\')";
        });
        conditions.push(`${operator === 'ne' || operator === 'notContains' ? 'NOT ' : ''}(${clauses.length ? clauses.join(' OR ') : '0'})`);
      }
    }
    return { sql: `(${scopeParts.length ? scopeParts.join(' OR ') : '0'}) AND (${conditions.length ? conditions.join(rule.match === 'all' ? ' AND ' : ' OR ') : '1'})`, values };
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

  deleteTag(rawTagId: string): void {
    const tagId = deleteCatalogTagInputSchema.parse(rawTagId);
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      const result = this.#database.prepare('DELETE FROM tags WHERE id = ?').run(tagId);
      if (result.changes !== 1) throw new Error('TAG_NOT_FOUND');
      this.#database.exec('COMMIT');
    } catch (error) {
      this.#database.exec('ROLLBACK');
      throw error;
    }
  }

  updateMetadata(rawInput: UpdateCatalogMetadataInput): CatalogAsset[] {
    const input = updateCatalogMetadataInputSchema.parse(rawInput);
    const previousFolderVersion = this.#folderCache ? this.#databaseVersion() : null;
    const uniqueIds = [...new Set(input.assetIds)];
    const assignments: string[] = [];
    const values: (number | string | null)[] = [];
    if (input.rating !== undefined) {
      assignments.push('rating = ?');
      values.push(input.rating);
    }
    if (input.labelColor !== undefined) {
      assignments.push('label_color = ?');
      values.push(input.labelColor);
    }
    if (input.favorite !== undefined) {
      assignments.push('favorite = ?');
      values.push(input.favorite ? 1 : 0);
    }
    if (input.flag !== undefined) {
      assignments.push('flag = ?');
      values.push(input.flag);
    }
    const placeholders = uniqueIds.map(() => '?').join(', ');
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      const result = this.#database.prepare(`
        UPDATE assets SET ${assignments.join(', ')} WHERE removed_at IS NULL AND id IN (${placeholders})
      `).run(...values, ...uniqueIds);
      if (result.changes !== uniqueIds.length) throw new Error('CATALOG_ASSET_SET_MISMATCH');
      this.#database.exec('COMMIT');
      if (previousFolderVersion && this.#folderCacheVersion === previousFolderVersion) this.#folderCacheVersion = this.#databaseVersion();
    } catch (error) {
      this.#database.exec('ROLLBACK');
      throw error;
    }
    const rows = this.#database.prepare(`
      SELECT id, folder_id, path, file_name, extension, size_bytes, modified_at, rating, label_color, flag, favorite, offline_at
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

  async importFolders(folderPaths: readonly string[], seenPaths?: Set<string>): Promise<number> {
    let importedCount = 0;

    for (const requestedPath of folderPaths) {
      const folderPath = await realpath(requestedPath);
      const folderStats = await stat(folderPath);
      if (!folderStats.isDirectory()) continue;

      const folderId = stableFolderId(folderPath);
      const now = Date.now();
      const countExisting = this.#database.prepare('SELECT 1 AS found FROM assets WHERE path = ? AND removed_at IS NULL LIMIT 1');
      this.#database
        .prepare(`
          INSERT INTO folders (id, path, name, imported_at)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(path) DO UPDATE SET name = excluded.name, removed_at = NULL
        `)
        .run(folderId, folderPath, path.basename(folderPath), now);

      const upsert = this.#database.prepare(`
        INSERT INTO assets (
          id, folder_id, path, file_name, extension, size_bytes, modified_at, imported_at, offline_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
        ON CONFLICT(path) DO UPDATE SET
          folder_id = excluded.folder_id,
          file_name = excluded.file_name,
          name_sort_key = CASE WHEN assets.file_name = excluded.file_name THEN assets.name_sort_key ELSE NULL END,
          extension = excluded.extension,
          content_hash = CASE
            WHEN assets.size_bytes = excluded.size_bytes AND assets.modified_at = excluded.modified_at THEN assets.content_hash
            ELSE NULL
          END,
          size_bytes = excluded.size_bytes,
          modified_at = excluded.modified_at,
          removed_at = NULL,
          trashed_at = NULL,
          offline_at = NULL
      `);
      const pendingPaths: string[] = [];
      const flush = async () => {
        if (pendingPaths.length === 0) return;
        const paths = pendingPaths.splice(0);
        const batch: Array<{ path: string; size: number; modifiedAt: number }> = [];
        for (let offset = 0; offset < paths.length; offset += IMPORT_STAT_CONCURRENCY) {
          const metadata = await Promise.all(paths.slice(offset, offset + IMPORT_STAT_CONCURRENCY).map(async (filePath) => {
            try {
              const fileStats = await stat(filePath);
              return fileStats.isFile() ? { path: filePath, size: fileStats.size, modifiedAt: Math.trunc(fileStats.mtimeMs) } : null;
            } catch (error) {
              if (seenPaths) throw error;
              // A disappeared or unreadable file must not abort a regular import.
              return null;
            }
          }));
          for (const item of metadata) if (item) batch.push(item);
        }
        if (batch.length === 0) return;
        let newlyImported = 0;
        this.#database.exec('BEGIN IMMEDIATE');
        try {
          for (const file of batch) {
            const existing = countExisting.get(file.path);
            upsert.run(
              randomUUID(),
              folderId,
              file.path,
              path.basename(file.path),
              path.extname(file.path).toLowerCase(),
              file.size,
              file.modifiedAt,
              now
            );
            if (!existing) newlyImported += 1;
          }
          this.#database.exec('COMMIT');
          importedCount += newlyImported;
          for (const file of batch) seenPaths?.add(file.path);
        } catch (error) {
          this.#database.exec('ROLLBACK');
          throw error;
        }
      };

      for await (const filePath of walkImages(folderPath, Boolean(seenPaths))) {
        pendingPaths.push(filePath);
        if (pendingPaths.length >= IMPORT_BATCH_SIZE) {
          await flush();
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
      }
      await flush();
    }

    return importedCount;
  }

  async indexPendingContentHashes(maxFiles = 1, maxBytes = 512 * 1024 * 1024): Promise<{ indexed: number; remaining: number }> {
    const safeFiles = Math.max(1, Math.min(Math.trunc(maxFiles), 32));
    const safeBytes = Math.max(1, Math.min(Math.trunc(maxBytes), 2 * 1024 * 1024 * 1024));
    const candidates = this.#database.prepare(`
      SELECT id, path, size_bytes, modified_at FROM assets
      WHERE removed_at IS NULL AND offline_at IS NULL AND content_hash IS NULL
      ORDER BY imported_at ASC, id ASC LIMIT ?
    `).all(safeFiles * 4) as Array<Pick<AssetRow, 'id' | 'path' | 'size_bytes' | 'modified_at'>>;
    let indexed = 0;
    let scheduledBytes = 0;
    for (const candidate of candidates) {
      if (indexed >= safeFiles || (indexed > 0 && scheduledBytes + candidate.size_bytes > safeBytes)) break;
      scheduledBytes += candidate.size_bytes;
      try {
        const hash = await hashFile(candidate.path);
        const after = await stat(candidate.path);
        if (after.size !== candidate.size_bytes || Math.trunc(after.mtimeMs) !== candidate.modified_at) continue;
        const result = this.#database.prepare(`
          UPDATE assets SET content_hash = ?
          WHERE id = ? AND path = ? AND size_bytes = ? AND modified_at = ?
            AND offline_at IS NULL AND removed_at IS NULL AND content_hash IS NULL
        `).run(hash, candidate.id, candidate.path, candidate.size_bytes, candidate.modified_at);
        if (result.changes === 1) indexed += 1;
      } catch {
        // External changes and transient read errors are retried by a later pass.
      }
    }
    const remaining = this.#database.prepare(`
      SELECT COUNT(*) AS value FROM assets
      WHERE removed_at IS NULL AND offline_at IS NULL AND content_hash IS NULL
    `).get() as { value: number };
    return { indexed, remaining: remaining.value };
  }

  async reconcileImportedFolders(): Promise<{ discovered: number; offline: number }> {
    const folders = this.#database.prepare('SELECT id, path FROM folders WHERE removed_at IS NULL').all() as { id: string; path: string }[];
    let discovered = 0;
    for (const folder of folders) {
      discovered += (await this.synchronizeFolder(folder.id)).discovered;
    }
    const row = this.#database.prepare('SELECT COUNT(*) AS value FROM assets WHERE offline_at IS NOT NULL AND removed_at IS NULL').get() as { value: number };
    return { discovered, offline: row.value };
  }

  async synchronizeImportedRoot(rootPath: string): Promise<{ discovered: number; offline: number }> {
    const canonicalPath = await realpath(rootPath).catch(() => rootPath);
    const root = this.#database.prepare('SELECT id FROM folders WHERE path = ? AND removed_at IS NULL').get(canonicalPath) as { id: string } | undefined;
    if (!root) return { discovered: 0, offline: 0 };
    return this.synchronizeFolder(root.id);
  }

  async synchronizeImportedFile(rootPath: string, relativePath: string): Promise<void> {
    const root = this.#database.prepare('SELECT id FROM folders WHERE path = ? AND removed_at IS NULL').get(rootPath) as { id: string } | undefined;
    if (!root) return;
    if (!relativePath || path.isAbsolute(relativePath) || relativePath.split(/[\\/]/u).some((part) => part === '..' || part === '.')) throw new Error('INVALID_WATCH_PATH');
    if (relativePath.split(/[\\/]/u).some((part) => part.startsWith('.') || IGNORED_DIRECTORIES.has(part))) return;
    const filePath = path.resolve(rootPath, relativePath);
    if (!filePath.startsWith(rootPath + path.sep) || !isSupportedBrowseMedia(filePath)) return;
    const metadata = await stat(filePath).catch(() => null);
    if (!metadata?.isFile()) {
      this.#database.prepare('UPDATE assets SET offline_at = ? WHERE folder_id = ? AND path = ? AND removed_at IS NULL AND offline_at IS NULL')
        .run(Date.now(), root.id, filePath);
      return;
    }
    const modifiedAt = Math.trunc(metadata.mtimeMs);
    this.#database.prepare(`
      INSERT INTO assets (id, folder_id, path, file_name, extension, size_bytes, modified_at, imported_at, offline_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
      ON CONFLICT(path) DO UPDATE SET
        folder_id = excluded.folder_id, file_name = excluded.file_name,
        name_sort_key = CASE WHEN assets.file_name = excluded.file_name THEN assets.name_sort_key ELSE NULL END,
        extension = excluded.extension,
        content_hash = CASE WHEN assets.size_bytes = excluded.size_bytes AND assets.modified_at = excluded.modified_at THEN assets.content_hash ELSE NULL END,
        size_bytes = excluded.size_bytes, modified_at = excluded.modified_at,
        removed_at = NULL, trashed_at = NULL, offline_at = NULL
    `).run(randomUUID(), root.id, filePath, path.basename(filePath), path.extname(filePath).toLowerCase(), metadata.size, modifiedAt, Date.now());
  }

  async synchronizeImportedDirectory(rootPath: string, relativeFilePath: string): Promise<boolean> {
    const root = this.#database.prepare('SELECT id FROM folders WHERE path = ? AND removed_at IS NULL').get(rootPath) as { id: string } | undefined;
    if (!root) return true;
    if (!relativeFilePath || path.isAbsolute(relativeFilePath) || relativeFilePath.includes('\0') || relativeFilePath.split(/[\\/]/u).some((part) => part === '..' || part === '.')) return false;
    const changedPath = path.resolve(rootPath, relativeFilePath);
    if (!changedPath.startsWith(rootPath + path.sep)) return false;
    const directory = path.dirname(changedPath);
    const changedMetadata = await stat(changedPath).catch(() => null);
    if (changedMetadata?.isDirectory()) return false;
    const directoryMetadata = await stat(directory).catch(() => null);
    if (!directoryMetadata?.isDirectory()) return false;
    const directoryRelative = path.relative(rootPath, directory);
    if (directoryRelative.split(path.sep).some((part) => part.startsWith('.') || IGNORED_DIRECTORIES.has(part))) return true;

    const prefix = directory + path.sep;
    const known = new Set<string>();
    const nestedPrefix = changedPath + path.sep;
    if (this.#database.prepare('SELECT 1 FROM created_directories WHERE root_id = ? AND (path = ? OR (path >= ? AND path < ?)) LIMIT 1')
      .get(root.id, changedPath, nestedPrefix, nestedPrefix + '\uffff')) return false;
    if (this.#database.prepare('SELECT 1 FROM assets WHERE folder_id = ? AND path >= ? AND path < ? AND removed_at IS NULL LIMIT 1')
      .get(root.id, nestedPrefix, nestedPrefix + '\uffff')) return false;
    for (const row of this.#database.prepare(`
      SELECT path FROM assets WHERE folder_id = ? AND path >= ? AND path < ? AND removed_at IS NULL
    `).iterate(root.id, prefix, prefix + '\uffff') as Iterable<{ path: string }>) {
      if (path.dirname(row.path) === directory) known.add(row.path);
    }

    let handle;
    try { handle = await opendir(directory); } catch { return false; }
    const found = new Set<string>();
    for await (const entry of handle) {
      if (entry.name.startsWith('.') || IGNORED_DIRECTORIES.has(entry.name)) continue;
      if (entry.isDirectory() && path.join(directory, entry.name) === changedPath) return false;
      if (entry.isFile() && isSupportedBrowseMedia(entry.name)) found.add(entry.name);
    }
    for (const name of found) await this.synchronizeImportedFile(rootPath, path.relative(rootPath, path.join(directory, name)));
    const markOffline = this.#database.prepare('UPDATE assets SET offline_at = ? WHERE folder_id = ? AND path = ? AND removed_at IS NULL AND offline_at IS NULL');
    for (const file of known) if (!found.has(path.basename(file))) markOffline.run(Date.now(), root.id, file);
    return true;
  }

  resolveFolderPath(folderId: string): string | null {
    const directory = this.#resolveDirectory(folderId);
    return directory ? path.join(directory.rootPath, directory.relativePath) : null;
  }

  async synchronizeFolder(folderId: string): Promise<{ discovered: number; offline: number }> {
    const directory = this.#resolveDirectory(folderId);
    if (!directory) throw new Error('CATALOG_FOLDER_NOT_FOUND');
    const scanStartedAt = Date.now();
    let discovered = 0;
    const seenPaths = new Set<string>();
    try {
      discovered = await this.importFolders([directory.rootPath], seenPaths);
      this.#markMissingRootAssetsOffline(directory.rootId, seenPaths);
    } catch {
      // A missing root is offline. A partially scanned root keeps its last
      // known state, since it is unsafe to infer which files disappeared.
      if (!await stat(directory.rootPath).then((item) => item.isDirectory()).catch(() => false)) {
        await this.#markRootOffline(directory.rootId);
      }
    }
    if (discovered > 0) discovered -= await this.#reconcileExternalFolderRenames(directory.rootId, directory.rootPath, scanStartedAt);
    const row = this.#database.prepare(`
      SELECT COUNT(*) AS value FROM assets
      WHERE folder_id = ? AND offline_at IS NOT NULL AND removed_at IS NULL
    `).get(directory.rootId) as { value: number };
    return { discovered, offline: row.value };
  }

  takeExternalRelocations(): RelinkCatalogFolderOperationResult['relocations'] {
    return this.#externalRelocations.splice(0);
  }

  async #reconcileExternalFolderRenames(rootId: string, rootPath: string, scanStartedAt: number): Promise<number> {
    const oldAssets = this.#database.prepare(`
      SELECT id, path, file_name, size_bytes, modified_at, content_hash FROM assets
      WHERE folder_id = ? AND removed_at IS NULL AND offline_at IS NOT NULL
    `).all(rootId) as RelinkAsset[];
    const newAssets = this.#database.prepare(`
      SELECT id, path, file_name, size_bytes, modified_at, content_hash, rating, favorite, label_color, flag
      FROM assets WHERE folder_id = ? AND removed_at IS NULL AND offline_at IS NULL AND imported_at >= ?
    `).all(rootId, scanStartedAt) as Array<RelinkAsset & { rating: number; favorite: number; label_color: string | null; flag: string }>;
    if (!oldAssets.length || !newAssets.length) return 0;
    const key = (asset: RelinkAsset) => `${normalizeRelativePath(asset.file_name)}:${relinkMetadataKey(asset)}`;
    const uniqueOld = groupUnique(oldAssets, key);
    const uniqueNew = groupUnique(newAssets, key);
    const sourceExists = new Map<string, boolean>();
    const relocations: RelinkCatalogFolderOperationResult['relocations'] = [];
    const duplicates: string[] = [];
    const scopeCandidates = new Map<string, string | null>();
    for (const [fingerprint, oldAsset] of uniqueOld) {
      const newAsset = uniqueNew.get(fingerprint);
      if (!oldAsset || !newAsset || oldAsset.path === newAsset.path) continue;
      const oldDirectory = path.dirname(oldAsset.path);
      const nextDirectory = path.dirname(newAsset.path);
      if (oldDirectory === nextDirectory) continue;
      let exists = sourceExists.get(oldDirectory);
      if (exists === undefined) {
        exists = await stat(oldDirectory).then(() => true).catch(() => false);
        sourceExists.set(oldDirectory, exists);
      }
      if (exists || newAsset.rating || newAsset.favorite || newAsset.label_color || newAsset.flag !== 'unflagged') continue;
      if (oldAsset.content_hash && oldAsset.content_hash !== await hashFile(newAsset.path).catch(() => null)) continue;
      const linked = ['asset_tags', 'album_assets', 'analysis_revisions', 'generation_results', 'generation_write_intents', 'tasks', 'file_operation_items'].some((table) =>
        this.#tableExists(table) && Boolean(this.#database.prepare(`SELECT 1 FROM ${table} WHERE asset_id = ? LIMIT 1`).get(newAsset.id))
      ) || (this.#tableExists('file_operation_items') && Boolean(this.#database.prepare('SELECT 1 FROM file_operation_items WHERE result_asset_id = ? LIMIT 1').get(newAsset.id)));
      if (linked) continue;
      relocations.push({ assetId: oldAsset.id, previousPath: oldAsset.path, nextPath: newAsset.path,
        previousFileName: oldAsset.file_name, nextFileName: newAsset.file_name });
      duplicates.push(newAsset.id);
      let oldAncestor = oldDirectory;
      let nextAncestor = nextDirectory;
      while (oldAncestor !== rootPath && nextAncestor !== rootPath
        && oldAncestor.startsWith(`${rootPath}${path.sep}`) && nextAncestor.startsWith(`${rootPath}${path.sep}`)) {
        const oldId = stableDirectoryId(rootId, path.relative(rootPath, oldAncestor));
        const nextId = stableDirectoryId(rootId, path.relative(rootPath, nextAncestor));
        const prior = scopeCandidates.get(oldId);
        scopeCandidates.set(oldId, prior === undefined ? nextId : prior === nextId ? nextId : null);
        oldAncestor = path.dirname(oldAncestor);
        nextAncestor = path.dirname(nextAncestor);
      }
    }
    if (!relocations.length) return 0;
    const scopeChanges = new Map<string, string>();
    for (const [oldId, nextId] of scopeCandidates) {
      if (!nextId) continue;
      const oldDirectory = this.#resolveDirectory(oldId);
      if (!oldDirectory) continue;
      const oldPath = path.join(oldDirectory.rootPath, oldDirectory.relativePath);
      if (!await stat(oldPath).then(() => true).catch(() => false)) scopeChanges.set(oldId, nextId);
    }
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      const deleteAsset = this.#database.prepare('DELETE FROM assets WHERE id = ?');
      const updateAsset = this.#database.prepare('UPDATE assets SET path = ?, file_name = ?, name_sort_key = NULL, extension = ?, offline_at = NULL WHERE id = ?');
      for (let index = 0; index < relocations.length; index += 1) {
        const duplicateId = duplicates[index]!;
        this.#database.prepare('DELETE FROM asset_search WHERE asset_id = ?').run(duplicateId);
        this.#database.prepare('DELETE FROM asset_search_tokens WHERE asset_id = ?').run(duplicateId);
        deleteAsset.run(duplicateId);
        const item = relocations[index]!;
        updateAsset.run(item.nextPath, item.nextFileName, path.extname(item.nextPath).toLowerCase(), item.assetId);
      }
      this.#applyScopeRelocations(scopeChanges);
      this.#database.exec('COMMIT');
    } catch (error) {
      this.#database.exec('ROLLBACK');
      throw error;
    }
    this.#externalRelocations.push(...relocations);
    return relocations.length;
  }

  async #markRootOffline(rootId: string): Promise<void> {
    // The primary-key index keeps cursor progress monotonic and avoids a
    // repeated temp sort of the entire root for every small batch.
    const select = this.#database.prepare(`
      SELECT id FROM assets INDEXED BY sqlite_autoindex_assets_1 WHERE folder_id = ? AND removed_at IS NULL AND id > ?
      ORDER BY id ASC LIMIT ?
    `);
    const update = this.#database.prepare(`
      UPDATE assets INDEXED BY sqlite_autoindex_assets_1 SET offline_at = ? WHERE folder_id = ? AND removed_at IS NULL
        AND id > ? AND id <= ?
    `);
    let cursor = '';
    while (true) {
      const rows = select.all(rootId, cursor, RECONCILE_BATCH_SIZE) as { id: string }[];
      if (rows.length === 0) break;
      const lastId = rows[rows.length - 1]!.id;
      update.run(Date.now(), rootId, cursor, lastId);
      cursor = lastId;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }

  #markMissingRootAssetsOffline(rootId: string, seenPaths: ReadonlySet<string>): void {
    const rows = this.#database.prepare('SELECT id, path FROM assets WHERE folder_id = ? AND removed_at IS NULL').iterate(rootId) as Iterable<{ id: string; path: string }>;
    const mark = this.#database.prepare('UPDATE assets SET offline_at = ? WHERE id = ? AND offline_at IS NULL');
    const now = Date.now();
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      for (const row of rows) if (!seenPaths.has(row.path)) mark.run(now, row.id);
      this.#database.exec('COMMIT');
    } catch (error) {
      this.#database.exec('ROLLBACK');
      throw error;
    }
  }

  resolveAssetFile(assetId: string): { path: string; fileName: string; modifiedAt: number; sizeBytes: number } | null {
    const row = this.#database
      .prepare('SELECT path, file_name, modified_at, size_bytes FROM assets WHERE id = ? AND removed_at IS NULL')
      .get(assetId) as Pick<AssetRow, 'path' | 'file_name' | 'modified_at' | 'size_bytes'> | undefined;
    if (!row) return null;
    return { path: row.path, fileName: row.file_name, modifiedAt: row.modified_at, sizeBytes: row.size_bytes };
  }

  #tableExists(tableName: string): boolean {
    return Boolean(this.#database.prepare(`
      SELECT 1 AS value FROM sqlite_master WHERE type = 'table' AND name = ?
    `).get(tableName));
  }

  #columnExists(tableName: string, columnName: string): boolean {
    return (this.#database.prepare(`PRAGMA table_info(${tableName})`).all() as { name: string }[])
      .some((column) => column.name === columnName);
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
    const roots = this.#database.prepare('SELECT id, path FROM folders').all() as { id: string; path: string }[];
    const rootPaths = new Map(roots.map((root) => [root.id, root.path]));
    return rows.map((row) => {
      const rootPath = rootPaths.get(row.folder_id);
      const relative = rootPath ? path.relative(rootPath, path.dirname(row.path)) : '';
      return this.#toAsset(row, tagsByAsset.get(row.id) ?? [], relative && relative !== '.' ? stableDirectoryId(row.folder_id, relative) : row.folder_id, rootPath);
    });
  }

  #toAsset(row: AssetRow, tags: { id: string; name: string }[], directoryId: string, rootPath?: string): CatalogAsset {
    return catalogAssetSchema.parse({
      id: row.id,
      folderId: row.folder_id,
      directoryId,
      ...(rootPath ? { relativePath: path.relative(rootPath, row.path).split(path.sep).join('/') } : {}),
      fileName: row.file_name,
      format: row.extension.slice(1).toUpperCase(),
      sizeBytes: row.size_bytes,
      modifiedAt: row.modified_at,
      ...(row.width && row.height ? { width: row.width, height: row.height } : {}),
      rating: row.rating,
      labelColor: row.label_color,
      flag: row.flag,
      favorite: row.favorite === 1,
      offline: row.offline_at !== null,
      tags,
      thumbnailUrl: `photoasset://thumbnail/${row.id}`,
      previewUrl: `photoasset://preview/${row.id}`
    });
  }
}

function normalizeRelativePath(value: string): string {
  return value.split(path.sep).map((part) => part.normalize('NFC').toLocaleLowerCase('en-US')).join('/');
}

type RelinkAsset = {
  id: string;
  path: string;
  file_name: string;
  size_bytes: number;
  modified_at: number;
  content_hash: string | null;
};

type RelinkFile = { path: string; relative: string; size: number; modifiedAt: number; contentHash?: string };

function relinkMetadataKey(value: RelinkAsset | { size: number; modifiedAt: number }): string {
  return 'size' in value ? `${value.size}:${value.modifiedAt}` : `${value.size_bytes}:${value.modified_at}`;
}

function groupUnique<Value>(values: readonly Value[], keyOf: (value: Value) => string): Map<string, Value | null> {
  const result = new Map<string, Value | null>();
  for (const value of values) {
    const key = keyOf(value);
    result.set(key, result.has(key) ? null : value);
  }
  return result;
}

function escapeLike(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');
}

function validateSmartRegex(value: string): RegExp {
  if (value.length > 200) throw new Error('SMART_COLLECTION_INVALID_REGEX');
  if (/\((?:[^()]|\([^()]*\))*[+*{][^()]*\)[+*{]/u.test(value) || /\([^)]*\|[^)]*\)[+*{]/u.test(value))
    throw new Error('SMART_COLLECTION_INVALID_REGEX');
  try { return new RegExp(value, 'iu'); }
  catch { throw new Error('SMART_COLLECTION_INVALID_REGEX'); }
}

async function hashFile(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}
