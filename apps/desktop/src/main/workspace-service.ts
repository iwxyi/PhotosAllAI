import { DatabaseSync } from 'node:sqlite';

import {
  workspaceSessionV1Schema,
  workspaceSessionSchema,
  type WorkspaceSession
} from '@photoallisai/contracts';

export const defaultWorkspaceSession: WorkspaceSession = {
  version: 2,
  openTabs: ['library'],
  activeTab: 'library',
  library: {
    selectedFolderId: null,
    selectedAlbumId: null,
    selectedSmartCollection: null,
    selectedTagId: null,
    selectedAssetId: null,
    favoriteOnly: false,
    sortBy: 'modifiedAt',
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
    if (!row) return structuredClone(defaultWorkspaceSession);
    try {
      if (row.schema_version === 1) {
        const legacy = workspaceSessionV1Schema.parse(JSON.parse(row.payload_json));
        return workspaceSessionSchema.parse({
          ...defaultWorkspaceSession,
          openTabs: legacy.openTabs,
          activeTab: legacy.activeTab,
          library: { ...defaultWorkspaceSession.library, ...legacy.library }
        });
      }
      if (row.schema_version !== 2) return structuredClone(defaultWorkspaceSession);
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
