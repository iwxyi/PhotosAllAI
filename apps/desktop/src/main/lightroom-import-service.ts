import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { LightroomImportOptions, LightroomImportPreview } from '@photoallisai/contracts';
import type { CatalogService } from './catalog-service';

type Color = 'red' | 'yellow' | 'green' | 'blue' | 'purple' | null;
type SourceRow = { sourcePath: string; fileName: string; rating: number | null; colorLabels: string };
type SourceRoot = { absolutePath: string };
type Change = { id: string; previousRating: number; previousColor: Color; rating: number; labelColor: Color };

const COLOR_NAMES: Record<string, Exclude<Color, null>> = {
  red: 'red', yellow: 'yellow', green: 'green', blue: 'blue', purple: 'purple',
  '红色': 'red', '黄色': 'yellow', '绿色': 'green', '蓝色': 'blue', '紫色': 'purple'
};

function normalized(filePath: string): string {
  const windowsPath = /^[a-z]:[\\/]/iu.test(filePath) || filePath.startsWith('\\\\');
  return (windowsPath ? path.win32.normalize(filePath) : path.normalize(filePath)).normalize('NFC').toLocaleLowerCase();
}

function sourcePathFor(sourceRoot: string, relativePath: string): string {
  const windowsPath = /^[a-z]:[\\/]/iu.test(sourceRoot) || sourceRoot.startsWith('\\\\');
  return windowsPath
    ? path.win32.join(sourceRoot, relativePath.split(path.sep).join('\\'))
    : path.join(sourceRoot, relativePath);
}

