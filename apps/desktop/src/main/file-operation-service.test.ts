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

    expect(await service.recoverInterruptedOperations()).toBe(1);
    expect(await readFile(sourcePath, 'utf8')).toBe('content:photo.jpg');
    await expect(stat(destinationPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(context.catalog.resolveAssetFile(asset.id)?.path).toBe(sourcePath);
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

    expect(await service.recoverInterruptedOperations()).toBe(1);
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

    expect(await service.recoverInterruptedOperations()).toBe(1);
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

    expect(await service.recoverInterruptedOperations()).toBe(1);
    expect(context.catalog.listAssets()).toEqual([]);
    expect(service.listHistory()[0]).toMatchObject({ kind: 'trash', status: 'completed', succeeded: 1 });
  });
});
