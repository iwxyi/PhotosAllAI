import { randomUUID } from 'node:crypto';
import { copyFile, link, mkdtemp, mkdir, readFile, readdir, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it } from 'vitest';

import { CatalogService } from './catalog-service';
import { FileOperationService } from './file-operation-service';

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
