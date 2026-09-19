import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it } from 'vitest';

import { DatabaseMigrationService } from './database-migration-service';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'photoallisai-migration-'));
  roots.push(root);
  const databasePath = path.join(root, 'catalog.sqlite');
  const database = new DatabaseSync(databasePath);
  database.exec('CREATE TABLE records (value TEXT NOT NULL); INSERT INTO records VALUES (\'before\');');
  database.close();
  return { root, databasePath };
}

describe('database migration checkpoints', () => {
  it('commits the application schema version only after migration succeeds', async () => {
    const context = await fixture();
    const service = new DatabaseMigrationService(context.databasePath);
    const checkpoint = await service.prepare(1, 100);
    expect(checkpoint).toMatchObject({ sourceVersion: 0, targetVersion: 1 });
    const migrated = new DatabaseSync(context.databasePath);
    migrated.exec("ALTER TABLE records ADD COLUMN migrated INTEGER NOT NULL DEFAULT 1");
    migrated.close();

    await service.complete(1, checkpoint);

    expect(JSON.parse(await readFile(path.join(context.root, 'schema-state.json'), 'utf8'))).toEqual({ schemaVersion: 1 });
    expect(await readdir(context.root)).not.toContain('migration-pending.json');
    await expect(service.prepare(1, 200)).resolves.toBeNull();
    const secondCheckpoint = await service.prepare(2, 200);
    expect(secondCheckpoint).toMatchObject({ sourceVersion: 1, targetVersion: 2 });
    await service.complete(2, secondCheckpoint);
    expect(JSON.parse(await readFile(path.join(context.root, 'schema-state.json'), 'utf8'))).toEqual({ schemaVersion: 2 });
    expect((await readdir(context.root)).filter((name) => name.endsWith('.tmp') || name.includes('.previous'))).toEqual([]);
    const database = new DatabaseSync(context.databasePath, { readOnly: true });
    expect(database.prepare('SELECT migrated FROM records').get()).toEqual({ migrated: 1 });
    database.close();
  });

  it('restores the checkpoint on the next launch after an interrupted migration', async () => {
    const context = await fixture();
    const service = new DatabaseMigrationService(context.databasePath);
    await service.prepare(1, 300);
    const migrated = new DatabaseSync(context.databasePath);
    migrated.exec("UPDATE records SET value = 'after'; ALTER TABLE records ADD COLUMN partial INTEGER;");
    migrated.close();

    await expect(service.recoverPending(400)).resolves.toBe(true);

    const restored = new DatabaseSync(context.databasePath, { readOnly: true });
    expect(restored.prepare('SELECT value FROM records').get()).toEqual({ value: 'before' });
    expect(restored.prepare('PRAGMA table_info(records)').all()).not.toEqual(expect.arrayContaining([expect.objectContaining({ name: 'partial' })]));
    restored.close();
    const files = await readdir(context.root);
    expect(files).not.toContain('migration-pending.json');
    expect(files.some((name) => name.startsWith('catalog.sqlite.migration-failed-400'))).toBe(true);
  });

  it('preserves an existing migration failure artifact when recovery runs again', async () => {
    const context = await fixture();
    const service = new DatabaseMigrationService(context.databasePath);
    await service.prepare(1, 500);
    await writeFile(`${context.databasePath}.migration-failed-600`, 'existing evidence');
    const migrated = new DatabaseSync(context.databasePath);
    migrated.exec("UPDATE records SET value = 'after';");
    migrated.close();

    await expect(service.recoverPending(600)).resolves.toBe(true);

    expect(await readFile(`${context.databasePath}.migration-failed-600`, 'utf8')).toBe('existing evidence');
    expect(await readFile(`${context.databasePath}.migration-failed-600-1`, 'utf8')).toContain('SQLite format 3');
  });

  it('rejects a database created by a newer application schema', async () => {
    const context = await fixture();
    const service = new DatabaseMigrationService(context.databasePath);
    await service.complete(2, null);
    await expect(service.prepare(1)).rejects.toThrow('MIGRATION_DATABASE_NEWER_THAN_APP');
  });

  it('does not follow a symbolic link when committing schema state', async () => {
    const context = await fixture();
    const outside = path.join(context.root, 'outside-state.json');
    const statePath = path.join(context.root, 'schema-state.json');
    await writeFile(outside, JSON.stringify({ schemaVersion: 99 }));
    await symlink(outside, statePath);

    await expect(new DatabaseMigrationService(context.databasePath).complete(1, null))
      .rejects.toThrow('DESTINATION_NOT_REGULAR_FILE');

    expect(JSON.parse(await readFile(outside, 'utf8'))).toEqual({ schemaVersion: 99 });
    expect((await readdir(context.root)).filter((name) => name.endsWith('.tmp') || name.includes('.previous'))).toEqual([]);
  });
});
