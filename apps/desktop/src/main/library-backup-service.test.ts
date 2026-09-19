import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it } from 'vitest';

import { LibraryBackupService } from './library-backup-service';

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'photoallisai-library-backup-'));
  roots.push(root);
  const library = path.join(root, 'library');
  const generated = path.join(library, 'generated');
  const destination = path.join(root, 'destination');
  await Promise.all([mkdir(generated, { recursive: true }), mkdir(destination)]);
  const databasePath = path.join(library, 'catalog.sqlite');
  const database = new DatabaseSync(databasePath);
  database.exec(`CREATE TABLE generation_results (id TEXT PRIMARY KEY, file_path TEXT NOT NULL, storage_mode TEXT NOT NULL)`);
  return { root, library, generated, destination, databasePath, database };
}

describe('complete library backup', () => {
  it('exports a consistent catalog and hashed managed results without portable files', async () => {
    const context = await fixture();
    const managedId = randomUUID();
    const portableId = randomUUID();
    const managedPath = path.join(context.generated, 'ab', managedId, 'result.jpg');
    const portablePath = path.join(context.root, 'originals', '_PhotoAllIsAI', 'portable.jpg');
    await Promise.all([mkdir(path.dirname(managedPath), { recursive: true }), mkdir(path.dirname(portablePath), { recursive: true })]);
    await Promise.all([writeFile(managedPath, 'managed-result'), writeFile(portablePath, 'portable-result')]);
    const insert = context.database.prepare('INSERT INTO generation_results VALUES (?, ?, ?)');
    insert.run(managedId, managedPath, 'managed');
    insert.run(portableId, portablePath, 'portable');
    const service = new LibraryBackupService(context.databasePath, context.generated);

    const result = await service.create(context.destination, 1_700_000_000_000);

    expect(result).toMatchObject({ generatedFiles: 1, generatedBytes: 14 });
    expect(result.manifestSha256).toMatch(/^[a-f0-9]{64}$/);
    const manifestBytes = await readFile(path.join(result.destinationPath, 'manifest.json'));
    const manifest = JSON.parse(manifestBytes.toString('utf8')) as { catalog: { sha256: string }; generated: Array<{ resultId: string; relativePath: string; sha256: string }> };
    expect(manifest.generated).toEqual([{ resultId: managedId, relativePath: `ab/${managedId}/result.jpg`, bytes: 14, sha256: createHash('sha256').update('managed-result').digest('hex') }]);
    expect(createHash('sha256').update(manifestBytes).digest('hex')).toBe(result.manifestSha256);
    expect(await readFile(path.join(result.destinationPath, 'generated', 'ab', managedId, 'result.jpg'), 'utf8')).toBe('managed-result');
    await expect(service.verify(result.destinationPath)).resolves.toEqual({
      createdAt: '2023-11-14T22:13:20.000Z',
      databaseBytes: result.databaseBytes,
      generatedFiles: 1,
      generatedBytes: 14
    });
    const snapshot = new DatabaseSync(path.join(result.destinationPath, 'catalog.sqlite'), { readOnly: true });
    expect(snapshot.prepare('SELECT COUNT(*) AS value FROM generation_results').get()).toEqual({ value: 2 });
    snapshot.close();
    context.database.close();
  });

  it('rejects generated files that no longer match the hashed inventory', async () => {
    const context = await fixture();
    const resultId = randomUUID();
    const managedPath = path.join(context.generated, resultId, 'result.jpg');
    await mkdir(path.dirname(managedPath), { recursive: true });
    await writeFile(managedPath, 'original-result');
    context.database.prepare('INSERT INTO generation_results VALUES (?, ?, ?)').run(resultId, managedPath, 'managed');
    const service = new LibraryBackupService(context.databasePath, context.generated);
    const result = await service.create(context.destination, 44);
    await writeFile(path.join(result.destinationPath, 'generated', resultId, 'result.jpg'), 'tampered-result');

    await expect(service.verify(result.destinationPath)).rejects.toThrow('BACKUP_GENERATED_CHECKSUM_MISMATCH');
    context.database.close();
  });

  it('excludes recycled result records and payloads from a backup snapshot', async () => {
    const context = await fixture();
    context.database.exec('ALTER TABLE generation_results ADD COLUMN trashed_at INTEGER');
    const activeId = randomUUID();
    const trashedId = randomUUID();
    const activePath = path.join(context.generated, activeId, 'active.jpg');
    const trashPath = path.join(context.library, 'trash', 'generation', trashedId, 'trashed.jpg');
    await Promise.all([mkdir(path.dirname(activePath), { recursive: true }), mkdir(path.dirname(trashPath), { recursive: true })]);
    await Promise.all([writeFile(activePath, 'active'), writeFile(trashPath, 'trashed')]);
    context.database.prepare('INSERT INTO generation_results VALUES (?, ?, ?, ?)').run(activeId, activePath, 'managed', null);
    context.database.prepare('INSERT INTO generation_results VALUES (?, ?, ?, ?)').run(trashedId, path.join(context.generated, trashedId, 'trashed.jpg'), 'managed', Date.now());
    const service = new LibraryBackupService(context.databasePath, context.generated);

    const result = await service.create(context.destination, 47);

    expect(result.generatedFiles).toBe(1);
    const snapshot = new DatabaseSync(path.join(result.destinationPath, 'catalog.sqlite'), { readOnly: true });
    expect(snapshot.prepare('SELECT id FROM generation_results ORDER BY id').all()).toEqual([{ id: activeId }]);
    snapshot.close();
    await expect(service.verify(result.destinationPath)).resolves.toMatchObject({ generatedFiles: 1 });
    expect(await readFile(trashPath, 'utf8')).toBe('trashed');
    context.database.close();
  });

  it('excludes interrupted generation writes and their provisional result records', async () => {
    const context = await fixture();
    context.database.exec(`
      CREATE TABLE generation_write_intents (
        result_id TEXT PRIMARY KEY,
        file_path TEXT NOT NULL
      )
    `);
    const stableId = randomUUID();
    const pendingId = randomUUID();
    const stablePath = path.join(context.generated, stableId, 'stable.jpg');
    const pendingPath = path.join(context.generated, pendingId, 'pending.jpg');
    await Promise.all([mkdir(path.dirname(stablePath)), mkdir(path.dirname(pendingPath))]);
    await Promise.all([writeFile(stablePath, 'stable'), writeFile(pendingPath, 'pending')]);
    const insert = context.database.prepare('INSERT INTO generation_results VALUES (?, ?, ?)');
    insert.run(stableId, stablePath, 'managed');
    insert.run(pendingId, pendingPath, 'managed');
    context.database.prepare('INSERT INTO generation_write_intents VALUES (?, ?)').run(pendingId, pendingPath);

    const result = await new LibraryBackupService(context.databasePath, context.generated).create(context.destination, 48);

    expect(result.generatedFiles).toBe(1);
    const snapshot = new DatabaseSync(path.join(result.destinationPath, 'catalog.sqlite'), { readOnly: true });
    expect(snapshot.prepare('SELECT id FROM generation_results').all()).toEqual([{ id: stableId }]);
    expect(snapshot.prepare('SELECT COUNT(*) AS value FROM generation_write_intents').get()).toEqual({ value: 0 });
    snapshot.close();
    context.database.close();
  });

  it('rejects traversal paths before reading generated files', async () => {
    const context = await fixture();
    const resultId = randomUUID();
    const managedPath = path.join(context.generated, resultId, 'result.jpg');
    await mkdir(path.dirname(managedPath), { recursive: true });
    await writeFile(managedPath, 'managed-result');
    context.database.prepare('INSERT INTO generation_results VALUES (?, ?, ?)').run(resultId, managedPath, 'managed');
    const service = new LibraryBackupService(context.databasePath, context.generated);
    const result = await service.create(context.destination, 45);
    const manifestPath = path.join(result.destinationPath, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { generated: Array<{ relativePath: string }> };
    manifest.generated[0]!.relativePath = '../outside.jpg';
    await writeFile(manifestPath, JSON.stringify(manifest));

    await expect(service.verify(result.destinationPath)).rejects.toThrow('BACKUP_MANIFEST_PATH_INVALID');
    context.database.close();
  });

  it('rejects an inventory that omits a managed result from the catalog', async () => {
    const context = await fixture();
    const resultId = randomUUID();
    const managedPath = path.join(context.generated, resultId, 'result.jpg');
    await mkdir(path.dirname(managedPath), { recursive: true });
    await writeFile(managedPath, 'managed-result');
    context.database.prepare('INSERT INTO generation_results VALUES (?, ?, ?)').run(resultId, managedPath, 'managed');
    const service = new LibraryBackupService(context.databasePath, context.generated);
    const result = await service.create(context.destination, 46);
    const manifestPath = path.join(result.destinationPath, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { generated: unknown[] };
    manifest.generated = [];
    await writeFile(manifestPath, JSON.stringify(manifest));

    await expect(service.verify(result.destinationPath)).rejects.toThrow('BACKUP_CATALOG_RESULTS_MISSING');
    context.database.close();
  });

  it('rejects destinations inside the live library and publishes no partial bundle', async () => {
    const context = await fixture();
    const service = new LibraryBackupService(context.databasePath, context.generated);
    await expect(service.create(context.library)).rejects.toThrow('BACKUP_DESTINATION_INSIDE_LIBRARY');
    expect((await readdir(context.library)).filter((name) => name.startsWith('PhotoAllIsAI-library-'))).toEqual([]);
    context.database.close();
  });

  it('backs up an empty library before the managed results directory exists', async () => {
    const context = await fixture();
    await rm(context.generated, { recursive: true });
    const service = new LibraryBackupService(context.databasePath, context.generated);

    const result = await service.create(context.destination, 43);

    const manifest = JSON.parse(await readFile(path.join(result.destinationPath, 'manifest.json'), 'utf8')) as { generated: unknown[] };
    expect(result.generatedFiles).toBe(0);
    expect(manifest.generated).toEqual([]);
    context.database.close();
  });

  it('cleans up the temporary bundle when a referenced result is missing', async () => {
    const context = await fixture();
    context.database.prepare('INSERT INTO generation_results VALUES (?, ?, ?)').run(randomUUID(), path.join(context.generated, 'missing.jpg'), 'managed');
    const service = new LibraryBackupService(context.databasePath, context.generated);
    await expect(service.create(context.destination, 42)).rejects.toThrow();
    expect(await readdir(context.destination)).toEqual([]);
    expect((await stat(context.databasePath)).isFile()).toBe(true);
    context.database.close();
  });
});
