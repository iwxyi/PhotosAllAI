import { createHash } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { app, BrowserWindow, dialog, ipcMain, net, protocol, safeStorage, shell } from 'electron';
import {
  appInfoSchema,
  appSettingsSchema,
  diagnosticSnapshotSchema,
  diagnosticExportResultSchema,
  databaseBackupResultSchema,
  libraryBackupResultSchema,
  libraryBackupVerificationResultSchema,
  libraryRestoreResultSchema,
  catalogAssetRemovalInputSchema,
  catalogAssetRemovalReportSchema,
  catalogSnapshotSchema,
  catalogAlbumSchema,
  deleteCatalogTagInputSchema,
  copyCatalogAssetsInputSchema,
  copyCatalogAssetsReportSchema,
  catalogCompanionPreviewInputSchema,
  catalogCompanionPreviewSchema,
  catalogFolderSyncReportSchema,
  enqueueTaskInputSchema,
  exportGenerationResultsInputSchema,
  exportTaskPayloadSchema,
  generationResultIdInputSchema,
  saveExportPresetInputSchema,
  exportPresetSchema,
  imageCacheStatsSchema,
  pruneImageCacheInputSchema,
  listAnalysisInputSchema,
  listCatalogAssetsInputSchema,
  listTaskPageInputSchema,
  listGenerationResultsInputSchema,
  moveQueuedTaskInputSchema,
  updateGenerationResultReviewInputSchema,
  moveCatalogAssetsInputSchema,
  moveCatalogAssetsReportSchema,
  renameCatalogAssetInputSchema,
  renameCatalogAssetsInputSchema,
  renameCatalogAssetsReportSchema,
  renameCatalogAssetReportSchema,
  relinkCatalogFolderResultSchema,
  renameCatalogFolderInputSchema,
  renameCatalogFolderResultSchema,
  resizeQueuedGenerationBatchInputSchema,
  retryFailedGenerationTasksInputSchema,
  updateQueuedGenerationTaskInputSchema,
  updateQueuedGenerationTasksInputSchema,
  savePromptTemplateInputSchema,
  saveProviderProfileInputSchema,
  taskIdSchema,
  updateCatalogMetadataInputSchema,
  updateCatalogTagsInputSchema,
  unregisterCatalogFolderInputSchema,
  unregisterCatalogFolderReportSchema,
  undoFileOperationInputSchema,
  undoFileOperationReportSchema,
  saveCatalogAlbumInputSchema,
  updateCatalogAlbumAssetsInputSchema,
  workspaceSessionSchema
} from '@photoallisai/contracts';

import { CatalogService } from './catalog-service';
import { CatalogWatcher } from './catalog-watcher';
import { AnalysisService } from './analysis-service';
import { ImageCacheService, type ImageVariant } from './image-cache-service';
import { GenerationService } from './generation-service';
import { ExportService } from './export-service';
import { ExportPresetService } from './export-preset-service';
import { FileOperationService } from './file-operation-service';
import { ProviderService } from './provider-service';
import { replaceRegularFileSafely } from './safe-file-write';
import { TaskService } from './task-service';
import { TaskRunner } from './task-runner';
import { toRendererTask } from './task-sanitizer';
import { TemplateService } from './template-service';
import { WorkspaceService } from './workspace-service';
import { AppSettingsService } from './app-settings-service';
import { DatabaseBackupService } from './database-backup-service';
import { LibraryBackupService } from './library-backup-service';
import { DatabaseMigrationService } from './database-migration-service';
import { LibraryRestoreService } from './library-restore-service';
import { LibraryIntegrityService } from './library-integrity-service';
import { classifyAutomaticBackupFailure, classifyAutomaticBackupResult, type AutomaticBackupStatus } from './automatic-backup-status';
import { settleBeforeShutdown } from './shutdown-coordinator';
import { createStartupFailureDialog } from './startup-failure';
import { getWindowChromeOptions } from './window-chrome';

const APP_ORIGIN = 'app://photoallisai';
const APPLICATION_SCHEMA_VERSION = 4;
let catalog: CatalogService;
let catalogWatcher: CatalogWatcher;
let imageCache: ImageCacheService;
let providers: ProviderService;
let tasks: TaskService;
let templates: TemplateService;
let analysis: AnalysisService;
let generation: GenerationService;
let exportService: ExportService;
let exportPresets: ExportPresetService;
let fileOperations: FileOperationService;
let taskRunner: TaskRunner;
let workspace: WorkspaceService;
let appSettings: AppSettingsService;
let databaseBackup: DatabaseBackupService;
let libraryBackup: LibraryBackupService;
let libraryRestore: LibraryRestoreService;
let libraryIntegrity: LibraryIntegrityService;
let contentHashTimer: NodeJS.Timeout | undefined;
let contentHashPass: Promise<void> | undefined;
let contentHashPassRunning = false;
let shuttingDown = false;
let shutdownStarted = false;
let shutdownFinished = false;
let mainWindow: BrowserWindow | null = null;
let startupRecovery = {
  trashPurges: { total: 0, recovered: 0, conflicts: 0, failed: 0 },
  fileOperations: { total: 0, resolved: 0, failed: 0 },
  generationWrites: { total: 0, recovered: 0, failed: 0 },
  automaticBackup: { status: 'pending' as AutomaticBackupStatus }
};

