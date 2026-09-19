import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rename as fsRename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it } from 'vitest';

import { LibraryBackupService } from './library-backup-service';
import { LibraryRestoreService } from './library-restore-service';

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'photoallisai-restore-'));
  roots.push(root);
  const library = path.join(root, 'library');
  const generated = path.join(library, 'generated');
  const backups = path.join(root, 'external');
  await Promise.all([mkdir(generated, { recursive: true }), mkdir(backups)]);
  const databasePath = path.join(library, 'catalog.sqlite');
  const resultId = randomUUID();
  const managedPath = path.join(generated, resultId, 'result.jpg');
  await mkdir(path.dirname(managedPath), { recursive: true });
  await writeFile(managedPath, 'backup-result');
  const database = new DatabaseSync(databasePath);
  database.exec('CREATE TABLE generation_results (id TEXT PRIMARY KEY, file_path TEXT NOT NULL, storage_mode TEXT NOT NULL); CREATE TABLE marker (value TEXT NOT NULL);');
  database.prepare('INSERT INTO generation_results VALUES (?, ?, ?)').run(resultId, managedPath, 'managed');
  database.prepare('INSERT INTO marker VALUES (?)').run('backup');
  database.close();
  const backupService = new LibraryBackupService(databasePath, generated);
  const backup = await backupService.create(backups, 100);
  return { root, library, generated, databasePath, resultId, backupService, backup };
}

describe('library restore service', () => {
  it('stages a verified package and atomically preserves the replaced library', async () => {
    const context = await fixture();
    const canonicalRoot = await import('node:fs/promises').then(({ realpath }) => realpath(context.root));
    const live = new DatabaseSync(context.databasePath);
    live.prepare('UPDATE marker SET value = ?').run('live-after-backup');
    live.close();
    await writeFile(path.join(context.generated, context.resultId, 'result.jpg'), 'live-result');
    const service = new LibraryRestoreService(context.library, context.backupService);

    await expect(service.stage(context.backup.destinationPath, 200)).resolves.toMatchObject({ generatedFiles: 1 });
    const applied = await service.applyPending(300);

    expect(applied?.recoveryPath).toBe(path.join(canonicalRoot, 'library.before-restore-300'));
    const restored = new DatabaseSync(context.databasePath, { readOnly: true });
    expect(restored.prepare('SELECT value FROM marker').get()).toEqual({ value: 'backup' });
    expect(restored.prepare('SELECT file_path FROM generation_results').get()).toEqual({
      file_path: path.join(canonicalRoot, 'library', 'generated', context.resultId, 'result.jpg')
    });
    restored.close();
    expect(await readFile(path.join(context.generated, context.resultId, 'result.jpg'), 'utf8')).toBe('backup-result');
    expect(await readFile(path.join(applied!.recoveryPath!, 'generated', context.resultId, 'result.jpg'), 'utf8')).toBe('live-result');
    expect(await readdir(context.root)).not.toContain('library-restore-pending.json');
  });

  it('leaves the live library untouched when staged data fails revalidation', async () => {
    const context = await fixture();
    const service = new LibraryRestoreService(context.library, context.backupService);
    await service.stage(context.backup.destinationPath, 400);
    const marker = JSON.parse(await readFile(path.join(context.root, 'library-restore-pending.json'), 'utf8')) as { stagingName: string };
    await writeFile(path.join(context.root, marker.stagingName, 'generated', context.resultId, 'result.jpg'), 'tampered');

    await expect(service.applyPending(500)).rejects.toThrow('BACKUP_GENERATED_CHECKSUM_MISMATCH');

    const live = new DatabaseSync(context.databasePath, { readOnly: true });
    expect(live.prepare('SELECT value FROM marker').get()).toEqual({ value: 'backup' });
    live.close();
    expect(await readdir(context.root)).toContain('library-restore-pending.json');
  });

  it('keeps failed marker evidence unique and rejects marker symlinks', async () => {
    const context = await fixture();
    const service = new LibraryRestoreService(context.library, context.backupService);
    await service.stage(context.backup.destinationPath, 600);
    const first = await service.quarantinePending(700);
    expect(first).toBe(path.join(context.root, 'library-restore-pending.json.failed-700'));

    await writeFile(path.join(context.root, 'library-restore-pending.json'), 'invalid');
    const second = await service.quarantinePending(700);
    expect(second).toBe(path.join(context.root, 'library-restore-pending.json.failed-700-1'));
    expect(await readdir(context.root)).toEqual(expect.arrayContaining([
      'library-restore-pending.json.failed-700',
      'library-restore-pending.json.failed-700-1'
    ]));

    await symlink(first!, path.join(context.root, 'library-restore-pending.json'));
    await expect(service.applyPending(800)).rejects.toThrow('LIBRARY_RESTORE_MARKER_UNSAFE');
    await expect(service.quarantinePending(800)).rejects.toThrow('LIBRARY_RESTORE_MARKER_UNSAFE');
  });

  it('surfaces rollback failure when publishing the replacement library fails', async () => {
    const context = await fixture();
    const service = new LibraryRestoreService(context.library, context.backupService);
    await service.stage(context.backup.destinationPath, 900);

    let renameCalls = 0;
    const fileSystem = {
      rename: async (source: Parameters<typeof fsRename>[0], destination: Parameters<typeof fsRename>[1]) => {
        renameCalls += 1;
        if (renameCalls === 2) throw new Error('PUBLISH_FAILED');
        if (renameCalls === 3) throw new Error('ROLLBACK_FAILED');
        await fsRename(source, destination);
      }
    };
    const failingService = new LibraryRestoreService(context.library, context.backupService, fileSystem);

    await expect(failingService.applyPending(901)).rejects.toMatchObject({
      message: 'LIBRARY_RESTORE_ROLLBACK_FAILED',
      errors: [expect.objectContaining({ message: 'PUBLISH_FAILED' }), expect.objectContaining({ message: 'ROLLBACK_FAILED' })]
    });
    expect(await readdir(context.root)).toContain('library-restore-pending.json');
    expect(await readdir(context.root)).toContain('library.before-restore-901');
    expect(await readdir(context.root)).not.toContain('library');
  });
});
