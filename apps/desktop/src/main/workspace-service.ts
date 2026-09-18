import { DatabaseSync } from 'node:sqlite';

import {
  workspaceSessionSchema,
  type WorkspaceSession
} from '@photoallisai/contracts';

export const defaultWorkspaceSession: WorkspaceSession = {
  version: 1,
  openTabs: ['library', 'templates', 'tasks', 'settings'],
  activeTab: 'library',
  library: {
    selectedFolderId: null,
    selectedTagId: null,
    selectedAssetId: null,
    searchQuery: ''
  }
};

export class WorkspaceService {
  readonly #database: DatabaseSync;

  constructor(databasePath: string) {
    this.#database = new DatabaseSync(databasePath);
    this.#database.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS application_state (
        key TEXT PRIMARY KEY,
        schema_version INTEGER NOT NULL,
        payload_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
  }

  close(): void {
    this.#database.close();
  }

  get(): WorkspaceSession {
    const row = this.#database.prepare(`
      SELECT schema_version, payload_json FROM application_state WHERE key = 'workspace_session'
    `).get() as { schema_version: number; payload_json: string } | undefined;
    if (!row || row.schema_version !== 1) return structuredClone(defaultWorkspaceSession);
    try {
      return workspaceSessionSchema.parse(JSON.parse(row.payload_json));
    } catch {
      return structuredClone(defaultWorkspaceSession);
    }
  }

  save(rawSession: WorkspaceSession): WorkspaceSession {
    const session = workspaceSessionSchema.parse(rawSession);
    this.#database.prepare(`
      INSERT INTO application_state (key, schema_version, payload_json, updated_at)
      VALUES ('workspace_session', ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        schema_version = excluded.schema_version,
        payload_json = excluded.payload_json,
        updated_at = excluded.updated_at
    `).run(session.version, JSON.stringify(session), Date.now());
    return session;
  }
}