async function createDiagnosticSnapshot() {
  const [profiles, cacheStats, raw, integrity] = await Promise.all([providers.list(), imageCache.getStats(), imageCache.getDecoderCapabilities(), libraryIntegrity.scan()]);
  const taskCounts = tasks.getStatusCounts();
  return diagnosticSnapshotSchema.parse({
    appVersion: app.getVersion(),
    platform: process.platform,
    catalog: catalog.getStats(),
    catalogWatcher: catalogWatcher.getStats(),
    providers: { total: profiles.length, enabled: profiles.filter((profile) => profile.enabled).length },
    tasks: taskCounts,
    cache: { ...cacheStats, performance: imageCache.getPerformanceStats(), raw },
    startupRecovery,
    integrity
  });
}

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'photoasset',
    privileges: { standard: true, secure: true, supportFetchAPI: true }
  },
  {
    scheme: 'photoresult',
    privileges: { standard: true, secure: true, supportFetchAPI: true }
  }
]);

async function relocatePortableAfterFileOperation(
  assetId: string,
  previous: { path: string; fileName: string } | null
): Promise<void> {
  if (!previous) return;
  const next = catalog.resolveAssetFile(assetId);
  if (!next) return;
  await generation.relocatePortableResults(assetId, previous.path, next.path, previous.fileName, next.fileName);
}

