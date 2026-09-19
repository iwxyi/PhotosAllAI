import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

import {
  promptTemplateSchema,
  savePromptTemplateInputSchema,
  type PromptTemplate,
  type SavePromptTemplateInput
} from '@photoallisai/contracts';

type TemplateRow = {
  id: string;
  name: string;
  description: string;
  category: string;
  body: string;
  example_id: PromptTemplate['exampleId'];
  version: number;
  created_at: number;
  updated_at: number;
};

export class TemplateService {
  readonly #database: DatabaseSync;

  constructor(databasePath: string) {
    this.#database = new DatabaseSync(databasePath);
    this.#database.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    this.#migrate();
  }

  close(): void {
    this.#database.close();
  }

  #migrate(): void {
    this.#database.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS prompt_templates (
        id TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL,
        archived_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS prompt_template_versions (
        template_id TEXT NOT NULL REFERENCES prompt_templates(id) ON DELETE CASCADE,
        version INTEGER NOT NULL,
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        category TEXT NOT NULL,
        body TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (template_id, version)
      );
      CREATE INDEX IF NOT EXISTS template_versions_latest_idx
        ON prompt_template_versions(template_id, version DESC);
      COMMIT;
    `);
    const columns = this.#database.prepare('PRAGMA table_info(prompt_template_versions)').all() as { name: string }[];
    if (!columns.some((column) => column.name === 'example_id')) {
      this.#database.exec("ALTER TABLE prompt_template_versions ADD COLUMN example_id TEXT NOT NULL DEFAULT 'none'");
    }
    const templateColumns = this.#database.prepare('PRAGMA table_info(prompt_templates)').all() as { name: string }[];
    if (!templateColumns.some((column) => column.name === 'archived_at')) {
      this.#database.exec('ALTER TABLE prompt_templates ADD COLUMN archived_at INTEGER');
    }
  }

  list(): PromptTemplate[] {
    const rows = this.#database.prepare(`
        SELECT t.id, v.name, v.description, v.category, v.body, v.example_id, v.version,
        t.created_at, v.created_at AS updated_at
      FROM prompt_templates t
      JOIN prompt_template_versions v ON v.template_id = t.id
      WHERE t.archived_at IS NULL AND v.version = (
        SELECT MAX(latest.version) FROM prompt_template_versions latest
        WHERE latest.template_id = t.id
      )
      ORDER BY v.created_at DESC, t.id ASC
    `).all() as TemplateRow[];
    return rows.map((row) => this.#toTemplate(row));
  }

  save(rawInput: SavePromptTemplateInput): PromptTemplate {
    const input = savePromptTemplateInputSchema.parse(rawInput);
    const now = Date.now();
    const id = input.id ?? randomUUID();
    const existing = this.#database
      .prepare('SELECT created_at, archived_at FROM prompt_templates WHERE id = ?')
      .get(id) as { created_at: number; archived_at: number | null } | undefined;
    if (input.id && !existing) throw new Error('TEMPLATE_NOT_FOUND');
    if (existing?.archived_at) throw new Error('TEMPLATE_ARCHIVED');
    const maximum = this.#database
      .prepare('SELECT COALESCE(MAX(version), 0) AS value FROM prompt_template_versions WHERE template_id = ?')
      .get(id) as { value: number };
    const version = maximum.value + 1;

    this.#database.exec('BEGIN IMMEDIATE');
    try {
      if (!existing) {
        this.#database.prepare('INSERT INTO prompt_templates (id, created_at) VALUES (?, ?)').run(id, now);
      }
      this.#database.prepare(`
        INSERT INTO prompt_template_versions (
          template_id, version, name, description, category, body, example_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, version, input.name.trim(), input.description.trim(), input.category.trim(), input.body.trim(), input.exampleId ?? 'none', now);
      this.#database.exec('COMMIT');
    } catch (error) {
      this.#database.exec('ROLLBACK');
      throw error;
    }

    return promptTemplateSchema.parse({
      id,
      name: input.name.trim(),
      description: input.description.trim(),
      category: input.category.trim(),
      body: input.body.trim(),
      exampleId: input.exampleId ?? 'none',
      version,
      createdAt: existing?.created_at ?? now,
      updatedAt: now
    });
  }

  archive(templateId: string): void {
    const result = this.#database.prepare(`
      UPDATE prompt_templates SET archived_at = ? WHERE id = ? AND archived_at IS NULL
    `).run(Date.now(), templateId);
    if (result.changes !== 1) throw new Error('TEMPLATE_NOT_FOUND');
  }

  #toTemplate(row: TemplateRow): PromptTemplate {
    return promptTemplateSchema.parse({
      id: row.id,
      name: row.name,
      description: row.description,
      category: row.category,
      body: row.body,
      exampleId: row.example_id,
      version: row.version,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    });
  }
}
