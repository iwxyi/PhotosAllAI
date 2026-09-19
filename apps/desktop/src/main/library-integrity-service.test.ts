import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it } from 'vitest';

import { LibraryIntegrityService } from './library-integrity-service';

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'photoallisai-integrity-'));
  roots.push(root);
  const library = path.join(root, 'library');
  const generated = path.join(library, 'generated');
  const trash = path.join(library, 'trash', 'generation');
  const portable = path.join(root, 'project', '_PhotoAllIsAI');
  await Promise.all([mkdir(generated, { recursive: true }), mkdir(trash, { recursive: true }), mkdir(portable, { recursive: true })]);
  const databasePath = path.join(library, 'catalog.sqlite');
  const database = new DatabaseSync(databasePath);
  database.exec(`
    CREATE TABLE generation_results (
      id TEXT PRIMARY KEY,
      file_name TEXT NOT NULL,
      file_path TEXT NOT NULL,
      storage_mode TEXT NOT NULL,
      trashed_at INTEGER,
      trash_path TEXT
    )
  `);
  return { root, library, generated, trash, portable, databasePath, database };
}

describe('library storage integrity diagnostics', () => {
  it('reports a healthy mix of managed, portable, and recycled generation results', async () => {
    const context = await fixture();
    const managedPath = path.join(context.generated, 'aa', 'active.jpg');
    const portablePath = path.join(context.portable, 'portable.jpg');
    const trashPath = path.join(context.trash, 'trash-id', 'trashed.jpg');
    await Promise.all([mkdir(path.dirname(managedPath), { recursive: true }), mkdir(path.dirname(trashPath), { recursive: true })]);
    await Promise.all([writeFile(managedPath, 'managed'), writeFile(portablePath, 'portable'), writeFile(trashPath, 'trashed'), writeFile(path.join(path.dirname(managedPath), 'manifest.json'), '{}')]);
    const insert = context.database.prepare('INSERT INTO generation_results VALUES (?, ?, ?, ?, ?, ?)');
    insert.run('managed-id', 'active.jpg', managedPath, 'managed', null, null);
    insert.run('portable-id', 'portable.jpg', portablePath, 'portable', null, null);
    insert.run('trash-id', 'trashed.jpg', path.join(context.generated, 'old.jpg'), 'managed', Date.now(), trashPath);
    const service = new LibraryIntegrityService(context.databasePath, context.generated);

    const report = await service.scan();

    expect(report).toMatchObject({
      status: 'healthy', databaseStatus: 'ok', activeGenerationResults: 2, trashedGenerationResults: 1,
      missingActiveFiles: 0, missingTrashFiles: 0, unsafeManagedPaths: 0, unsafeTrashPaths: 0,
      nonRegularFiles: 0, inaccessibleFiles: 0, unexpectedGeneratedFiles: 0, unexpectedTrashFiles: 0
    });
    expect(JSON.stringify(report)).not.toContain(context.root);
    context.database.close();
  });

  it('detects missing, unsafe, non-regular, and untracked payloads without following links', async () => {
    const context = await fixture();
    const outsidePath = path.join(context.root, 'outside.jpg');
    const linkedPath = path.join(context.generated, 'linked.jpg');
    const orphanPath = path.join(context.generated, 'orphan.jpg');
    const orphanTrashPath = path.join(context.trash, 'orphan-id', 'orphan.jpg');
    await Promise.all([writeFile(outsidePath, 'outside'), writeFile(orphanPath, 'orphan'), mkdir(path.dirname(orphanTrashPath), { recursive: true })]);
    await Promise.all([symlink(outsidePath, linkedPath), writeFile(orphanTrashPath, 'orphan-trash')]);
    const insert = context.database.prepare('INSERT INTO generation_results VALUES (?, ?, ?, ?, ?, ?)');
    insert.run('missing-id', 'missing.jpg', path.join(context.generated, 'missing.jpg'), 'managed', null, null);
    insert.run('unsafe-id', 'outside.jpg', outsidePath, 'managed', null, null);
    insert.run('linked-id', 'linked.jpg', linkedPath, 'managed', null, null);
    insert.run('trash-id', 'missing-trash.jpg', path.join(context.generated, 'old.jpg'), 'managed', Date.now(), path.join(context.trash, 'trash-id', 'missing-trash.jpg'));
    insert.run('unsafe-trash-id', 'unsafe.jpg', path.join(context.generated, 'old-2.jpg'), 'managed', Date.now(), outsidePath);
    const service = new LibraryIntegrityService(context.databasePath, context.generated);

    const report = await service.scan();

    expect(report).toMatchObject({
      status: 'error', databaseStatus: 'ok', activeGenerationResults: 3, trashedGenerationResults: 2,
      missingActiveFiles: 1, missingTrashFiles: 1, unsafeManagedPaths: 1, unsafeTrashPaths: 1,
      nonRegularFiles: 1, unexpectedGeneratedFiles: 1, unexpectedTrashFiles: 1
    });
    context.database.close();
  });

  it('reports an unreadable catalog without creating it', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'photoallisai-integrity-missing-'));
    roots.push(root);
    const service = new LibraryIntegrityService(path.join(root, 'missing.sqlite'), path.join(root, 'generated'));
    await expect(service.scan()).resolves.toMatchObject({ status: 'error', databaseStatus: 'unreadable' });
  });
});