function registerIpc(): void {
  ipcMain.handle('app.info.v1', () =>
    appInfoSchema.parse({
      name: app.getName(),
      version: app.getVersion(),
      platform: process.platform
    })
  );
  ipcMain.handle('app.settings.get.v1', () => appSettings.get());
  ipcMain.handle('app.settings.save.v1', async (_event, input: unknown) => {
    const parsed = appSettingsSchema.parse(input);
    const previous = await appSettings.get();
    const saved = await appSettings.save(parsed);
    if (saved.cacheMaxBytes !== previous.cacheMaxBytes) await imageCache.setMaxBytes(saved.cacheMaxBytes);
    return saved;
  });
  ipcMain.handle('app.diagnostics.v1', createDiagnosticSnapshot);
  ipcMain.handle('app.integrity.scan.v1', () => libraryIntegrity.scan());
  ipcMain.handle('app.diagnostics.export.v1', async () => {
    const selection = await dialog.showSaveDialog({
      title: '导出脱敏诊断文件',
      buttonLabel: '保存诊断文件',
      defaultPath: join(app.getPath('documents'), `PhotoAllIsAI-diagnostics-${Date.now()}.json`),
      filters: [{ name: 'JSON', extensions: ['json'] }]
    });
    if (selection.canceled || !selection.filePath) {
      return diagnosticExportResultSchema.parse({ canceled: true, bytes: 0, sha256: null });
    }
    const content = Buffer.from(JSON.stringify({ generatedAt: new Date().toISOString(), snapshot: await createDiagnosticSnapshot() }, null, 2));
    await replaceRegularFileSafely(selection.filePath, content);
    return diagnosticExportResultSchema.parse({
      canceled: false,
      bytes: content.byteLength,
      sha256: createHash('sha256').update(content).digest('hex')
    });
  });
  ipcMain.handle('app.database.backup.v1', async () => {
    const selection = await dialog.showSaveDialog({
      title: '备份图库数据库',
      buttonLabel: '保存备份',
      defaultPath: join(app.getPath('documents'), 'PhotoAllIsAI-catalog.sqlite'),
      filters: [{ name: 'SQLite 数据库', extensions: ['sqlite'] }]
    });
    if (selection.canceled || !selection.filePath) {
      return databaseBackupResultSchema.parse({ canceled: true, destinationPath: null, bytes: 0, sha256: null });
    }
    const result = await databaseBackup.create(selection.filePath);
    return databaseBackupResultSchema.parse({ canceled: false, ...result });
  });
  ipcMain.handle('app.library.backup.v1', async () => {
    const selection = await dialog.showOpenDialog({
      title: '选择完整图库备份位置',
      buttonLabel: '备份到此处',
      properties: ['openDirectory', 'createDirectory']
    });
    if (selection.canceled || !selection.filePaths[0]) {
      return libraryBackupResultSchema.parse({ canceled: true, databaseBytes: 0, generatedFiles: 0, generatedBytes: 0, manifestSha256: null });
    }
    const result = await libraryBackup.create(selection.filePaths[0]);
    return libraryBackupResultSchema.parse({ canceled: false, ...result });
  });
  ipcMain.handle('app.library.backup.verify.v1', async () => {
    const selection = await dialog.showOpenDialog({
      title: '选择要验证的图库备份包',
      buttonLabel: '验证此备份',
      properties: ['openDirectory']
    });
    if (selection.canceled || !selection.filePaths[0]) {
      return libraryBackupVerificationResultSchema.parse({ canceled: true, createdAt: null, databaseBytes: 0, generatedFiles: 0, generatedBytes: 0 });
    }
    const result = await libraryBackup.verify(selection.filePaths[0]);
    return libraryBackupVerificationResultSchema.parse({ canceled: false, ...result });
  });
  ipcMain.handle('app.library.restore.v1', async () => {
    const selection = await dialog.showOpenDialog({
      title: '选择要恢复的完整图库备份包',
      buttonLabel: '选择此备份',
      properties: ['openDirectory']
    });
    if (selection.canceled || !selection.filePaths[0]) {
      return libraryRestoreResultSchema.parse({ canceled: true, createdAt: null, databaseBytes: 0, generatedFiles: 0, generatedBytes: 0 });
    }
    const confirmation = await dialog.showMessageBox({
      type: 'warning',
      title: '恢复图库备份',
      message: '恢复后应用将立即重启',
      detail: '当前图库会完整保留为恢复前副本。备份包不包含原图，恢复后仍可能需要重新定位原图文件夹。',
      buttons: ['取消', '验证并恢复'],
      defaultId: 0,
      cancelId: 0,
      noLink: true
    });
    if (confirmation.response !== 1) {
      return libraryRestoreResultSchema.parse({ canceled: true, createdAt: null, databaseBytes: 0, generatedFiles: 0, generatedBytes: 0 });
    }
    const result = await libraryRestore.stage(selection.filePaths[0]);
    setTimeout(() => {
      app.relaunch();
      app.quit();
    }, 500).unref();
    return libraryRestoreResultSchema.parse({ canceled: false, ...result });
  });
  ipcMain.handle('workspace.session.get.v1', () => workspace.get());
  ipcMain.handle('workspace.session.save.v1', (_event, input: unknown) =>
    workspace.save(workspaceSessionSchema.parse(input))
  );

  ipcMain.handle('catalog.assets.list.v1', () => catalog.listAssets());
  ipcMain.handle('catalog.assets.page.v1', (_event, input: unknown) =>
    catalog.listAssetPage(listCatalogAssetsInputSchema.parse(input))
  );
  ipcMain.handle('catalog.folders.list.v1', () => catalog.listFolders());
  ipcMain.handle('catalog.tags.list.v1', () => catalog.listTags());
  ipcMain.handle('catalog.tags.delete.v1', (_event, input: unknown) => {
    catalog.deleteTag(deleteCatalogTagInputSchema.parse(input));
  });
  ipcMain.handle('catalog.albums.list.v1', () => catalog.listAlbums());
  ipcMain.handle('catalog.smart-collections.list.v1', () => catalog.listSmartCollections());
  ipcMain.handle('catalog.album.save.v1', (_event, input: unknown) =>
    catalogAlbumSchema.parse(catalog.saveAlbum(saveCatalogAlbumInputSchema.parse(input)))
  );
  ipcMain.handle('catalog.album.delete.v1', (_event, input: unknown) => {
    const albumId = String(input);
    catalog.deleteAlbum(albumId);
  });
  ipcMain.handle('catalog.album.assets.update.v1', (_event, input: unknown) =>
    catalogAlbumSchema.parse(catalog.updateAlbumAssets(updateCatalogAlbumAssetsInputSchema.parse(input)))
  );
  ipcMain.handle('catalog.metadata.update.v1', (_event, input: unknown) =>
    catalog.updateMetadata(updateCatalogMetadataInputSchema.parse(input))
  );
  ipcMain.handle('catalog.tags.update.v1', (_event, input: unknown) =>
    catalog.updateTags(updateCatalogTagsInputSchema.parse(input))
  );
  ipcMain.handle('catalog.assets.companions.v1', async (_event, input: unknown) =>
    catalogCompanionPreviewSchema.parse(await fileOperations.previewCompanions(catalogCompanionPreviewInputSchema.parse(input)))
  );
  ipcMain.handle('catalog.assets.move.v1', async (_event, input: unknown) => {
    const parsed = moveCatalogAssetsInputSchema.parse(input);
    const companions = parsed.includeCompanions ? await fileOperations.previewCompanions(parsed.assetIds) : { files: [] };
    const affectedIds = [...parsed.assetIds, ...companions.files.flatMap((file) => file.assetId ? [file.assetId] : [])];
    const previous = new Map(affectedIds.map((assetId) => [assetId, catalog.resolveAssetFile(assetId)]));
    const report = moveCatalogAssetsReportSchema.parse(await fileOperations.move(parsed));
    if (report.status === 'completed') {
      await Promise.allSettled(report.files.map((file) => relocatePortableAfterFileOperation(file.assetId, previous.get(file.assetId) ?? null)));
    }
    return report;
  });
  ipcMain.handle('catalog.assets.copy.v1', async (_event, input: unknown) =>
    copyCatalogAssetsReportSchema.parse(
      await fileOperations.copy(copyCatalogAssetsInputSchema.parse(input))
    )
  );
  ipcMain.handle('catalog.asset.rename.v1', async (_event, input: unknown) => {
    const parsed = renameCatalogAssetInputSchema.parse(input);
    const previous = catalog.resolveAssetFile(parsed.assetId);
    const report = renameCatalogAssetReportSchema.parse(await fileOperations.rename(parsed));
    if (report.status === 'completed') await Promise.allSettled([relocatePortableAfterFileOperation(parsed.assetId, previous)]);
    return report;
  });
  ipcMain.handle('catalog.assets.rename.v1', async (_event, input: unknown) => {
    const parsed = renameCatalogAssetsInputSchema.parse(input);
    const previous = new Map(parsed.items.map((item) => [item.assetId, catalog.resolveAssetFile(item.assetId)]));
    const report = renameCatalogAssetsReportSchema.parse(await fileOperations.renameMany(parsed));
    if (report.reports.length > 0) {
      await Promise.allSettled(report.reports.filter((item) => item.status === 'completed').map((item) => relocatePortableAfterFileOperation(item.assetId, previous.get(item.assetId) ?? null)));
    }
    return report;
  });
  ipcMain.handle('catalog.assets.remove.v1', async (_event, input: unknown) =>
    catalogAssetRemovalReportSchema.parse(
      await fileOperations.removeFromCatalog(catalogAssetRemovalInputSchema.parse(input))
    )
  );
  ipcMain.handle('catalog.assets.trash.v1', async (_event, input: unknown) =>
    catalogAssetRemovalReportSchema.parse(
      await fileOperations.moveToSystemTrash(catalogAssetRemovalInputSchema.parse(input))
    )
  );
  ipcMain.handle('files.operations.list.v1', () => fileOperations.listHistory());
  ipcMain.handle('files.operations.undo.v1', async (_event, input: unknown) => {
    const parsed = undoFileOperationInputSchema.parse(input);
    const previous = new Map(fileOperations.getUndoAssetIds(parsed.operationId)
      .map((assetId) => [assetId, catalog.resolveAssetFile(assetId)]));
    const report = undoFileOperationReportSchema.parse(await fileOperations.undo(parsed));
    if (report.status === 'completed') {
      await Promise.allSettled(report.files.map((file) =>
        relocatePortableAfterFileOperation(file.assetId, previous.get(file.assetId) ?? null)
      ));
    }
    return report;
  });

  ipcMain.handle('catalog.folders.import.v1', async () => {
    const result = await dialog.showOpenDialog({
      title: '添加照片文件夹',
      properties: ['openDirectory', 'multiSelections']
    });
    if (result.canceled) return null;

    const importedCount = await catalog.importFolders(result.filePaths);
    catalogWatcher.watchFolders(catalog.listFolderPaths());
    return catalogSnapshotSchema.parse({ assets: catalog.listAssets(), importedCount });
  });
  ipcMain.handle('catalog.folder.relink.v1', async (_event, input: unknown) => {
    const folderId = String(input);
    if (!/^[a-f0-9]{32}$/u.test(folderId)) throw new Error('INVALID_FOLDER_ID');
    const result = await dialog.showOpenDialog({
      title: '重新定位照片文件夹',
      buttonLabel: '选择新位置',
      properties: ['openDirectory']
    });
    if (result.canceled || !result.filePaths[0]) return null;
    const report = await catalog.relinkFolder(folderId, result.filePaths[0]);
    await Promise.allSettled(report.relocations.map((item) => generation.relocatePortableResults(
      item.assetId,
      item.previousPath,
      item.nextPath,
      item.previousFileName,
      item.nextFileName
    )));
    catalogWatcher.watchFolders(catalog.listFolderPaths());
    return relinkCatalogFolderResultSchema.parse(report);
  });
  ipcMain.handle('catalog.folder.synchronize.v1', async (_event, input: unknown) => {
    const folderId = String(input);
    if (!/^[a-f0-9]{32}$/u.test(folderId)) throw new Error('INVALID_FOLDER_ID');
    return catalogFolderSyncReportSchema.parse(await catalog.synchronizeFolder(folderId));
  });
  ipcMain.handle('catalog.folder.reveal.v1', (_event, input: unknown) => {
    const folderId = String(input);
    if (!/^[a-f0-9]{32}$/u.test(folderId)) throw new Error('INVALID_FOLDER_ID');
    const folderPath = catalog.resolveFolderPath(folderId);
    if (!folderPath || !existsSync(folderPath)) return false;
    shell.showItemInFolder(folderPath);
    return true;
  });
  ipcMain.handle('catalog.folder.rename.v1', async (_event, input: unknown) =>
    renameCatalogFolderResultSchema.parse(await catalog.renameFolder(renameCatalogFolderInputSchema.parse(input)))
  );
  ipcMain.handle('catalog.folder.unregister.v1', (_event, input: unknown) => {
    const report = catalog.unregisterFolder(unregisterCatalogFolderInputSchema.parse(input).folderId);
    catalogWatcher.watchFolders(catalog.listFolderPaths());
    return unregisterCatalogFolderReportSchema.parse(report);
  });
  ipcMain.handle('catalog.asset.reveal.v1', (_event, input: unknown) => {
    const assetId = String(input);
    if (!/^[0-9a-f-]{20,40}$/iu.test(assetId)) throw new Error('INVALID_ASSET_ID');
    const source = catalog.resolveAssetFile(assetId);
    if (!source || !existsSync(source.path)) return false;
    shell.showItemInFolder(source.path);
    return true;
  });

  ipcMain.handle('providers.list.v1', () => providers.list());
  ipcMain.handle('providers.save.v1', (_event, input: unknown) =>
    providers.save(saveProviderProfileInputSchema.parse(input))
  );
  ipcMain.handle('providers.delete.v1', async (_event, input: unknown) => {
    const profileId = String(input);
    if (tasks.hasActiveProvider(profileId)) {
      throw new Error('PROVIDER_HAS_ACTIVE_TASKS');
    }
    await providers.delete(profileId);
  });
  ipcMain.handle('providers.test.v1', (_event, input: unknown) =>
    providers.test(saveProviderProfileInputSchema.parse(input))
  );
  ipcMain.handle('tasks.page.v1', (_event, input: unknown) => {
    const page = tasks.listPage(listTaskPageInputSchema.parse(input));
    return { ...page, items: page.items.map(toRendererTask) };
  });
  ipcMain.handle('tasks.get.v1', (_event, taskId: unknown) => {
    const task = tasks.find(taskIdSchema.parse(taskId));
    return task ? toRendererTask(task) : null;
  });
  ipcMain.handle('tasks.enqueue.v1', (_event, input: unknown) => {
    const parsed = enqueueTaskInputSchema.parse(input);
    if (parsed.kind === 'export') throw new Error('EXPORT_TASK_REQUIRES_DIRECTORY_SELECTION');
    const task = tasks.enqueue(parsed);
    taskRunner.wake();
    return toRendererTask(task);
  });
  ipcMain.handle('tasks.cancel.v1', (_event, taskId: unknown) => {
    const id = taskIdSchema.parse(taskId);
    taskRunner.cancel(id);
    return toRendererTask(tasks.cancel(id));
  });
  ipcMain.handle('tasks.pause.v1', (_event, taskId: unknown) => {
    const id = taskIdSchema.parse(taskId);
    const task = tasks.pause(id);
    taskRunner.cancel(id);
    return toRendererTask(task);
  });
  ipcMain.handle('tasks.resume.v1', (_event, taskId: unknown) => {
    const task = tasks.resume(taskIdSchema.parse(taskId));
    taskRunner.wake();
    return toRendererTask(task);
  });
  ipcMain.handle('tasks.retry.v1', (_event, taskId: unknown) => {
    const task = tasks.retry(taskIdSchema.parse(taskId));
    taskRunner.wake();
    return toRendererTask(task);
  });
  ipcMain.handle('tasks.move.v1', (_event, input: unknown) =>
    toRendererTask(tasks.moveQueued(moveQueuedTaskInputSchema.parse(input)))
  );
  ipcMain.handle('tasks.generation.retry-failed.v1', (_event, input: unknown) => {
    const report = tasks.retryFailedGenerations(retryFailedGenerationTasksInputSchema.parse(input ?? {}));
    if (report.retried > 0) taskRunner.wake();
    return report;
  });
  ipcMain.handle('tasks.generation.update.v1', (_event, input: unknown) =>
    tasks.updateQueuedGeneration(updateQueuedGenerationTaskInputSchema.parse(input))
  );
  ipcMain.handle('tasks.generation.update-many.v1', async (_event, input: unknown) => {
    const parsed = updateQueuedGenerationTasksInputSchema.parse(input);
    if (parsed.providerProfileId) {
      const profile = (await providers.list()).find((item) => item.id === parsed.providerProfileId);
      if (!profile || profile.purpose !== 'generation' || !profile.enabled) throw new Error('GENERATION_PROVIDER_NOT_AVAILABLE');
    }
    const result = tasks.updateQueuedGenerations(parsed);
    if (parsed.resize) taskRunner.wake();
    return result;
  });
  ipcMain.handle('tasks.generation.resize.v1', (_event, input: unknown) => {
    const result = tasks.resizeQueuedGenerationBatch(resizeQueuedGenerationBatchInputSchema.parse(input));
    taskRunner.wake();
    return result;
  });
  ipcMain.handle('templates.list.v1', () => templates.list());
  ipcMain.handle('templates.save.v1', (_event, input: unknown) =>
    templates.save(savePromptTemplateInputSchema.parse(input))
  );
  ipcMain.handle('templates.archive.v1', (_event, input: unknown) => {
    const templateId = String(input);
    if (!/^[0-9a-f-]{36}$/iu.test(templateId)) throw new Error('INVALID_TEMPLATE_ID');
    templates.archive(templateId);
  });
  ipcMain.handle('analysis.list.v1', (_event, input: unknown) => {
    const { assetId } = listAnalysisInputSchema.parse(input);
    return analysis.list(assetId);
  });
  ipcMain.handle('generation.results.list.v1', (_event, input: unknown) => {
    const { assetId } = listGenerationResultsInputSchema.parse(input);
    return generation.list(assetId);
  });
  ipcMain.handle('generation.results.trash.list.v1', (_event, input: unknown) => {
    const { assetId } = listGenerationResultsInputSchema.parse(input);
    return generation.listTrashed(assetId);
  });
  ipcMain.handle('generation.result.trash.v1', (_event, input: unknown) =>
    generation.trash(generationResultIdInputSchema.parse(input).resultId)
  );
  ipcMain.handle('generation.result.restore.v1', (_event, input: unknown) =>
    generation.restore(generationResultIdInputSchema.parse(input).resultId)
  );
  ipcMain.handle('generation.trash.summary.v1', () => generation.getTrashSummary());
  ipcMain.handle('generation.trash.empty.v1', () => generation.emptyTrash());
  ipcMain.handle('generation.result.review.update.v1', (_event, input: unknown) =>
    generation.updateReview(updateGenerationResultReviewInputSchema.parse(input))
  );
  ipcMain.handle('generation.result.reveal.v1', (_event, input: unknown) => {
    const resultId = String(input);
    if (!/^[0-9a-f-]{36}$/iu.test(resultId)) throw new Error('INVALID_RESULT_ID');
    const filePath = generation.resolveResultFile(resultId);
    if (!filePath || !existsSync(filePath)) return false;
    shell.showItemInFolder(filePath);
    return true;
  });
  ipcMain.handle('generation.results.export.v1', async (_event, input: unknown) => {
    const { resultIds, presetId } = exportGenerationResultsInputSchema.parse(input);
    const selection = await dialog.showOpenDialog({
      title: '导出生成图片',
      buttonLabel: '导出到此处',
      properties: ['openDirectory', 'createDirectory']
    });
    if (selection.canceled || !selection.filePaths[0]) {
      return null;
    }
    const preset = presetId ? exportPresets.list().find((item) => item.id === presetId) : undefined;
    if (presetId && !preset) throw new Error('EXPORT_PRESET_NOT_FOUND');
    const task = tasks.enqueue({
      kind: 'export',
      assetId: null,
      payload: exportTaskPayloadSchema.parse({
        resultIds,
        destinationDirectory: selection.filePaths[0],
        preset
      })
    });
    taskRunner.wake();
    return toRendererTask(task);
  });
  ipcMain.handle('export.destination.reveal.v1', async (_event, taskId: unknown) => {
    const task = tasks.find(taskIdSchema.parse(taskId));
    if (task?.kind !== 'export') return false;
    const payload = exportTaskPayloadSchema.safeParse(task.payload);
    if (!payload.success || !existsSync(payload.data.destinationDirectory)) return false;
    return await shell.openPath(payload.data.destinationDirectory) === '';
  });
  ipcMain.handle('export.presets.list.v1', () => exportPresets.list());
  ipcMain.handle('export.presets.save.v1', (_event, input: unknown) =>
    exportPresetSchema.parse(exportPresets.save(saveExportPresetInputSchema.parse(input)))
  );
  ipcMain.handle('export.presets.delete.v1', (_event, input: unknown) => {
    exportPresets.delete(String(input));
  });
  ipcMain.handle('cache.stats.get.v1', async () => imageCacheStatsSchema.parse(await imageCache.getStats()));
  ipcMain.handle('cache.prune.v1', async (_event, input: unknown) => {
    const result = await imageCache.prune(pruneImageCacheInputSchema.parse(input).maxBytes);
    return result;
  });
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1480,
    height: 940,
    minWidth: 1080,
    minHeight: 700,
    backgroundColor: '#111311',
    ...getWindowChromeOptions(process.platform),
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    const parsed = new URL(url);
    if (parsed.protocol === 'https:') void shell.openExternal(url);
    return { action: 'deny' };
  });

  window.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(APP_ORIGIN) && !process.env.ELECTRON_RENDERER_URL) event.preventDefault();
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    const rendererUrl = new URL(process.env.ELECTRON_RENDERER_URL);
    if (process.env.PHOTOALLISAI_E2E_DEMO === '1') rendererUrl.searchParams.set('e2e-demo', '1');
    void window.loadURL(rendererUrl.toString());
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'), process.env.PHOTOALLISAI_E2E_DEMO === '1'
      ? { query: { 'e2e-demo': '1' } }
      : undefined);
  }

  return window;
}

