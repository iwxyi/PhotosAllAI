import { randomUUID } from 'node:crypto';
import { copyFile, link, mkdtemp, mkdir, readFile, readdir, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it } from 'vitest';

import { CatalogService } from './catalog-service';
import { FileOperationService } from './file-operation-service';
import { TaskService } from './task-service';

const services: Array<{ close(): void }> = [];

afterEach(() => {
  while (services.length > 0) services.pop()?.close();
});

async function fixture(fileNames = ['photo.jpg']) {
  const root = await mkdtemp(path.join(tmpdir(), 'photoallisai-file-operations-'));
  const sourceLink = path.join(root, 'source');
  const targetLink = path.join(root, 'target');
  await Promise.all([mkdir(sourceLink), mkdir(targetLink)]);
  const [source, target] = await Promise.all([realpath(sourceLink), realpath(targetLink)]);
  for (const fileName of fileNames) await writeFile(path.join(source, fileName), `content:${fileName}`);
  const databasePath = path.join(root, 'catalog.sqlite');
  const catalog = new CatalogService(databasePath);
  services.push(catalog);
  await catalog.importFolders([source, target]);
  const targetFolderId = catalog.listFolders().find((folder) => folder.name === 'target')!.id;
  return { root, source, target, databasePath, catalog, targetFolderId };
}

