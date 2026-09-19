import { mkdir, mkdtemp, readFile, stat } from 'node:fs/promises';
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
});
