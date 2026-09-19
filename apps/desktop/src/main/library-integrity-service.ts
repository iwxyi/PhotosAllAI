import { lstat, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { libraryIntegrityReportSchema, type LibraryIntegrityReport } from '@photoallisai/contracts';

type GenerationRow = {
  id: string;
  file_name: string;
  file_path: string;
  storage_mode: 'managed' | 'portable';
  trashed_at: number | null;
  trash_path: string | null;
};

type WriteIntentRow = {
  asset_id: string;
  batch_id: string;
  file_name: string;
  file_path: string;
  temporary_path: string;
  storage_mode: 'managed' | 'portable';
  created_at: number;
  source_path: string | null;
  source_file_name: string | null;
};

const STALE_WRITE_INTENT_MS = 5 * 60_000;

export class LibraryIntegrityService {
  readonly #databasePath: string;
  readonly #generatedDirectory: string;
  readonly #trashDirectory: string;

  constructor(databasePath: string, generatedDirectory: string) {
    this.#databasePath = path.resolve(databasePath);
    this.#generatedDirectory = path.resolve(generatedDirectory);
    this.#trashDirectory = path.resolve(path.dirname(generatedDirectory), 'trash', 'generation');
  }

  async scan(): Promise<LibraryIntegrityReport> {
    let databaseStatus: LibraryIntegrityReport['databaseStatus'] = 'ok';
    let rows: GenerationRow[] = [];
    let intents: WriteIntentRow[] = [];
    try {
      const database = new DatabaseSync(this.#databasePath, { readOnly: true });
      try {
        const check = database.prepare('PRAGMA quick_check').all() as Array<Record<string, unknown>>;
        if (check.length !== 1 || !Object.values(check[0] ?? {}).includes('ok')) databaseStatus = 'corrupt';
        const table = database.prepare("SELECT 1 AS value FROM sqlite_master WHERE type = 'table' AND name = 'generation_results'").get();
        if (table) rows = database.prepare(`
          SELECT id, file_name, file_path, storage_mode, trashed_at, trash_path
          FROM generation_results
        `).all() as GenerationRow[];
        const intentTable = database.prepare("SELECT 1 AS value FROM sqlite_master WHERE type = 'table' AND name = 'generation_write_intents'").get();
        const assetTable = database.prepare("SELECT 1 AS value FROM sqlite_master WHERE type = 'table' AND name = 'assets'").get();
        if (intentTable) {
          intents = assetTable
            ? database.prepare(`
              SELECT generation_write_intents.*, assets.path AS source_path, assets.file_name AS source_file_name
              FROM generation_write_intents LEFT JOIN assets ON assets.id = generation_write_intents.asset_id
            `).all() as WriteIntentRow[]
            : (database.prepare('SELECT *, NULL AS source_path, NULL AS source_file_name FROM generation_write_intents').all() as WriteIntentRow[]);
        }
      } finally {
        database.close();
      }
    } catch {
      databaseStatus = 'unreadable';
    }

    const active = rows.filter((row) => row.trashed_at === null);
    const trashed = rows.filter((row) => row.trashed_at !== null);
    const expectedGenerated = new Set(active.filter((row) => row.storage_mode === 'managed').map((row) => path.resolve(row.file_path)));
    const expectedTrash = new Set(trashed.flatMap((row) => row.trash_path ? [path.resolve(row.trash_path)] : []));
    let missingActiveFiles = 0;
    let missingTrashFiles = 0;
    let unsafeManagedPaths = 0;
    let unsafeTrashPaths = 0;
    let nonRegularFiles = 0;
    let inaccessibleFiles = 0;
    let unsafeGenerationWriteIntents = 0;
    const staleGenerationWriteIntents = intents.filter((intent) => intent.created_at < Date.now() - STALE_WRITE_INTENT_MS).length;

    for (const intent of intents) {
      const expectedDirectory = expectedIntentDirectory(intent, this.#generatedDirectory);
      const expectedFile = expectedDirectory && path.basename(intent.file_name) === intent.file_name
        ? path.resolve(expectedDirectory, intent.file_name)
        : null;
      if (!expectedFile || path.resolve(intent.file_path) !== expectedFile
        || !isGenerationTemporaryPath(intent.temporary_path, intent.file_path)) {
        unsafeGenerationWriteIntents += 1;
        continue;
      }
      if (intent.storage_mode === 'managed') {
        expectedGenerated.add(expectedFile);
        expectedGenerated.add(path.resolve(intent.temporary_path));
      }
    }

    for (const row of active) {
      const filePath = path.resolve(row.file_path);
      if (row.storage_mode === 'managed' && !isWithin(this.#generatedDirectory, filePath)) {
        unsafeManagedPaths += 1;
        continue;
      }
      const result = await inspectRegularFile(filePath, row.storage_mode === 'managed' ? this.#generatedDirectory : null);
      if (result === 'missing') missingActiveFiles += 1;
      else if (result === 'unsafe') unsafeManagedPaths += 1;
      else if (result === 'non-regular') nonRegularFiles += 1;
      else if (result === 'inaccessible') inaccessibleFiles += 1;
    }

    for (const row of trashed) {
      const expected = path.resolve(this.#trashDirectory, row.id, row.file_name);
      if (!row.trash_path || path.resolve(row.trash_path) !== expected) {
        unsafeTrashPaths += 1;
        continue;
      }
      const result = await inspectRegularFile(expected, this.#trashDirectory);
      if (result === 'missing') missingTrashFiles += 1;
      else if (result === 'unsafe') unsafeTrashPaths += 1;
      else if (result === 'non-regular') nonRegularFiles += 1;
      else if (result === 'inaccessible') inaccessibleFiles += 1;
    }

    const [generatedInventory, trashInventory] = await Promise.all([
      inventoryFiles(this.#generatedDirectory),
      inventoryFiles(this.#trashDirectory)
    ]);
    inaccessibleFiles += generatedInventory.inaccessible + trashInventory.inaccessible;
    const unexpectedGeneratedFiles = [...generatedInventory.files]
      .filter((filePath) => path.basename(filePath) !== 'manifest.json' && !expectedGenerated.has(filePath)).length;
    const unexpectedTrashFiles = [...trashInventory.files].filter((filePath) => !expectedTrash.has(filePath)).length;
    const errorCount = missingActiveFiles + unsafeManagedPaths + unsafeTrashPaths + unsafeGenerationWriteIntents + nonRegularFiles + inaccessibleFiles;
    const warningCount = missingTrashFiles + staleGenerationWriteIntents + unexpectedGeneratedFiles + unexpectedTrashFiles;
    const status = databaseStatus !== 'ok' || errorCount > 0 ? 'error' : warningCount > 0 ? 'warning' : 'healthy';

    return libraryIntegrityReportSchema.parse({
      status,
      databaseStatus,
      activeGenerationResults: active.length,
      trashedGenerationResults: trashed.length,
      pendingGenerationWrites: intents.length,
      staleGenerationWriteIntents,
      unsafeGenerationWriteIntents,
      missingActiveFiles,
      missingTrashFiles,
      unsafeManagedPaths,
      unsafeTrashPaths,
      nonRegularFiles,
      inaccessibleFiles,
      unexpectedGeneratedFiles,
      unexpectedTrashFiles,
      checkedAt: Date.now()
    });
  }
}

function expectedIntentDirectory(intent: WriteIntentRow, generatedDirectory: string): string | null {
  if (intent.storage_mode === 'managed') {
    return path.join(generatedDirectory, intent.asset_id.slice(0, 2), intent.asset_id, intent.batch_id);
  }
  if (!intent.source_path || !intent.source_file_name) return null;
  const stem = sanitizeFileStem(path.parse(intent.source_file_name).name);
  const shortAssetId = intent.asset_id.replaceAll('-', '').slice(0, 8).toUpperCase();
  return path.join(path.dirname(intent.source_path), '_PhotoAllIsAI', `${stem}__${shortAssetId}`, intent.batch_id);
}

function isGenerationTemporaryPath(temporaryPath: string, filePath: string): boolean {
  if (path.dirname(path.resolve(temporaryPath)) !== path.dirname(path.resolve(filePath))) return false;
  const suffix = path.basename(temporaryPath).slice(path.basename(filePath).length);
  return /^\.\d+\.(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.tmp$/iu.test(suffix)
    || /^\.\d+\.tmp$/u.test(suffix);
}

function sanitizeFileStem(value: string): string {
  const sanitized = [...value.normalize('NFKC')]
    .map((character) => character.charCodeAt(0) < 32 || '<>:"/\\|?*'.includes(character) ? '_' : character)
    .join('')
    .replace(/[. ]+$/g, '')
    .trim();
  return (sanitized || 'image').slice(0, 120);
}

type FileInspection = 'ok' | 'missing' | 'unsafe' | 'non-regular' | 'inaccessible';

async function inspectRegularFile(filePath: string, requiredRoot: string | null): Promise<FileInspection> {
  try {
    const entry = await lstat(filePath);
    if (!entry.isFile()) return 'non-regular';
    if (requiredRoot) {
      const [root, actual] = await Promise.all([realpath(requiredRoot), realpath(filePath)]);
      if (!isWithin(root, actual)) return 'unsafe';
    }
    return 'ok';
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'inaccessible';
  }
}

async function inventoryFiles(root: string): Promise<{ files: Set<string>; inaccessible: number }> {
  const files = new Set<string>();
  let inaccessible = 0;
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') inaccessible += 1;
      continue;
    }
    for (const entry of entries) {
      const candidate = path.resolve(directory, entry.name);
      if (entry.isDirectory()) pending.push(candidate);
      else files.add(candidate);
    }
  }
  return { files, inaccessible };
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
