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
    const errorCount = missingActiveFiles + unsafeManagedPaths + unsafeTrashPaths + nonRegularFiles + inaccessibleFiles;
    const warningCount = missingTrashFiles + unexpectedGeneratedFiles + unexpectedTrashFiles;
    const status = databaseStatus !== 'ok' || errorCount > 0 ? 'error' : warningCount > 0 ? 'warning' : 'healthy';

    return libraryIntegrityReportSchema.parse({
      status,
      databaseStatus,
      activeGenerationResults: active.length,
      trashedGenerationResults: trashed.length,
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