const hasLock = app.requestSingleInstanceLock();
if (!hasLock) app.quit();

const customUserData = process.env.PHOTOALLISAI_USER_DATA;
if (customUserData) app.setPath('userData', customUserData);

app.whenReady().then(async () => {
  const libraryDirectory = join(app.getPath('userData'), 'library');
  const prospectiveDatabasePath = join(libraryDirectory, 'catalog.sqlite');
  libraryBackup = new LibraryBackupService(prospectiveDatabasePath, join(libraryDirectory, 'generated'));
  libraryRestore = new LibraryRestoreService(libraryDirectory, libraryBackup);
  try {
    await libraryRestore.applyPending();
  } catch (error) {
    if (!existsSync(libraryDirectory)) throw error;
    await libraryRestore.quarantinePending();
  }
  mkdirSync(libraryDirectory, { recursive: true });
  const databasePath = prospectiveDatabasePath;
  const migration = new DatabaseMigrationService(databasePath);
  const migrationCheckpoint = await migration.prepare(APPLICATION_SCHEMA_VERSION);
  workspace = new WorkspaceService(databasePath);
  appSettings = new AppSettingsService(join(app.getPath('userData'), 'settings', 'app.json'));
  const initialAppSettings = await appSettings.get();
  databaseBackup = new DatabaseBackupService(databasePath);
  catalog = new CatalogService(databasePath);
  await catalog.reconcileImportedFolders();
  catalogWatcher = new CatalogWatcher(catalog);
  catalogWatcher.watchFolders(catalog.listFolderPaths());
  fileOperations = new FileOperationService(databasePath, undefined, {
    trashItem: (filePath) => shell.trashItem(filePath)
  });
  tasks = new TaskService(databasePath);
  templates = new TemplateService(databasePath);
  imageCache = new ImageCacheService(
    join(app.getPath('userData'), 'cache', 'images'), catalog, undefined, initialAppSettings.cacheMaxBytes
  );
  await imageCache.cleanupTemporaryFiles();
  void imageCache.prune(initialAppSettings.cacheMaxBytes);
  providers = new ProviderService(join(app.getPath('userData'), 'settings', 'providers.json'), {
    available: () => safeStorage.isEncryptionAvailable(),
    encrypt: (value) => safeStorage.encryptString(value).toString('base64'),
    decrypt: (value) => safeStorage.decryptString(Buffer.from(value, 'base64'))
  });
  analysis = new AnalysisService(databasePath, providers, imageCache);
  generation = new GenerationService(
    databasePath,
    join(libraryDirectory, 'generated'),
    providers,
    imageCache,
    catalog
  );
  const trashPurges = await generation.recoverInterruptedTrashPurges();
  const recoveredFileOperations = await fileOperations.recoverInterruptedOperations(async (change) => {
    await generation.relocatePortableResults(
      change.assetId, change.previousPath, change.path, change.previousFileName, change.fileName
    );
  });
  const generationWrites = await generation.recoverInterruptedWrites();
  startupRecovery = {
    trashPurges,
    fileOperations: recoveredFileOperations,
    generationWrites,
    automaticBackup: { status: 'pending' as AutomaticBackupStatus }
  };
  libraryIntegrity = new LibraryIntegrityService(databasePath, join(libraryDirectory, 'generated'));
  exportService = new ExportService(databasePath, generation);
  exportPresets = new ExportPresetService(databasePath);
  await migration.complete(APPLICATION_SCHEMA_VERSION, migrationCheckpoint);
  taskRunner = new TaskRunner(tasks, analysis, generation, {
    export: async (rawPayload, signal, taskId) => {
      signal?.throwIfAborted();
      const payload = exportTaskPayloadSchema.parse(rawPayload);
      const report = await exportService.exportToDirectory(
        payload.resultIds,
        payload.destinationDirectory,
        payload.preset,
        signal,
        taskId
      );
      signal?.throwIfAborted();
      return report;
    }
  });
  void databaseBackup.createAutomatic(join(libraryDirectory, 'backups'))
    .then((result) => {
      startupRecovery.automaticBackup.status = classifyAutomaticBackupResult(result);
    })
    .catch(() => {
      startupRecovery.automaticBackup.status = classifyAutomaticBackupFailure();
    });
  const scheduleContentHashPass = (delayMs = 2_000) => {
    if (shuttingDown) return;
    contentHashTimer = setTimeout(async () => {
      if (shuttingDown) return;
      const active = tasks.hasActiveTasks();
      let nextDelay = active ? 10_000 : 60_000;
      if (!active && !contentHashPassRunning) {
        contentHashPassRunning = true;
        contentHashPass = (async () => {
          try {
            const result = await catalog.indexPendingContentHashes(1);
            nextDelay = result.remaining === 0 ? 5 * 60_000 : result.indexed > 0 ? 2_000 : 60_000;
          } catch {
            // Hash indexing is opportunistic and must never block normal catalog work.
          } finally {
            contentHashPassRunning = false;
          }
        })();
        await contentHashPass;
        contentHashPass = undefined;
      }
      scheduleContentHashPass(nextDelay);
    }, delayMs);
    contentHashTimer.unref();
  };
  scheduleContentHashPass();

  protocol.handle('photoasset', async (request) => {
    const url = new URL(request.url);
    if (url.host !== 'thumbnail' && url.host !== 'preview') {
      return new Response('Not found', { status: 404 });
    }
    const assetId = url.pathname.slice(1);
    if (!/^[0-9a-f-]{20,40}$/i.test(assetId)) return new Response('Invalid asset', { status: 400 });

    try {
      const imagePath = await imageCache.getOrCreate(assetId, url.host as ImageVariant);
      if (!imagePath) return new Response('Not found', { status: 404 });
      return net.fetch(pathToFileURL(imagePath).toString());
    } catch {
      return new Response('Preview unavailable', { status: 422 });
    }
  });

  protocol.handle('photoresult', (request) => {
    const url = new URL(request.url);
    if (url.host !== 'result') return new Response('Not found', { status: 404 });
    const resultId = url.pathname.slice(1);
    if (!/^[0-9a-f-]{36}$/i.test(resultId)) return new Response('Invalid result', { status: 400 });
    const resultPath = generation.resolveResultFile(resultId);
    if (!resultPath) return new Response('Not found', { status: 404 });
    return net.fetch(pathToFileURL(resultPath).toString());
  });

  registerIpc();
  taskRunner.start();
  mainWindow = createWindow();
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  app.on('second-instance', () => {
    if (shuttingDown) return;
    if (!mainWindow || mainWindow.isDestroyed()) {
      mainWindow = BrowserWindow.getAllWindows()[0] ?? createWindow();
      mainWindow.on('closed', () => {
        mainWindow = null;
      });
    }
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    if (!mainWindow.isDestroyed()) mainWindow.focus();
  });

  app.on('activate', () => {
    if (shuttingDown) return;
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createWindow();
      mainWindow.on('closed', () => {
        mainWindow = null;
      });
    }
  });
}).catch((error: unknown) => {
  const failure = createStartupFailureDialog(error);
  dialog.showErrorBox(failure.title, failure.content);
  app.exit(1);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', (event) => {
  if (shutdownFinished) return;
  event.preventDefault();
  if (shutdownStarted) return;
  shutdownStarted = true;
  shuttingDown = true;
  if (contentHashTimer) clearTimeout(contentHashTimer);
  catalogWatcher?.stop();
  void settleBeforeShutdown([
    ...(taskRunner ? [taskRunner.stop()] : []),
    ...(contentHashPass ? [contentHashPass] : [])
  ], 10_000).then((result) => {
    if (result === 'timed-out') {
      app.exit(0);
      return;
    }
    workspace?.close();
    generation?.close();
    exportService?.close();
    exportPresets?.close();
    analysis?.close();
    templates?.close();
    tasks?.close();
    fileOperations?.close();
    catalog?.close();
    shutdownFinished = true;
    app.quit();
  });
});