describe('safe catalog file moves', () => {
  it('previews RAW, JPEG, and XMP companions but leaves them untouched by default', async () => {
    const context = await fixture(['capture.NEF', 'capture.jpg', 'capture.xmp']);
    const raw = context.catalog.listAssets().find((asset) => asset.fileName === 'capture.NEF')!;
    const service = new FileOperationService(context.databasePath);
    services.push(service);

    await expect(service.previewCompanions([raw.id])).resolves.toMatchObject({
      files: [
        { fileName: 'capture.jpg', kind: 'jpeg' },
        { fileName: 'capture.xmp', kind: 'xmp', assetId: null }
      ]
    });
    await service.move({ assetIds: [raw.id], targetFolderId: context.targetFolderId });

    expect((await readdir(context.source)).sort()).toEqual(['capture.jpg', 'capture.xmp']);
    expect(await readdir(context.target)).toEqual(['capture.NEF']);
  });

  it('moves an opted-in RAW, JPEG, and XMP group in one recoverable operation', async () => {
    const context = await fixture(['capture.NEF', 'capture.jpg', 'capture.xmp']);
    const assets = context.catalog.listAssets();
    const raw = assets.find((asset) => asset.fileName === 'capture.NEF')!;
    const ids = new Map(assets.map((asset) => [asset.fileName, asset.id]));
    const service = new FileOperationService(context.databasePath);
    services.push(service);

    const report = await service.move({ assetIds: [raw.id], targetFolderId: context.targetFolderId, includeCompanions: true });

    expect(report).toMatchObject({ status: 'completed', moved: 2, total: 2 });
    expect((await readdir(context.target)).sort()).toEqual(['capture.NEF', 'capture.jpg', 'capture.xmp']);
    expect(await readdir(context.source)).toEqual([]);
    expect(context.catalog.resolveAssetFile(ids.get('capture.NEF')!)?.path).toBe(path.join(context.target, 'capture.NEF'));
    expect(context.catalog.resolveAssetFile(ids.get('capture.jpg')!)?.path).toBe(path.join(context.target, 'capture.jpg'));
    expect(service.listHistory()[0]).toMatchObject({ total: 2, succeeded: 2, failed: 0 });
    expect(service.listHistory()[0]?.fileNames.sort()).toEqual(['capture.NEF', 'capture.jpg']);
  });

  it('undoes a completed RAW, JPEG, and XMP move as one transaction', async () => {
    const context = await fixture(['capture.NEF', 'capture.jpg', 'capture.xmp']);
    const assets = context.catalog.listAssets();
    const raw = assets.find((asset) => asset.fileName === 'capture.NEF')!;
    const service = new FileOperationService(context.databasePath);
    services.push(service);
    const moved = await service.move({ assetIds: [raw.id], targetFolderId: context.targetFolderId, includeCompanions: true });

    expect(service.listHistory()[0]?.undoable).toBe(true);
    const report = await service.undo({ operationId: moved.operationId });

    expect(report).toMatchObject({ status: 'completed', total: 2, undone: 2, rolledBack: false });
    expect((await readdir(context.source)).sort()).toEqual(['capture.NEF', 'capture.jpg', 'capture.xmp']);
    expect(await readdir(context.target)).toEqual([]);
    for (const asset of assets) {
      expect(context.catalog.resolveAssetFile(asset.id)?.path).toBe(path.join(context.source, asset.fileName));
    }
    expect(service.listHistory()[0]).toMatchObject({ status: 'undone', succeeded: 2, undoable: false });
  });

  it('refuses undo when the original source path has been occupied', async () => {
    const context = await fixture();
    const asset = context.catalog.listAssets()[0]!;
    const service = new FileOperationService(context.databasePath);
    services.push(service);
    const moved = await service.move({ assetIds: [asset.id], targetFolderId: context.targetFolderId });
    await writeFile(path.join(context.source, 'photo.jpg'), 'new-source-file');

    await expect(service.undo({ operationId: moved.operationId })).rejects.toThrow('UNDO_SOURCE_CONFLICT');

    expect(await readFile(path.join(context.source, 'photo.jpg'), 'utf8')).toBe('new-source-file');
    expect(await readFile(path.join(context.target, 'photo.jpg'), 'utf8')).toBe('content:photo.jpg');
    expect(context.catalog.resolveAssetFile(asset.id)?.path).toBe(path.join(context.target, 'photo.jpg'));
  });

  it('restores the moved group when a later undo item fails', async () => {
    const context = await fixture(['capture.NEF', 'capture.jpg', 'capture.xmp']);
    const raw = context.catalog.listAssets().find((asset) => asset.fileName === 'capture.NEF')!;
    const bootstrap = new FileOperationService(context.databasePath);
    const moved = await bootstrap.move({ assetIds: [raw.id], targetFolderId: context.targetFolderId, includeCompanions: true });
    bootstrap.close();
    const service = new FileOperationService(context.databasePath, {
      copyFile, readdir, realpath, stat, unlink,
      link: async (source, destination) => {
        if (String(source).endsWith(`${path.sep}capture.NEF`) && String(source).startsWith(context.target)) {
          throw Object.assign(new Error('denied'), { code: 'EACCES' });
        }
        await link(source, destination);
      }
    });
    services.push(service);

    const report = await service.undo({ operationId: moved.operationId });

    expect(report).toMatchObject({ status: 'failed', undone: 0, rolledBack: true, errorCode: 'EACCES' });
    expect(await readdir(context.source)).toEqual([]);
    expect((await readdir(context.target)).sort()).toEqual(['capture.NEF', 'capture.jpg', 'capture.xmp']);
    expect(context.catalog.resolveAssetFile(raw.id)?.path).toBe(path.join(context.target, 'capture.NEF'));
    expect(service.listHistory()[0]).toMatchObject({ status: 'completed', undoable: true });
  });

  it('uses one conflict suffix for every file in an associated camera group', async () => {
    const context = await fixture(['capture.NEF', 'capture.jpg', 'capture.xmp']);
    await writeFile(path.join(context.target, 'capture.jpg'), 'existing-target');
    const raw = context.catalog.listAssets().find((asset) => asset.fileName === 'capture.NEF')!;
    const service = new FileOperationService(context.databasePath);
    services.push(service);

    const report = await service.move({ assetIds: [raw.id], targetFolderId: context.targetFolderId, includeCompanions: true });

    expect(report.files.map((file) => file.fileName).sort()).toEqual(['capture (1).NEF', 'capture (1).jpg']);
    expect((await readdir(context.target)).sort()).toEqual([
      'capture (1).NEF', 'capture (1).jpg', 'capture (1).xmp', 'capture.jpg'
    ]);
    expect(await readFile(path.join(context.target, 'capture.jpg'), 'utf8')).toBe('existing-target');
  });

  it('rolls back RAW and JPEG files when an associated XMP move fails', async () => {
    const context = await fixture(['capture.NEF', 'capture.jpg', 'capture.xmp']);
    const assets = context.catalog.listAssets();
    const raw = assets.find((asset) => asset.fileName === 'capture.NEF')!;
    const originalPaths = new Map(assets.map((asset) => [asset.id, path.join(context.source, asset.fileName)]));
    const service = new FileOperationService(context.databasePath, {
      copyFile, readdir, realpath, stat, unlink,
      link: async (source, destination) => {
        if (String(source).endsWith(`${path.sep}capture.xmp`) && String(destination).startsWith(context.target)) {
          throw Object.assign(new Error('denied'), { code: 'EACCES' });
        }
        await link(source, destination);
      }
    });
    services.push(service);

    const report = await service.move({ assetIds: [raw.id], targetFolderId: context.targetFolderId, includeCompanions: true });

    expect(report).toMatchObject({ status: 'failed', moved: 0, rolledBack: true, errorCode: 'EACCES' });
    expect((await readdir(context.source)).sort()).toEqual(['capture.NEF', 'capture.jpg', 'capture.xmp']);
    expect(await readdir(context.target)).toEqual([]);
    expect(assets.map((asset) => context.catalog.resolveAssetFile(asset.id)?.path).sort())
      .toEqual([...originalPaths.values()].sort());
  });

  it('rejects a cross-volume move before writing when free space is insufficient', async () => {
    const context = await fixture();
    const asset = context.catalog.listAssets()[0]!;
    const service = new FileOperationService(context.databasePath, {
      copyFile, link, readdir, realpath, rename, stat: (async (filePath) => {
        const stats = await stat(filePath);
        return String(filePath) === context.target ? Object.assign(stats, { dev: stats.dev + 1 }) : stats;
      }) as typeof stat, unlink,
      availableBytes: async () => asset.sizeBytes - 1
    });
    services.push(service);

    await expect(service.move({ assetIds: [asset.id], targetFolderId: context.targetFolderId }))
      .rejects.toThrow('INSUFFICIENT_DISK_SPACE');
    expect(await readFile(path.join(context.source, 'photo.jpg'), 'utf8')).toBe('content:photo.jpg');
    expect(await readdir(context.target)).toEqual([]);
    expect(service.listHistory()).toEqual([]);
  });

  it('moves a file on the same volume and commits its catalog location', async () => {
    const context = await fixture();
    const asset = context.catalog.listAssets()[0]!;
    const service = new FileOperationService(context.databasePath);
    services.push(service);

    const report = await service.move({ assetIds: [asset.id], targetFolderId: context.targetFolderId });

    expect(report).toMatchObject({ status: 'completed', moved: 1, skipped: 0, rolledBack: false });
    expect(await readFile(path.join(context.target, 'photo.jpg'), 'utf8')).toBe('content:photo.jpg');
    await expect(stat(path.join(context.source, 'photo.jpg'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(context.catalog.resolveAssetFile(asset.id)?.path).toBe(path.join(context.target, 'photo.jpg'));
  });

  it('moves and copies into a created child directory without changing the root catalog owner', async () => {
    const context = await fixture(['move.jpg', 'copy.jpg']);
    const child = (await context.catalog.createFolder({ parentFolderId: context.targetFolderId })).folder;
    const service = new FileOperationService(context.databasePath, undefined, null, process.platform, context.catalog);
    services.push(service);
    const assets = context.catalog.listAssets();
    const moved = await service.move({ assetIds: [assets.find((asset) => asset.fileName === 'move.jpg')!.id], targetFolderId: child.id });
    expect(moved).toMatchObject({ status: 'completed', moved: 1, skipped: 0 });
    expect(context.catalog.resolveAssetFile(assets.find((asset) => asset.fileName === 'move.jpg')!.id)?.path).toBe(path.join(context.target, child.name, 'move.jpg'));
    expect(context.catalog.listAssets().find((asset) => asset.fileName === 'move.jpg')).toMatchObject({ directoryId: child.id, folderId: context.targetFolderId });
    const repeated = await service.move({ assetIds: [assets.find((asset) => asset.fileName === 'move.jpg')!.id], targetFolderId: child.id });
    expect(repeated).toMatchObject({ status: 'completed', moved: 0, skipped: 1 });
    const copied = await service.copy({ assetIds: [assets.find((asset) => asset.fileName === 'copy.jpg')!.id], targetFolderId: child.id });
    expect(copied).toMatchObject({ status: 'completed', copied: 1 });
    expect(await readFile(path.join(context.target, child.name, 'copy.jpg'), 'utf8')).toBe('content:copy.jpg');
    expect(await readFile(path.join(context.source, 'copy.jpg'), 'utf8')).toBe('content:copy.jpg');
  });

  it('reserves deterministic conflict names without overwriting destination files', async () => {
    const context = await fixture();
    await writeFile(path.join(context.target, 'photo.jpg'), 'keep-me');
    await writeFile(path.join(context.target, 'photo (1).jpg'), 'keep-me-too');
    const asset = context.catalog.listAssets()[0]!;
    const service = new FileOperationService(context.databasePath);
    services.push(service);

    const report = await service.move({ assetIds: [asset.id], targetFolderId: context.targetFolderId });

    expect(report.files[0]).toMatchObject({ previousFileName: 'photo.jpg', fileName: 'photo (2).jpg' });
    expect(await readFile(path.join(context.target, 'photo.jpg'), 'utf8')).toBe('keep-me');
    expect(await readFile(path.join(context.target, 'photo (2).jpg'), 'utf8')).toBe('content:photo.jpg');
  });

  it('does not overwrite a destination created after planning', async () => {
    const context = await fixture();
    const asset = context.catalog.listAssets()[0]!;
    let raced = false;
    const service = new FileOperationService(context.databasePath, {
      copyFile, readdir, realpath, stat, unlink,
      link: async (source, destination) => {
        if (!raced) {
          raced = true;
          await writeFile(String(destination), 'late-arrival');
        }
        await link(source, destination);
      }
    });
    services.push(service);

    const report = await service.move({ assetIds: [asset.id], targetFolderId: context.targetFolderId });

    expect(report).toMatchObject({ status: 'failed', moved: 0, rolledBack: true, errorCode: 'EEXIST' });
    expect(await readFile(path.join(context.target, 'photo.jpg'), 'utf8')).toBe('late-arrival');
    expect(await readFile(path.join(context.source, 'photo.jpg'), 'utf8')).toBe('content:photo.jpg');
  });

  it('falls back to verified copy and publish when linking reports EXDEV', async () => {
    const context = await fixture();
    const asset = context.catalog.listAssets()[0]!;
    let injected = false;
    const service = new FileOperationService(context.databasePath, {
      copyFile, readdir, realpath, stat, unlink,
      link: async (source, destination) => {
        if (!injected && String(source) === path.join(context.source, 'photo.jpg')) {
          injected = true;
          throw Object.assign(new Error('cross device'), { code: 'EXDEV' });
        }
        await link(source, destination);
      }
    });
    services.push(service);

    const report = await service.move({ assetIds: [asset.id], targetFolderId: context.targetFolderId });

    expect(report.status).toBe('completed');
    expect(injected).toBe(true);
    expect(await readFile(path.join(context.target, 'photo.jpg'), 'utf8')).toBe('content:photo.jpg');
    expect((await readdir(context.target)).some((name) => name.startsWith('.photoallisai-'))).toBe(false);
  });

  it('uses a verified no-clobber copy when the destination does not support hard links', async () => {
    const context = await fixture();
    const asset = context.catalog.listAssets()[0]!;
    const service = new FileOperationService(context.databasePath, {
      copyFile, readdir, realpath, stat, unlink,
      link: async () => { throw Object.assign(new Error('unsupported'), { code: 'ENOTSUP' }); }
    });
    services.push(service);

    const report = await service.move({ assetIds: [asset.id], targetFolderId: context.targetFolderId });

    expect(report.status).toBe('completed');
    expect(await readFile(path.join(context.target, 'photo.jpg'), 'utf8')).toBe('content:photo.jpg');
    await expect(stat(path.join(context.source, 'photo.jpg'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('preserves a source modified during cross-volume copy and removes the stale destination', async () => {
    const context = await fixture();
    const asset = context.catalog.listAssets()[0]!;
    let linkAttempt = 0;
    const service = new FileOperationService(context.databasePath, {
      copyFile, readdir, realpath, stat, unlink,
      link: async (source, destination) => {
        linkAttempt += 1;
        if (linkAttempt === 1) throw Object.assign(new Error('cross device'), { code: 'EXDEV' });
        await writeFile(path.join(context.source, 'photo.jpg'), 'new-content-written-during-copy');
        await link(source, destination);
      }
    });
    services.push(service);

    const report = await service.move({ assetIds: [asset.id], targetFolderId: context.targetFolderId });

    expect(report).toMatchObject({ status: 'failed', errorCode: 'FILE_CHANGED_DURING_COPY', rolledBack: true });
    expect(await readFile(path.join(context.source, 'photo.jpg'), 'utf8')).toBe('new-content-written-during-copy');
    expect(await readdir(context.target)).toEqual([]);
  });

  it('reports a permission failure without changing files or catalog state', async () => {
    const context = await fixture();
    const asset = context.catalog.listAssets()[0]!;
    const service = new FileOperationService(context.databasePath, {
      copyFile, readdir, realpath, stat, unlink,
      link: async () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); }
    });
    services.push(service);

    const report = await service.move({ assetIds: [asset.id], targetFolderId: context.targetFolderId });

    expect(report).toMatchObject({ status: 'failed', moved: 0, rolledBack: true, errorCode: 'EACCES' });
    expect(await readFile(path.join(context.source, 'photo.jpg'), 'utf8')).toBe('content:photo.jpg');
    expect(context.catalog.resolveAssetFile(asset.id)?.path).toBe(path.join(context.source, 'photo.jpg'));
  });

  it('compensates completed items in reverse when a later batch item fails', async () => {
    const context = await fixture(['a.jpg', 'b.jpg']);
    const assets = context.catalog.listAssets().sort((left, right) => left.fileName.localeCompare(right.fileName));
    const service = new FileOperationService(context.databasePath, {
      copyFile, readdir, realpath, stat, unlink,
      link: async (source, destination) => {
        if (String(source).endsWith(`${path.sep}b.jpg`) && String(destination).startsWith(context.target)) {
          throw Object.assign(new Error('denied'), { code: 'EACCES' });
        }
        await link(source, destination);
      }
    });
    services.push(service);

    const report = await service.move({ assetIds: assets.map((asset) => asset.id), targetFolderId: context.targetFolderId });

    expect(report).toMatchObject({ status: 'failed', moved: 0, rolledBack: true, errorCode: 'EACCES' });
    expect(await Promise.all(['a.jpg', 'b.jpg'].map((name) => readFile(path.join(context.source, name), 'utf8'))))
      .toEqual(['content:a.jpg', 'content:b.jpg']);
    expect(await readdir(context.target)).toEqual([]);
    expect(assets.map((asset) => context.catalog.resolveAssetFile(asset.id)?.path).sort())
      .toEqual(assets.map((asset) => path.join(context.source, asset.fileName)).sort());
  });

  it('recovers a filesystem move interrupted before catalog commit', async () => {
    const context = await fixture();
    const asset = context.catalog.listAssets()[0]!;
    const bootstrap = new FileOperationService(context.databasePath);
    bootstrap.close();
    const sourcePath = path.join(context.source, 'photo.jpg');
    const destinationPath = path.join(context.target, 'photo.jpg');
    await rename(sourcePath, destinationPath);
    const operationId = randomUUID();
    const itemId = randomUUID();
    const database = new DatabaseSync(context.databasePath);
    database.prepare(`INSERT INTO file_operations (id, kind, status, target_folder_id, created_at) VALUES (?, 'move', 'executing', ?, ?)`)
      .run(operationId, context.targetFolderId, Date.now());
    database.prepare(`
      INSERT INTO file_operation_items (
        id, operation_id, ordinal, asset_id, source_folder_id, destination_folder_id,
        source_path, destination_path, temporary_path, original_file_name,
        destination_file_name, size_bytes, status
      ) VALUES (?, ?, 0, ?, ?, ?, ?, ?, ?, 'photo.jpg', 'photo.jpg', ?, 'moving')
    `).run(
      itemId, operationId, asset.id, asset.folderId, context.targetFolderId,
      sourcePath, destinationPath, path.join(context.target, '.recovery.tmp'), asset.sizeBytes
    );
    database.close();
    const service = new FileOperationService(context.databasePath);
    services.push(service);

    expect(await service.recoverInterruptedOperations()).toEqual({ total: 1, resolved: 1, failed: 0 });
    expect(await readFile(sourcePath, 'utf8')).toBe('content:photo.jpg');
    await expect(stat(destinationPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(context.catalog.resolveAssetFile(asset.id)?.path).toBe(sourcePath);
  });

  it('reports an unresolved recovery conflict without deleting either file', async () => {
    const context = await fixture();
    const asset = context.catalog.listAssets()[0]!;
    const bootstrap = new FileOperationService(context.databasePath);
    bootstrap.close();
    const sourcePath = path.join(context.source, 'photo.jpg');
    const destinationPath = path.join(context.target, 'photo.jpg');
    await writeFile(destinationPath, 'conflicting-content');
    const operationId = randomUUID();
    const database = new DatabaseSync(context.databasePath);
    database.prepare(`INSERT INTO file_operations (id, kind, status, target_folder_id, created_at) VALUES (?, 'move', 'executing', ?, ?)`)
      .run(operationId, context.targetFolderId, Date.now());
    database.prepare(`
      INSERT INTO file_operation_items (
        id, operation_id, ordinal, asset_id, source_folder_id, destination_folder_id,
        source_path, destination_path, temporary_path, original_file_name,
        destination_file_name, size_bytes, status
      ) VALUES (?, ?, 0, ?, ?, ?, ?, ?, ?, 'photo.jpg', 'photo.jpg', ?, 'moving')
    `).run(
      randomUUID(), operationId, asset.id, asset.folderId, context.targetFolderId,
      sourcePath, destinationPath, path.join(context.target, '.recovery-conflict.tmp'), asset.sizeBytes
    );
    database.close();
    const service = new FileOperationService(context.databasePath);
    services.push(service);

    expect(await service.recoverInterruptedOperations()).toEqual({ total: 1, resolved: 0, failed: 1 });
    expect(await readFile(sourcePath, 'utf8')).toBe('content:photo.jpg');
    expect(await readFile(destinationPath, 'utf8')).toBe('conflicting-content');
    expect(service.listHistory()[0]).toMatchObject({ status: 'compensation_failed', errorCode: 'RECOVERY_FAILED' });
  });

  it('recovers an interrupted non-catalog XMP move from the persisted operation log', async () => {
    const context = await fixture(['capture.NEF', 'capture.xmp']);
    const asset = context.catalog.listAssets()[0]!;
    const bootstrap = new FileOperationService(context.databasePath);
    bootstrap.close();
    const sourcePath = path.join(context.source, 'capture.xmp');
    const destinationPath = path.join(context.target, 'capture.xmp');
    await rename(sourcePath, destinationPath);
    const operationId = randomUUID();
    const database = new DatabaseSync(context.databasePath);
    database.prepare(`INSERT INTO file_operations (id, kind, status, target_folder_id, created_at) VALUES (?, 'move', 'executing', ?, ?)`)
      .run(operationId, context.targetFolderId, Date.now());
    database.prepare(`
      INSERT INTO file_operation_items (
        id, operation_id, ordinal, asset_id, source_folder_id, destination_folder_id,
        source_path, destination_path, temporary_path, original_file_name,
        destination_file_name, size_bytes, status, catalog_managed
      ) VALUES (?, ?, 0, ?, ?, ?, ?, ?, ?, 'capture.xmp', 'capture.xmp', ?, 'moved', 0)
    `).run(
      randomUUID(), operationId, `sidecar:${randomUUID()}`, asset.folderId, context.targetFolderId,
      sourcePath, destinationPath, path.join(context.target, '.xmp-recovery.tmp'), Buffer.byteLength('content:capture.xmp')
    );
    database.close();
    const service = new FileOperationService(context.databasePath);
    services.push(service);

    expect(await service.recoverInterruptedOperations()).toEqual({ total: 1, resolved: 1, failed: 0 });
    expect(await readFile(sourcePath, 'utf8')).toBe('content:capture.xmp');
    await expect(stat(destinationPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(context.catalog.resolveAssetFile(asset.id)?.path).toBe(path.join(context.source, 'capture.NEF'));
  });

  it('finishes an interrupted undo and reports catalog location changes', async () => {
    const context = await fixture();
    const asset = context.catalog.listAssets()[0]!;
    const bootstrap = new FileOperationService(context.databasePath);
    const moved = await bootstrap.move({ assetIds: [asset.id], targetFolderId: context.targetFolderId });
    bootstrap.close();
    await rename(path.join(context.target, 'photo.jpg'), path.join(context.source, 'photo.jpg'));
    const database = new DatabaseSync(context.databasePath);
    database.prepare("UPDATE file_operations SET status = 'undoing', completed_at = NULL WHERE id = ?").run(moved.operationId);
    database.prepare("UPDATE file_operation_items SET status = 'undone' WHERE operation_id = ?").run(moved.operationId);
    database.close();
    const service = new FileOperationService(context.databasePath);
    services.push(service);
    const changes: Array<{ assetId: string; previousPath: string; path: string }> = [];

    expect(await service.recoverInterruptedOperations(async (change) => { changes.push(change); })).toEqual({ total: 1, resolved: 1, failed: 0 });

    expect(context.catalog.resolveAssetFile(asset.id)?.path).toBe(path.join(context.source, 'photo.jpg'));
    expect(changes).toEqual([{
      assetId: asset.id,
      previousPath: path.join(context.target, 'photo.jpg'),
      path: path.join(context.source, 'photo.jpg'),
      previousFileName: 'photo.jpg',
      fileName: 'photo.jpg'
    }]);
    expect(service.listHistory()[0]).toMatchObject({ status: 'undone', undoable: false });
  });

  it('does not touch managed generation content while moving an original', async () => {
    const context = await fixture();
    const generated = path.join(context.root, 'library-generated', 'result.png');
    await mkdir(path.dirname(generated));
    await writeFile(generated, 'generated-version');
    const asset = context.catalog.listAssets()[0]!;
    const service = new FileOperationService(context.databasePath);
    services.push(service);

    await service.move({ assetIds: [asset.id], targetFolderId: context.targetFolderId });

    expect(await readFile(generated, 'utf8')).toBe('generated-version');
  });
});

describe('catalog copies and renames', () => {
  it('copies an opted-in RAW, JPEG, and XMP group while preserving the originals', async () => {
    const context = await fixture(['capture.NEF', 'capture.jpg', 'capture.xmp']);
    const raw = context.catalog.listAssets().find((asset) => asset.fileName === 'capture.NEF')!;
    const service = new FileOperationService(context.databasePath);
    services.push(service);

    const report = await service.copy({ assetIds: [raw.id], targetFolderId: context.targetFolderId, includeCompanions: true });

    expect(report).toMatchObject({ status: 'completed', copied: 2, total: 2 });
    expect((await readdir(context.source)).sort()).toEqual(['capture.NEF', 'capture.jpg', 'capture.xmp']);
    expect((await readdir(context.target)).sort()).toEqual(['capture.NEF', 'capture.jpg', 'capture.xmp']);
    expect(context.catalog.listAssets()).toHaveLength(4);
  });

  it('rejects Windows destination paths that exceed the compatibility limit', async () => {
    const context = await fixture();
    const asset = context.catalog.listAssets()[0]!;
    const longDirectory = path.join(context.root, 'x'.repeat(210));
    await mkdir(longDirectory);
    const database = new DatabaseSync(context.databasePath);
    database.prepare('UPDATE folders SET path = ? WHERE id = ?').run(longDirectory, context.targetFolderId);
    database.close();
    const service = new FileOperationService(context.databasePath, undefined, null, 'win32');
    services.push(service);

    await expect(service.copy({ assetIds: [asset.id], targetFolderId: context.targetFolderId }))
      .rejects.toThrow('DESTINATION_PATH_TOO_LONG');
    expect(await readdir(longDirectory)).toEqual([]);
    expect(service.listHistory()).toEqual([]);
  });

  it('rejects a copy before writing when aggregate free space is insufficient', async () => {
    const context = await fixture(['a.jpg', 'b.jpg']);
    const assets = context.catalog.listAssets();
    const requiredBytes = assets.reduce((total, asset) => total + asset.sizeBytes, 0);
    const service = new FileOperationService(context.databasePath, {
      copyFile, link, readdir, realpath, rename, stat, unlink,
      availableBytes: async () => requiredBytes - 1
    });
    services.push(service);

    await expect(service.copy({ assetIds: assets.map((asset) => asset.id), targetFolderId: context.targetFolderId }))
      .rejects.toThrow('INSUFFICIENT_DISK_SPACE');
    expect(await readdir(context.target)).toEqual([]);
    expect(service.listHistory()).toEqual([]);
  });

  it('creates an independent asset copy with user metadata but no shared inode', async () => {
    const context = await fixture();
    const asset = context.catalog.listAssets()[0]!;
    context.catalog.updateMetadata({ assetIds: [asset.id], rating: 5, favorite: true });
    context.catalog.updateTags({ assetIds: [asset.id], addTags: ['交付'], removeTagIds: [] });
    const service = new FileOperationService(context.databasePath);
    services.push(service);

    const report = await service.copy({ assetIds: [asset.id], targetFolderId: context.targetFolderId });

    expect(report).toMatchObject({ status: 'completed', copied: 1, rolledBack: false });
    const copied = context.catalog.listAssets().find((item) => item.id === report.files[0]?.assetId);
    expect(copied).toMatchObject({ folderId: context.targetFolderId, fileName: 'photo.jpg', rating: 5, favorite: true });
    expect(copied?.tags.map((tag) => tag.name)).toEqual(['交付']);
    expect(await readFile(path.join(context.source, 'photo.jpg'), 'utf8')).toBe('content:photo.jpg');
    expect(await readFile(path.join(context.target, 'photo.jpg'), 'utf8')).toBe('content:photo.jpg');
    await writeFile(path.join(context.source, 'photo.jpg'), 'source-changed');
    expect(await readFile(path.join(context.target, 'photo.jpg'), 'utf8')).toBe('content:photo.jpg');
  });

  it('copies within one folder using a deterministic conflict suffix', async () => {
    const context = await fixture();
    const asset = context.catalog.listAssets()[0]!;
    const service = new FileOperationService(context.databasePath);
    services.push(service);

    const report = await service.copy({ assetIds: [asset.id], targetFolderId: asset.folderId });

    expect(report.files[0]?.fileName).toBe('photo (1).jpg');
    expect(await readFile(path.join(context.source, 'photo (1).jpg'), 'utf8')).toBe('content:photo.jpg');
  });

  it('removes earlier copies when a later batch item fails', async () => {
    const context = await fixture(['a.jpg', 'b.jpg']);
    const assets = context.catalog.listAssets().sort((left, right) => left.fileName.localeCompare(right.fileName));
    const service = new FileOperationService(context.databasePath, {
      link, readdir, realpath, stat, unlink,
      copyFile: async (source, destination, mode) => {
        if (String(source).endsWith(`${path.sep}b.jpg`)) {
          throw Object.assign(new Error('denied'), { code: 'EACCES' });
        }
        await copyFile(source, destination, mode);
      }
    });
    services.push(service);

    const report = await service.copy({
      assetIds: assets.map((item) => item.id), targetFolderId: context.targetFolderId
    });

    expect(report).toMatchObject({ status: 'failed', copied: 0, rolledBack: true, errorCode: 'EACCES' });
    expect(await readdir(context.target)).toEqual([]);
    expect(context.catalog.listAssets()).toHaveLength(2);
  });

  it('removes a verified copy interrupted before catalog commit', async () => {
    const context = await fixture();
    const asset = context.catalog.listAssets()[0]!;
    const bootstrap = new FileOperationService(context.databasePath);
    bootstrap.close();
    const sourcePath = path.join(context.source, 'photo.jpg');
    const destinationPath = path.join(context.target, 'photo.jpg');
    await copyFile(sourcePath, destinationPath);
    const operationId = randomUUID();
    const itemId = randomUUID();
    const database = new DatabaseSync(context.databasePath);
    database.prepare(`
      INSERT INTO file_operations (id, kind, status, target_folder_id, created_at)
      VALUES (?, 'copy', 'executing', ?, ?)
    `).run(operationId, context.targetFolderId, Date.now());
    database.prepare(`
      INSERT INTO file_operation_items (
        id, operation_id, ordinal, asset_id, source_folder_id, destination_folder_id,
        source_path, destination_path, temporary_path, original_file_name,
        destination_file_name, size_bytes, result_asset_id, status
      ) VALUES (?, ?, 0, ?, ?, ?, ?, ?, ?, 'photo.jpg', 'photo.jpg', ?, ?, 'copying')
    `).run(
      itemId, operationId, asset.id, asset.folderId, context.targetFolderId,
      sourcePath, destinationPath, path.join(context.target, '.copy-recovery.tmp'),
      asset.sizeBytes, randomUUID()
    );
    database.close();
    const service = new FileOperationService(context.databasePath);
    services.push(service);

    expect(await service.recoverInterruptedOperations()).toEqual({ total: 1, resolved: 1, failed: 0 });
    await expect(stat(destinationPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(sourcePath, 'utf8')).toBe('content:photo.jpg');
    expect(context.catalog.listAssets()).toHaveLength(1);
  });

  it('renames an asset without changing its identity', async () => {
    const context = await fixture();
    const asset = context.catalog.listAssets()[0]!;
    const service = new FileOperationService(context.databasePath);
    services.push(service);

    const report = await service.rename({ assetId: asset.id, fileName: 'portrait-final.jpg' });

    expect(report).toMatchObject({ status: 'completed', assetId: asset.id, previousFileName: 'photo.jpg', fileName: 'portrait-final.jpg' });
    expect(await readFile(path.join(context.source, 'portrait-final.jpg'), 'utf8')).toBe('content:photo.jpg');
    await expect(stat(path.join(context.source, 'photo.jpg'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(context.catalog.resolveAssetFile(asset.id)?.fileName).toBe('portrait-final.jpg');
  });

  it('undoes a rename while preserving the asset identity', async () => {
    const context = await fixture();
    const asset = context.catalog.listAssets()[0]!;
    const service = new FileOperationService(context.databasePath);
    services.push(service);
    const renamed = await service.rename({ assetId: asset.id, fileName: 'portrait-final.jpg' });

    const report = await service.undo({ operationId: renamed.operationId });

    expect(report).toMatchObject({ status: 'completed', undone: 1 });
    expect(await readFile(path.join(context.source, 'photo.jpg'), 'utf8')).toBe('content:photo.jpg');
    await expect(stat(path.join(context.source, 'portrait-final.jpg'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(context.catalog.resolveAssetFile(asset.id)?.fileName).toBe('photo.jpg');
    expect(context.catalog.listAssets()[0]?.id).toBe(asset.id);
  });

  it('undoes a case-only rename using the filesystem rename primitive', async () => {
    const context = await fixture();
    const asset = context.catalog.listAssets()[0]!;
    const service = new FileOperationService(context.databasePath);
    services.push(service);
    const renamed = await service.rename({ assetId: asset.id, fileName: 'PHOTO.jpg' });

    const report = await service.undo({ operationId: renamed.operationId });

    expect(report.status).toBe('completed');
    expect((await readdir(context.source)).filter((name) => normalizeForTest(name) === 'photo.jpg')).toEqual(['photo.jpg']);
    expect(context.catalog.resolveAssetFile(asset.id)?.fileName).toBe('photo.jpg');
  });

  it('supports a case-only rename while preserving the asset id', async () => {
    const context = await fixture();
    const asset = context.catalog.listAssets()[0]!;
    const service = new FileOperationService(context.databasePath);
    services.push(service);

    const report = await service.rename({ assetId: asset.id, fileName: 'PHOTO.jpg' });

    expect(report.status).toBe('completed');
    expect(context.catalog.resolveAssetFile(asset.id)?.fileName).toBe('PHOTO.jpg');
  });

  it('renames a batch serially and reports partial failures', async () => {
    const context = await fixture();
    const asset = context.catalog.listAssets()[0]!;
    const service = new FileOperationService(context.databasePath);
    services.push(service);

    const report = await service.renameMany({ items: [
      { assetId: asset.id, fileName: 'batch-final.jpg' },
      { assetId: asset.id, fileName: 'batch-again.jpg' }
    ] });

    expect(report).toMatchObject({ total: 2, succeeded: 2, failed: 0 });
    expect(context.catalog.resolveAssetFile(asset.id)?.fileName).toBe('batch-again.jpg');
  });

  it('recovers a case-only rename without deleting the shared filesystem entry', async () => {
    const context = await fixture();
    const asset = context.catalog.listAssets()[0]!;
    const bootstrap = new FileOperationService(context.databasePath);
    bootstrap.close();
    const sourcePath = path.join(context.source, 'photo.jpg');
    const destinationPath = path.join(context.source, 'PHOTO.jpg');
    await rename(sourcePath, destinationPath);
    const operationId = randomUUID();
    const itemId = randomUUID();
    const database = new DatabaseSync(context.databasePath);
    database.prepare(`
      INSERT INTO file_operations (id, kind, status, target_folder_id, created_at)
      VALUES (?, 'rename', 'executing', ?, ?)
    `).run(operationId, asset.folderId, Date.now());
    database.prepare(`
      INSERT INTO file_operation_items (
        id, operation_id, ordinal, asset_id, source_folder_id, destination_folder_id,
        source_path, destination_path, temporary_path, original_file_name,
        destination_file_name, size_bytes, status
      ) VALUES (?, ?, 0, ?, ?, ?, ?, ?, ?, 'photo.jpg', 'PHOTO.jpg', ?, 'moving')
    `).run(
      itemId, operationId, asset.id, asset.folderId, asset.folderId,
      sourcePath, destinationPath, path.join(context.source, '.rename-recovery.tmp'), asset.sizeBytes
    );
    database.close();
    const service = new FileOperationService(context.databasePath);
    services.push(service);

    expect(await service.recoverInterruptedOperations()).toEqual({ total: 1, resolved: 1, failed: 0 });
    expect(await readFile(sourcePath, 'utf8')).toBe('content:photo.jpg');
    expect((await readdir(context.source)).filter((name) => normalizeForTest(name) === 'photo.jpg')).toHaveLength(1);
  });

  it('rejects conflicts, extension changes, and platform-invalid names without touching the source', async () => {
    const context = await fixture();
    await writeFile(path.join(context.source, 'existing.jpg'), 'existing');
    const asset = context.catalog.listAssets()[0]!;
    const service = new FileOperationService(context.databasePath);
    services.push(service);

    await expect(service.rename({ assetId: asset.id, fileName: 'existing.jpg' })).rejects.toThrow('EEXIST');
    await expect(service.rename({ assetId: asset.id, fileName: 'photo.png' })).rejects.toThrow('FILE_EXTENSION_CHANGE_NOT_ALLOWED');
    await expect(service.rename({ assetId: asset.id, fileName: 'CON.jpg' })).rejects.toThrow('INVALID_FILE_NAME');
    for (const fileName of ['PRN.jpg', 'AUX.jpg', 'NUL.jpg', 'COM1.jpg', 'LPT9.jpg', 'photo.jpg.', 'photo.jpg ']) {
      await expect(service.rename({ assetId: asset.id, fileName })).rejects.toThrow('INVALID_FILE_NAME');
    }
    await expect(service.rename({ assetId: asset.id, fileName: `${'é'.repeat(130)}.jpg` })).rejects.toThrow('INVALID_FILE_NAME');
    expect(await readFile(path.join(context.source, 'photo.jpg'), 'utf8')).toBe('content:photo.jpg');
  });

  it('upgrades the move-only operation log before executing newer operations', async () => {
    const context = await fixture();
    const database = new DatabaseSync(context.databasePath);
    database.exec(`
      CREATE TABLE file_operations (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('move')), status TEXT NOT NULL,
        target_folder_id TEXT NOT NULL, created_at INTEGER NOT NULL, completed_at INTEGER, error_code TEXT
      );
      CREATE TABLE file_operation_items (
        id TEXT PRIMARY KEY, operation_id TEXT NOT NULL REFERENCES file_operations(id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL, asset_id TEXT NOT NULL, source_folder_id TEXT NOT NULL,
        destination_folder_id TEXT NOT NULL, source_path TEXT NOT NULL, destination_path TEXT NOT NULL,
        temporary_path TEXT NOT NULL, original_file_name TEXT NOT NULL, destination_file_name TEXT NOT NULL,
        size_bytes INTEGER NOT NULL, status TEXT NOT NULL, error_code TEXT, UNIQUE(operation_id, ordinal)
      );
    `);
    database.close();
    const asset = context.catalog.listAssets()[0]!;
    const service = new FileOperationService(context.databasePath);
    services.push(service);

    const report = await service.copy({ assetIds: [asset.id], targetFolderId: context.targetFolderId });

    expect(report.status).toBe('completed');
  });
});

function normalizeForTest(value: string): string {
  return value.normalize('NFC').toLocaleLowerCase('en-US');
}

describe('catalog removal and system trash', () => {
  it('soft-removes an asset while preserving its file and restores the same identity on rescan', async () => {
    const context = await fixture();
    const asset = context.catalog.listAssets()[0]!;
    context.catalog.updateMetadata({ assetIds: [asset.id], rating: 4 });
    context.catalog.updateTags({ assetIds: [asset.id], addTags: ['保留数据'], removeTagIds: [] });
    const service = new FileOperationService(context.databasePath);
    services.push(service);

    const report = await service.removeFromCatalog({ assetIds: [asset.id] });

    expect(report).toMatchObject({ kind: 'remove', status: 'completed', succeeded: 1, failed: 0 });
    expect(context.catalog.listAssets()).toEqual([]);
    expect(context.catalog.resolveAssetFile(asset.id)).toBeNull();
    expect(await readFile(path.join(context.source, 'photo.jpg'), 'utf8')).toBe('content:photo.jpg');

    await context.catalog.importFolders([context.source]);
    const restored = context.catalog.listAssets()[0]!;
    expect(restored).toMatchObject({ id: asset.id, rating: 4 });
    expect(restored.tags.map((tag) => tag.name)).toEqual(['保留数据']);
  });

  it('rejects removal while an AI task for the asset is active', async () => {
    const context = await fixture();
    const asset = context.catalog.listAssets()[0]!;
    const tasks = new TaskService(context.databasePath);
    services.push(tasks);
    tasks.enqueue({
      kind: 'analysis', assetId: asset.id,
      payload: { providerProfileId: randomUUID(), mode: 'full' }
    });
    const service = new FileOperationService(context.databasePath);
    services.push(service);

    await expect(service.removeFromCatalog({ assetIds: [asset.id] })).rejects.toThrow('ASSET_HAS_ACTIVE_TASKS');
    expect(context.catalog.listAssets()).toHaveLength(1);
  });

  it('moves an original to the injected system trash and retains its catalog history', async () => {
    const context = await fixture();
    const asset = context.catalog.listAssets()[0]!;
    const trashDirectory = path.join(context.root, 'system-trash');
    await mkdir(trashDirectory);
    const service = new FileOperationService(context.databasePath, undefined, {
      trashItem: async (filePath) => rename(filePath, path.join(trashDirectory, path.basename(filePath)))
    });
    services.push(service);

    const report = await service.moveToSystemTrash({ assetIds: [asset.id] });

    expect(report).toMatchObject({ kind: 'trash', status: 'completed', succeeded: 1, failed: 0 });
    expect(context.catalog.listAssets()).toEqual([]);
    expect(await readFile(path.join(trashDirectory, 'photo.jpg'), 'utf8')).toBe('content:photo.jpg');
    const history = service.listHistory();
    expect(history[0]).toMatchObject({ id: report.operationId, kind: 'trash', status: 'completed', total: 1, succeeded: 1 });
    expect(history[0]?.fileNames).toEqual(['photo.jpg']);
    expect(JSON.stringify(history)).not.toContain(context.source);
  });

  it('reports partial system-trash success and keeps failed assets active', async () => {
    const context = await fixture(['a.jpg', 'b.jpg']);
    const assets = context.catalog.listAssets().sort((left, right) => left.fileName.localeCompare(right.fileName));
    const trashDirectory = path.join(context.root, 'partial-trash');
    await mkdir(trashDirectory);
    const service = new FileOperationService(context.databasePath, undefined, {
      trashItem: async (filePath) => {
        if (filePath.endsWith(`${path.sep}b.jpg`)) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
        await rename(filePath, path.join(trashDirectory, path.basename(filePath)));
      }
    });
    services.push(service);

    const report = await service.moveToSystemTrash({ assetIds: assets.map((item) => item.id) });

    expect(report).toMatchObject({ status: 'partial', succeeded: 1, failed: 1 });
    expect(report.failures).toEqual([{ assetId: assets[1]!.id, errorCode: 'EBUSY' }]);
    expect(context.catalog.listAssets().map((item) => item.fileName)).toEqual(['b.jpg']);
    expect(await readFile(path.join(context.source, 'b.jpg'), 'utf8')).toBe('content:b.jpg');
  });

  it('finishes catalog removal after an interrupted trash operation', async () => {
    const context = await fixture();
    const asset = context.catalog.listAssets()[0]!;
    const bootstrap = new FileOperationService(context.databasePath);
    bootstrap.close();
    const trashDirectory = path.join(context.root, 'recovery-trash');
    await mkdir(trashDirectory);
    const sourcePath = path.join(context.source, 'photo.jpg');
    await rename(sourcePath, path.join(trashDirectory, 'photo.jpg'));
    const operationId = randomUUID();
    const itemId = randomUUID();
    const database = new DatabaseSync(context.databasePath);
    database.prepare(`
      INSERT INTO file_operations (id, kind, status, target_folder_id, created_at)
      VALUES (?, 'trash', 'executing', ?, ?)
    `).run(operationId, asset.folderId, Date.now());
    database.prepare(`
      INSERT INTO file_operation_items (
        id, operation_id, ordinal, asset_id, source_folder_id, destination_folder_id,
        source_path, destination_path, temporary_path, original_file_name,
        destination_file_name, size_bytes, status
      ) VALUES (?, ?, 0, ?, ?, ?, ?, ?, ?, 'photo.jpg', 'photo.jpg', ?, 'trashing')
    `).run(
      itemId, operationId, asset.id, asset.folderId, asset.folderId,
      sourcePath, sourcePath, sourcePath, asset.sizeBytes
    );
    database.close();
    const service = new FileOperationService(context.databasePath);
    services.push(service);

    expect(await service.recoverInterruptedOperations()).toEqual({ total: 1, resolved: 1, failed: 0 });
    expect(context.catalog.listAssets()).toEqual([]);
    expect(service.listHistory()[0]).toMatchObject({ kind: 'trash', status: 'completed', succeeded: 1 });
  });
});
