import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';

import { DatabaseBackupService } from './database-backup-service';

describe('database backup service', () => {
  it('creates a consistent snapshot while the source database is open', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'photoallisai-backup-'));
    const databasePath = path.join(root, 'catalog.sqlite');
    const backupPath = path.join(root, 'backups', 'catalog.sqlite');
    const database = new DatabaseSync(databasePath);
    database.exec('PRAGMA journal_mode = WAL; CREATE TABLE records (id INTEGER PRIMARY KEY, value TEXT NOT NULL);');
    database.prepare('INSERT INTO records (value) VALUES (?)').run('中文照片');
    const service = new DatabaseBackupService(databasePath);

    const result = await service.create(backupPath);
    expect(result.destinationPath).toBe(path.resolve(backupPath));
    expect(result.bytes).toBe((await stat(backupPath)).size);
    expect(result.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(await readFile(backupPath)).not.toHaveLength(0);
    const restored = new DatabaseSync(backupPath);
    expect(restored.prepare('SELECT value FROM records').get()).toEqual({ value: '中文照片' });
    restored.close();
    database.close();
  });

  it('rejects using the live database as its destination', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'photoallisai-backup-source-'));
    const databasePath = path.join(root, 'catalog.sqlite');
    await mkdir(root, { recursive: true });
    const database = new DatabaseSync(databasePath);
    database.exec('CREATE TABLE records (id INTEGER PRIMARY KEY);');
    database.close();
    await expect(new DatabaseBackupService(databasePath).create(databasePath)).rejects.toThrow('BACKUP_DESTINATION_IS_SOURCE');
  });

  it('safely replaces an existing backup file', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'photoallisai-backup-replace-'));
    const databasePath = path.join(root, 'catalog.sqlite');
    const backupPath = path.join(root, 'backup.sqlite');
    const database = new DatabaseSync(databasePath);
    database.exec('CREATE TABLE records (value TEXT NOT NULL); INSERT INTO records VALUES (\'current\');');
    await writeFile(backupPath, 'previous-backup');

    await new DatabaseBackupService(databasePath).create(backupPath);

    const restored = new DatabaseSync(backupPath, { readOnly: true });
    expect(restored.prepare('SELECT value FROM records').get()).toEqual({ value: 'current' });
    restored.close();
    expect((await readdir(root)).filter((name) => name.includes('.previous') || name.endsWith('.tmp'))).toEqual([]);
    database.close();
  });

  it('isolates concurrent snapshots targeting the same destination', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'photoallisai-backup-concurrent-'));
    const databasePath = path.join(root, 'catalog.sqlite');
    const database = new DatabaseSync(databasePath);
    database.exec('CREATE TABLE marker (value TEXT NOT NULL); INSERT INTO marker VALUES (\'concurrent\');');
    database.close();
    const destination = path.join(root, 'backup.sqlite');
    const service = new DatabaseBackupService(databasePath);

    const results = await Promise.allSettled([service.create(destination), service.create(destination)]);
    expect(results.some((result) => result.status === 'fulfilled')).toBe(true);
    const restored = new DatabaseSync(destination, { readOnly: true });
    expect(restored.prepare('SELECT value FROM marker').get()).toEqual({ value: 'concurrent' });
    restored.close();
    expect((await readdir(root)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('skips fresh automatic backups and removes snapshots beyond retention', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'photoallisai-backup-rotation-'));
    const databasePath = path.join(root, 'catalog.sqlite');
    const backupDirectory = path.join(root, 'backups');
    const database = new DatabaseSync(databasePath);
    database.exec('CREATE TABLE records (id INTEGER PRIMARY KEY);');
    database.close();
    const service = new DatabaseBackupService(databasePath);

    await expect(service.createAutomatic(backupDirectory, { now: 1_000, minimumIntervalMs: 500, retention: 2 })).resolves.not.toBeNull();
    await expect(service.createAutomatic(backupDirectory, { now: 1_200, minimumIntervalMs: 500, retention: 2 })).resolves.toBeNull();
    await service.createAutomatic(backupDirectory, { now: 2_000, minimumIntervalMs: 0, retention: 2 });
    await service.createAutomatic(backupDirectory, { now: 3_000, minimumIntervalMs: 0, retention: 2 });
    expect((await readdir(backupDirectory)).sort()).toEqual(['catalog-2000.sqlite', 'catalog-3000.sqlite']);
  });

  it('serializes concurrent automatic backup decisions', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'photoallisai-backup-auto-concurrent-'));
    const databasePath = path.join(root, 'catalog.sqlite');
    const backupDirectory = path.join(root, 'backups');
    const database = new DatabaseSync(databasePath);
    database.exec('CREATE TABLE records (id INTEGER PRIMARY KEY);');
    database.close();
    const service = new DatabaseBackupService(databasePath);

    const results = await Promise.all([
      service.createAutomatic(backupDirectory, { now: 4_000, minimumIntervalMs: 500 }),
      service.createAutomatic(backupDirectory, { now: 4_000, minimumIntervalMs: 500 })
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect((await readdir(backupDirectory)).filter((name) => name.endsWith('.sqlite'))).toEqual(['catalog-4000.sqlite']);
  });
});
