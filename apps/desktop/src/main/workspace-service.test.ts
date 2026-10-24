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
  it('removes legacy viewer tabs and restores the library when the viewer was active', async () => {
    const file = await databasePath();
    const service = new WorkspaceService(file);
    service.save({ ...defaultWorkspaceSession, openTabs: ['library', 'viewer', 'tasks'], activeTab: 'viewer' });
    expect(service.get()).toMatchObject({ openTabs: ['library', 'tasks'], activeTab: 'library' });
    service.close();
    const database = new DatabaseSync(file);
    database.prepare('UPDATE application_state SET payload_json = ? WHERE key = ?').run(JSON.stringify({ ...defaultWorkspaceSession, openTabs: ['library', 'viewer'], activeTab: 'viewer' }), 'workspace_session');
    database.close();
    const restored = new WorkspaceService(file);
    expect(restored.get()).toMatchObject({ openTabs: ['library'], activeTab: 'library' });
    restored.close();
  });
  it('merges legacy task detail tabs into the task center after restart', async () => {
    const file = await databasePath();
    const service = new WorkspaceService(file);
    const tab = 'task:analysis:19d42fac-a42a-405a-8a82-b67154f259a3' as const;
    service.save({ ...defaultWorkspaceSession, openTabs: ['library', tab], activeTab: tab });
    service.close();
    const restored = new WorkspaceService(file);
    expect(restored.get().openTabs).toEqual(['library', 'tasks']);
    expect(restored.get().activeTab).toBe('tasks');
    restored.close();
  });

  it('returns defaults and restores a versioned session after restart', async () => {
    const file = await databasePath();
    const service = new WorkspaceService(file);
    expect(service.get()).toEqual(defaultWorkspaceSession);
    expect(defaultWorkspaceSession.openTabs).toEqual(['library']);
    expect(() => service.save({
      ...defaultWorkspaceSession,
      openTabs: ['library', 'viewer'],
      activeTab: 'viewer'
    })).not.toThrow();
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

  it('restores the retired workflow tab as AI batch editing', async () => {
    const file = await databasePath();
    const service = new WorkspaceService(file);
    service.save({
      ...defaultWorkspaceSession,
      openTabs: ['library', 'viewer', 'workflow'],
      activeTab: 'workflow'
    });
    service.close();

    const restored = new WorkspaceService(file);
    expect(restored.get()).toMatchObject({
      openTabs: ['library', 'batch'],
      activeTab: 'batch'
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
