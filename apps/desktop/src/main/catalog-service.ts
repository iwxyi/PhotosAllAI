import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { opendir, realpath, rename, stat } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  catalogAlbumSchema,
  catalogAssetSchema,
  catalogAssetPageSchema,
  catalogFolderSchema,
  relinkCatalogFolderResultSchema,
  catalogSmartCollectionSchema,
  catalogTagSchema,
  deleteCatalogTagInputSchema,
  listCatalogAssetsInputSchema,
  saveCatalogAlbumInputSchema,
  updateCatalogAlbumAssetsInputSchema,
  type CatalogAlbum,
  type CatalogAsset,
  type CatalogAssetPage,
  type CatalogFolder,
  type RelinkCatalogFolderResult,
  type RenameCatalogFolderInput,
  type RenameCatalogFolderResult,
  type UnregisterCatalogFolderReport,
  unregisterCatalogFolderReportSchema,
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
const RECENT_IMPORT_WINDOW_MS = 30 * 24 * 60 * 60 * 1_000;
const IMPORT_BATCH_SIZE = 256;

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
  content_hash: string | null;
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

export function isSupportedImage(filePath: string): boolean {
  return SUPPORTED_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function stableFolderId(folderPath: string): string {
  return createHash('sha256').update(folderPath).digest('hex').slice(0, 32);
}

function stableDirectoryId(rootId: string, relativePath: string): string {
  return createHash('sha256').update(`${rootId}\0${normalizeRelativePath(relativePath)}`).digest('hex').slice(0, 32);
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
    const activeGenerationPredicate = this.#tableExists('generation_results') && this.#columnExists('generation_results', 'trashed_at')
      ? 'trashed_at IS NULL'
      : '1';
    const baseConditions: string[] = ['removed_at IS NULL'];
    const baseValues: (string | number)[] = [];
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
    if (input.smartCollection === 'recent') {
      baseConditions.push('imported_at >= ?');
      baseValues.push(Date.now() - RECENT_IMPORT_WINDOW_MS);
    }
    if (input.smartCollection === 'favorites') baseConditions.push('favorite = 1');
    if (input.smartCollection === 'unrated') baseConditions.push('rating = 0');
    if (input.smartCollection === 'unanalyzed' && this.#tableExists('analysis_revisions')) {
      baseConditions.push('id NOT IN (SELECT asset_id FROM analysis_revisions)');
    }
    if (input.smartCollection === 'generated') {
      baseConditions.push(this.#tableExists('generation_results')
        ? `id IN (SELECT asset_id FROM generation_results WHERE ${activeGenerationPredicate})`
        : '0');
    }
    if (input.smartCollection === 'to-review') {
      baseConditions.push(this.#tableExists('generation_results')
        ? `id IN (SELECT asset_id FROM generation_results WHERE review_state = 'undecided' AND ${activeGenerationPredicate})`
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
      if (input.sortBy === 'fileName') {
        conditions.push('(file_name COLLATE NOCASE > ? OR (file_name COLLATE NOCASE = ? AND id > ?))');
        values.push(typeof input.cursor.sortValue === 'string' ? input.cursor.sortValue : '', typeof input.cursor.sortValue === 'string' ? input.cursor.sortValue : '', input.cursor.id);
      } else if (input.sortBy === 'rating') {
        conditions.push('(rating < ? OR (rating = ? AND id > ?))');
        const rating = typeof input.cursor.sortValue === 'number' ? input.cursor.sortValue : 0;
        values.push(rating, rating, input.cursor.id);
      } else {
        conditions.push('(modified_at < ? OR (modified_at = ? AND id > ?))');
        values.push(input.cursor.modifiedAt, input.cursor.modifiedAt, input.cursor.id);
      }
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const orderBy = input.sortBy === 'fileName'
      ? 'file_name COLLATE NOCASE ASC, id ASC'
      : input.sortBy === 'rating'
        ? 'rating DESC, id ASC'
        : 'modified_at DESC, id ASC';
    const rows = this.#database.prepare(`
      SELECT id, folder_id, path, file_name, extension, size_bytes, modified_at, rating, favorite, offline_at
      FROM assets ${where}
      ORDER BY ${orderBy}
      LIMIT ?
    `).all(...values, input.limit + 1) as AssetRow[];
    const hasMore = rows.length > input.limit;
    const pageRows = hasMore ? rows.slice(0, input.limit) : rows;
    const countWhere = baseConditions.length > 0 ? `WHERE ${baseConditions.join(' AND ')}` : '';
    const count = this.#database.prepare(`
      SELECT COUNT(*) AS value FROM assets ${countWhere}
    `).get(...baseValues) as { value: number };
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
      totalCount: count.value,
      nextCursor: hasMore && last ? { modifiedAt: last.modified_at, id: last.id, ...(sortValue === undefined ? {} : { sortValue }) } : null
    });
  }

  listFolders(): CatalogFolder[] {
    const roots = this.#database.prepare(`
      SELECT id, path, name FROM folders WHERE removed_at IS NULL
      ORDER BY name COLLATE NOCASE ASC, id ASC
    `).all() as { id: string; path: string; name: string }[];
    const assets = this.#database.prepare(`
      SELECT folder_id, path, offline_at FROM assets WHERE removed_at IS NULL
    `).all() as { folder_id: string; path: string; offline_at: number | null }[];
    const assetsByRoot = new Map<string, typeof assets>();
    for (const asset of assets) {
      const items = assetsByRoot.get(asset.folder_id) ?? [];
      items.push(asset);
      assetsByRoot.set(asset.folder_id, items);
    }
    const result: CatalogFolder[] = [];
    for (const root of roots) {
      const rootAssets = assetsByRoot.get(root.id) ?? [];
      result.push(catalogFolderSchema.parse({ id: root.id, name: root.name, assetCount: rootAssets.length, offlineCount: rootAssets.filter((asset) => asset.offline_at !== null).length, parentId: null, rootId: root.id, depth: 0, isRoot: true }));
      const directories = new Map<string, { assetCount: number; offlineCount: number }>();
      for (const asset of rootAssets) {
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
        result.push(catalogFolderSchema.parse({
          id: stableDirectoryId(root.id, relativePath),
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
    return result;
  }

  #resolveDirectory(directoryId: string): { rootId: string; rootPath: string; relativePath: string } | null {
    const roots = this.#database.prepare('SELECT id, path FROM folders WHERE removed_at IS NULL').all() as { id: string; path: string }[];
    for (const root of roots) {
      if (root.id === directoryId) return { rootId: root.id, rootPath: root.path, relativePath: '' };
      const paths = this.#database.prepare('SELECT path FROM assets WHERE folder_id = ? AND removed_at IS NULL').all(root.id) as { path: string }[];
      const checked = new Set<string>();
      for (const item of paths) {
        let relativePath = path.relative(root.path, path.dirname(item.path));
        while (relativePath && relativePath !== '.' && !relativePath.startsWith(`..${path.sep}`) && !path.isAbsolute(relativePath)) {
          if (!checked.has(relativePath)) {
            if (stableDirectoryId(root.id, relativePath) === directoryId) return { rootId: root.id, rootPath: root.path, relativePath };
            checked.add(relativePath);
          }
          const parent = path.dirname(relativePath);
          if (parent === relativePath || parent === '.') break;
          relativePath = parent;
        }
      }
    }
    return null;
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

  async relinkFolder(folderId: string, requestedPath: string): Promise<RelinkCatalogFolderOperationResult> {
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
      this.#database.prepare('UPDATE assets SET offline_at = ? WHERE folder_id = ? AND removed_at IS NULL')
        .run(Date.now(), folderId);
      const update = this.#database.prepare(`
        UPDATE assets SET path = ?, file_name = ?, extension = ?,
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

  async renameFolder(input: RenameCatalogFolderInput): Promise<RenameCatalogFolderResult> {
    const directory = this.#resolveDirectory(input.folderId);
    if (!directory) throw new Error('CATALOG_FOLDER_NOT_FOUND');
    const oldPath = path.join(directory.rootPath, directory.relativePath);
    const nextPath = path.join(path.dirname(oldPath), input.name);
    if (oldPath === nextPath) {
      const folder = this.listFolders().find((item) => item.id === input.folderId);
      if (!folder) throw new Error('CATALOG_FOLDER_NOT_FOUND');
      return { folder };
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
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      const assets = this.#database.prepare('SELECT id, path FROM assets WHERE folder_id = ? AND removed_at IS NULL').all(directory.rootId) as Array<{ id: string; path: string }>;
      const updateAsset = this.#database.prepare('UPDATE assets SET path = ?, offline_at = NULL WHERE id = ?');
      for (const asset of assets) {
        if (asset.path === oldPath) updateAsset.run(nextPath, asset.id);
        else if (asset.path.startsWith(prefix)) updateAsset.run(`${nextPrefix}${asset.path.slice(prefix.length)}`, asset.id);
      }
      if (directory.relativePath === '') this.#database.prepare('UPDATE folders SET path = ?, name = ? WHERE id = ?').run(nextPath, input.name, directory.rootId);
      this.#database.exec('COMMIT');
    } catch (error) {
      this.#database.exec('ROLLBACK');
      try { await rename(nextPath, oldPath); } catch { /* preserve the database error */ }
      throw error;
    }
    const folder = this.listFolders().find((item) => item.id === input.folderId);
    if (!folder) throw new Error('CATALOG_FOLDER_NOT_FOUND');
    return { folder };
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
    const count = (condition: string, ...values: Array<string | number>): number => {
      const row = this.#database.prepare(`
        SELECT COUNT(*) AS value FROM assets WHERE removed_at IS NULL AND (${condition})
      `).get(...values) as { value: number };
      return row.value;
    };
    const hasAnalysis = this.#tableExists('analysis_revisions');
    const hasGeneration = this.#tableExists('generation_results');
    const activeGenerationPredicate = hasGeneration && this.#columnExists('generation_results', 'trashed_at')
      ? 'trashed_at IS NULL'
      : '1';
    return [
      catalogSmartCollectionSchema.parse({ id: 'recent', assetCount: count('imported_at >= ?', Date.now() - RECENT_IMPORT_WINDOW_MS) }),
      catalogSmartCollectionSchema.parse({ id: 'favorites', assetCount: count('favorite = 1') }),
      catalogSmartCollectionSchema.parse({ id: 'unrated', assetCount: count('rating = 0') }),
      catalogSmartCollectionSchema.parse({
        id: 'unanalyzed',
        assetCount: hasAnalysis ? count('id NOT IN (SELECT asset_id FROM analysis_revisions)') : count('1')
      }),
      catalogSmartCollectionSchema.parse({
        id: 'generated',
        assetCount: hasGeneration ? count(`id IN (SELECT asset_id FROM generation_results WHERE ${activeGenerationPredicate})`) : 0
      }),
      catalogSmartCollectionSchema.parse({
        id: 'to-review',
        assetCount: hasGeneration ? count(`id IN (SELECT asset_id FROM generation_results WHERE review_state = 'undecided' AND ${activeGenerationPredicate})`) : 0
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
      const knownPaths = new Set((this.#database.prepare(`
        SELECT path FROM assets WHERE folder_id = ? AND removed_at IS NULL
      `).all(folderId) as { path: string }[]).map((row) => row.path));
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
      const batch: Array<{ path: string; size: number; modifiedAt: number }> = [];
      const flush = () => {
        if (batch.length === 0) return;
        let newlyImported = 0;
        this.#database.exec('BEGIN IMMEDIATE');
        try {
          for (const file of batch) {
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
            if (!knownPaths.has(file.path)) {
              knownPaths.add(file.path);
              newlyImported += 1;
            }
          }
          this.#database.exec('COMMIT');
          importedCount += newlyImported;
        } catch (error) {
          this.#database.exec('ROLLBACK');
          throw error;
        } finally {
          batch.length = 0;
        }
      };

      for await (const filePath of walkImages(folderPath)) {
        let fileStats;
        try {
          fileStats = await stat(filePath);
        } catch {
          // A single unreadable file must not abort the rest of the import.
          continue;
        }
        batch.push({ path: filePath, size: fileStats.size, modifiedAt: Math.trunc(fileStats.mtimeMs) });
        if (batch.length >= IMPORT_BATCH_SIZE) flush();
      }
      flush();
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
    for (const folder of folders) {
      this.#database.prepare('UPDATE assets SET offline_at = ? WHERE folder_id = ? AND removed_at IS NULL').run(Date.now(), folder.id);
    }
    let discovered = 0;
    for (const folder of folders) {
      try {
        discovered += await this.importFolders([folder.path]);
      } catch {
        // Missing or inaccessible roots remain offline; other roots still reconcile.
      }
    }
    const row = this.#database.prepare('SELECT COUNT(*) AS value FROM assets WHERE offline_at IS NOT NULL AND removed_at IS NULL').get() as { value: number };
    return { discovered, offline: row.value };
  }

  resolveFolderPath(folderId: string): string | null {
    const directory = this.#resolveDirectory(folderId);
    return directory ? path.join(directory.rootPath, directory.relativePath) : null;
  }

  async synchronizeFolder(folderId: string): Promise<{ discovered: number; offline: number }> {
    const directory = this.#resolveDirectory(folderId);
    if (!directory) throw new Error('CATALOG_FOLDER_NOT_FOUND');
    this.#database.prepare('UPDATE assets SET offline_at = ? WHERE folder_id = ? AND removed_at IS NULL')
      .run(Date.now(), directory.rootId);
    let discovered = 0;
    try {
      discovered = await this.importFolders([directory.rootPath]);
    } catch {
      // An inaccessible root remains offline and is reported to the caller.
    }
    const row = this.#database.prepare(`
      SELECT COUNT(*) AS value FROM assets
      WHERE folder_id = ? AND offline_at IS NOT NULL AND removed_at IS NULL
    `).get(directory.rootId) as { value: number };
    return { discovered, offline: row.value };
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

async function hashFile(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}
