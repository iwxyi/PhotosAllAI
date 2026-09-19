import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

import {
  exportPresetSchema,
  saveExportPresetInputSchema,
  type ExportPreset,
  type SaveExportPresetInput
} from '@photoallisai/contracts';

export class ExportPresetService {
  readonly #database: DatabaseSync;

  constructor(databasePath: string) {
    this.#database = new DatabaseSync(databasePath);
    this.#database.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS export_presets (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        format TEXT NOT NULL DEFAULT 'original',
        quality INTEGER NOT NULL DEFAULT 90,
        max_dimension INTEGER,
        conflict_policy TEXT NOT NULL DEFAULT 'auto-rename',
        naming_pattern TEXT NOT NULL DEFAULT '{name}_{version}',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
    const columns = this.#database.prepare('PRAGMA table_info(export_presets)').all() as { name: string }[];
    if (!columns.some((column) => column.name === 'quality')) this.#database.exec('ALTER TABLE export_presets ADD COLUMN quality INTEGER NOT NULL DEFAULT 90');
    if (!columns.some((column) => column.name === 'max_dimension')) this.#database.exec('ALTER TABLE export_presets ADD COLUMN max_dimension INTEGER');
  }

  close(): void {
    this.#database.close();
  }

  list(): ExportPreset[] {
    const rows = this.#database.prepare('SELECT * FROM export_presets ORDER BY name COLLATE NOCASE').all() as ExportPresetRow[];
    return rows.map((row) => this.#toPreset(row));
  }

  save(rawInput: SaveExportPresetInput): ExportPreset {
    const input = saveExportPresetInputSchema.parse(rawInput);
    const now = Date.now();
    const id = input.id ?? randomUUID();
    const existing = this.#database.prepare('SELECT created_at FROM export_presets WHERE id = ?').get(id) as { created_at: number } | undefined;
    try {
      this.#database.prepare(`
        INSERT INTO export_presets (id, name, format, quality, max_dimension, conflict_policy, naming_pattern, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET name = excluded.name, format = excluded.format,
          quality = excluded.quality, max_dimension = excluded.max_dimension,
          conflict_policy = excluded.conflict_policy, naming_pattern = excluded.naming_pattern, updated_at = excluded.updated_at
      `).run(id, input.name.trim(), input.format, input.quality, input.maxDimension, input.conflictPolicy, input.namingPattern.trim(), existing?.created_at ?? now, now);
    } catch (error) {
      if (error instanceof Error && error.message.includes('UNIQUE')) throw new Error('EXPORT_PRESET_NAME_EXISTS');
      throw error;
    }
    return this.#toPreset(this.#database.prepare('SELECT * FROM export_presets WHERE id = ?').get(id) as ExportPresetRow);
  }

  delete(id: string): void {
    this.#database.prepare('DELETE FROM export_presets WHERE id = ?').run(id);
  }

  #toPreset(row: ExportPresetRow): ExportPreset {
    return exportPresetSchema.parse({
      id: row.id,
      name: row.name,
      format: row.format,
      quality: row.quality,
      maxDimension: row.max_dimension,
      conflictPolicy: row.conflict_policy,
      namingPattern: row.naming_pattern,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    });
  }
}

type ExportPresetRow = {
  id: string;
  name: string;
  format: 'original' | 'jpeg' | 'png';
  quality: number;
  max_dimension: number | null;
  conflict_policy: 'auto-rename' | 'skip';
  naming_pattern: string;
  created_at: number;
  updated_at: number;
};
