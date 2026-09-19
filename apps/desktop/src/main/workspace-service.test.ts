import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it } from 'vitest';

import { defaultWorkspaceSession, WorkspaceService } from './workspace-service';

const temporaryDirectories: string[] = [];

async function databasePath(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'photoallisai-workspace-'));
  temporaryDirectories.push(directory);
  return path.join(directory, 'catalog.sqlite');
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('workspace session service', () => {
  it('returns defaults and restores a versioned session after restart', async () => {
    const file = await databasePath();
    const service = new WorkspaceService(file);
    expect(service.get()).toEqual(defaultWorkspaceSession);
    service.save({
      version: 2,
      openTabs: ['library', 'tasks'],
      activeTab: 'tasks',
      library: {
        selectedFolderId: 'folder-1',
        selectedAlbumId: null,
        selectedSmartCollection: 'recent',
        selectedTagId: null,
        selectedAssetId: 'asset-1',
        favoriteOnly: true,
        sortBy: 'rating',
        searchQuery: '夜景'
      }
    });
    service.close();

    const restored = new WorkspaceService(file);
    expect(restored.get()).toMatchObject({
      openTabs: ['library', 'tasks'],
      activeTab: 'tasks',
      library: {
        selectedFolderId: 'folder-1',
        selectedSmartCollection: 'recent',
        selectedAssetId: 'asset-1',
        favoriteOnly: true,
        sortBy: 'rating',
        searchQuery: '夜景'
      }
    });
    restored.close();
  });

  it('migrates a valid version 1 session with safe defaults for new filters', async () => {
    const file = await databasePath();
    const service = new WorkspaceService(file);
    service.close();
    const database = new DatabaseSync(file);
    database.prepare(`
      INSERT INTO application_state (key, schema_version, payload_json, updated_at)
      VALUES ('workspace_session', 1, ?, 1)
    `).run(JSON.stringify({
      version: 1,
      openTabs: ['library', 'settings'],
      activeTab: 'settings',
      library: {
        selectedFolderId: 'folder-legacy',
        selectedTagId: null,
        selectedAssetId: 'asset-legacy',
        searchQuery: '旧会话'
      }
    }));
    database.close();

    const restored = new WorkspaceService(file);
    expect(restored.get()).toEqual({
      version: 2,
      openTabs: ['library', 'settings'],
      activeTab: 'settings',
      library: {
        selectedFolderId: 'folder-legacy',
        selectedAlbumId: null,
        selectedSmartCollection: null,
        selectedTagId: null,
        selectedAssetId: 'asset-legacy',
        favoriteOnly: false,
        sortBy: 'modifiedAt',
        searchQuery: '旧会话'
      }
    });
    restored.close();
  });

  it('falls back safely when persisted state is corrupt', async () => {
    const file = await databasePath();
    const service = new WorkspaceService(file);
    service.close();
    const database = new DatabaseSync(file);
    database.prepare(`
      INSERT INTO application_state (key, schema_version, payload_json, updated_at)
      VALUES ('workspace_session', 2, 'not-json', 1)
    `).run();
    database.close();

    const restored = new WorkspaceService(file);
    expect(restored.get()).toEqual(defaultWorkspaceSession);
    restored.close();
  });

  it('rejects sessions that close the library or activate a closed tab', async () => {
    const service = new WorkspaceService(await databasePath());
    expect(() => service.save({
      version: 2,
      openTabs: ['tasks'],
      activeTab: 'tasks',
      library: { ...defaultWorkspaceSession.library }
    })).toThrow();
    expect(() => service.save({
      version: 2,
      openTabs: ['library'],
      activeTab: 'settings',
      library: { ...defaultWorkspaceSession.library }
    })).toThrow();
    service.close();
  });
});