function within(root: string, filePath: string): boolean {
  const relative = path.relative(root, filePath);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function sourceRows(database: DatabaseSync): SourceRow[] {
  try {
    return database.prepare(`
      SELECT r.absolutePath || d.pathFromRoot || f.baseName || '.' || f.extension AS sourcePath,
             f.baseName || '.' || f.extension AS fileName,
             i.rating AS rating, i.colorLabels AS colorLabels
      FROM Adobe_images i
      JOIN AgLibraryFile f ON f.id_local = i.rootFile
      JOIN AgLibraryFolder d ON d.id_local = f.folder
      JOIN AgLibraryRootFolder r ON r.id_local = d.rootFolder
      WHERE i.masterImage IS NULL
    `).all() as SourceRow[];
  } catch {
    throw new Error('不支持此 Lightroom 目录版本或目录已损坏');
  }
}

export class LightroomImportService {
  readonly #catalog: CatalogService;
  #sourcePath: string | null = null;
  #changes: Change[] | null = null;
  #previewToken: string | null = null;

  constructor(catalog: CatalogService) { this.#catalog = catalog; }

  select(sourcePath: string): string[] {
    const database = new DatabaseSync(sourcePath, { readOnly: true });
    try {
      const roots = database.prepare('SELECT absolutePath FROM AgLibraryRootFolder ORDER BY absolutePath').all() as SourceRoot[];
      database.prepare('SELECT i.rating FROM Adobe_images i JOIN AgLibraryFile f ON f.id_local = i.rootFile LIMIT 1').get();
      this.#sourcePath = sourcePath;
      this.#changes = null;
      this.#previewToken = null;
      return roots.map((item) => item.absolutePath);
    } catch {
      throw new Error('无法读取此 Lightroom Classic 目录');
    } finally { database.close(); }
  }

  preview(options: LightroomImportOptions & { catalogName: string }): LightroomImportPreview {
    if (!this.#sourcePath) throw new Error('请先选择 Lightroom 目录');
    const database = new DatabaseSync(this.#sourcePath, { readOnly: true });
    try {
      const rows = sourceRows(database);
      const linked = this.#catalog.listLightroomImportAssets();
      const exact = new Map<string, SourceRow[]>();
      const suffix = new Map<string, SourceRow[]>();
      for (const row of rows) {
        const key = normalized(row.sourcePath);
        const existing = exact.get(key) ?? [];
        existing.push(row);
        exact.set(key, existing);
        const parts = key.replaceAll('\\', '/').split('/').filter(Boolean);
        if (parts.length > 1) {
          const suffixKey = parts.slice(-2).join('/').toLocaleLowerCase();
          const matches = suffix.get(suffixKey) ?? [];
          matches.push(row);
          suffix.set(suffixKey, matches);
        }
      }
      const mappings = options.mappings.map((item) => ({
        source: normalized(item.sourceRoot),
        target: normalized(item.targetRoot)
      })).sort((a, b) => b.target.length - a.target.length);
      const changes: Change[] = [];
      const examples: LightroomImportPreview['examples'] = [];
      const unknown = new Map<string, number>();
      let matchedCount = 0;
      let ambiguousCount = 0;
      const linkedSuffixCounts = new Map<string, number>();
      for (const asset of linked) {
        const parts = normalized(asset.path).replaceAll('\\', '/').split('/').filter(Boolean);
        const key = parts.slice(-2).join('/').toLocaleLowerCase();
        linkedSuffixCounts.set(key, (linkedSuffixCounts.get(key) ?? 0) + 1);
      }
      for (const asset of linked) {
        const assetPath = normalized(asset.path);
        const candidates = new Set<SourceRow>();
        for (const row of exact.get(assetPath) ?? []) candidates.add(row);
        for (const mapping of mappings) {
          if (!within(mapping.target, assetPath)) continue;
          const source = normalized(sourcePathFor(mapping.source, path.relative(mapping.target, asset.path)));
          for (const row of exact.get(source) ?? []) candidates.add(row);
        }
        if (candidates.size === 0) {
          const parts = assetPath.replaceAll('\\', '/').split('/').filter(Boolean);
          const key = parts.slice(-2).join('/').toLocaleLowerCase();
          if (linkedSuffixCounts.get(key) === 1) for (const row of suffix.get(key) ?? []) candidates.add(row);
        }
        if (candidates.size > 1) { ambiguousCount++; continue; }
        const row = candidates.values().next().value;
        if (!row) continue;
        matchedCount++;
        const rawLabel = row.colorLabels?.trim() ?? '';
        const color = rawLabel ? COLOR_NAMES[rawLabel.toLocaleLowerCase()] : null;
        if (rawLabel && !color) unknown.set(rawLabel, (unknown.get(rawLabel) ?? 0) + 1);
        const sourceRating = row.rating === null ? NaN : Number(row.rating);
        const rating = Number.isInteger(sourceRating) && sourceRating >= 0 && sourceRating <= 5
          && (options.policy === 'overwrite' || asset.rating === 0) ? sourceRating : asset.rating;
        const labelColor = !rawLabel && options.policy === 'overwrite' ? null
          : color && (options.policy === 'overwrite' || !asset.labelColor) ? color : asset.labelColor;
        if (rating === asset.rating && labelColor === asset.labelColor) continue;
        changes.push({ id: asset.id, previousRating: asset.rating, previousColor: asset.labelColor, rating, labelColor });
        if (examples.length < 20) examples.push({ fileName: asset.fileName, ratingBefore: asset.rating, ratingAfter: rating, colorBefore: asset.labelColor, colorAfter: labelColor });
      }
      const token = randomUUID();
      this.#previewToken = token;
      this.#changes = changes;
      return {
        token, catalogName: options.catalogName, sourceRoots: mappings.map((item) => item.source),
        sourceCount: rows.length, linkedCount: linked.length, matchedCount, changedCount: changes.length,
        unmatchedCount: linked.length - matchedCount - ambiguousCount, ambiguousCount,
        unknownLabels: [...unknown].map(([label, count]) => ({ label, count })), examples
      };
    } finally { database.close(); }
  }

  apply(token: string): { updated: number; skipped: number } {
    if (!this.#changes || token !== this.#previewToken) throw new Error('导入预览已失效，请重新预览');
    const result = this.#catalog.applyLightroomMetadata(this.#changes);
    this.#changes = null;
    this.#previewToken = null;
    return result;
  }
}
