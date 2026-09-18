import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { app, BrowserWindow, dialog, ipcMain, net, protocol, safeStorage, shell } from 'electron';
import {
  appInfoSchema,
  catalogAssetRemovalInputSchema,
  catalogAssetRemovalReportSchema,
  catalogSnapshotSchema,
  catalogAlbumSchema,
  copyCatalogAssetsInputSchema,
  copyCatalogAssetsReportSchema,
  enqueueTaskInputSchema,
  exportGenerationResultsInputSchema,
  exportReportSchema,
  saveExportPresetInputSchema,
  exportPresetSchema,
  imageCacheStatsSchema,
  pruneImageCacheInputSchema,
  listAnalysisInputSchema,
  listCatalogAssetsInputSchema,
  listGenerationResultsInputSchema,
  updateGenerationResultReviewInputSchema,
  moveCatalogAssetsInputSchema,
  moveCatalogAssetsReportSchema,
  renameCatalogAssetInputSchema,
  renameCatalogAssetsInputSchema,
  renameCatalogAssetsReportSchema,
  renameCatalogAssetReportSchema,
  reorderTaskIdsSchema,
  savePromptTemplateInputSchema,
  saveProviderProfileInputSchema,
  taskIdSchema,
  updateCatalogMetadataInputSchema,
  updateCatalogTagsInputSchema,
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
import { TaskService } from './task-service';
import { TaskRunner } from './task-runner';
import { TemplateService } from './template-service';
import { WorkspaceService } from './workspace-service';

const APP_ORIGIN = 'app://photoallisai';
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

function registerIpc(): void {
  ipcMain.handle('app.info.v1', () =>
    appInfoSchema.parse({
      name: app.getName(),
      version: app.getVersion(),
      platform: process.platform
    })
  );
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
  ipcMain.handle('catalog.assets.move.v1', async (_event, input: unknown) =>
    moveCatalogAssetsReportSchema.parse(
      await fileOperations.move(moveCatalogAssetsInputSchema.parse(input))
    )
  );
  ipcMain.handle('catalog.assets.copy.v1', async (_event, input: unknown) =>
    copyCatalogAssetsReportSchema.parse(
      await fileOperations.copy(copyCatalogAssetsInputSchema.parse(input))
    )
  );
  ipcMain.handle('catalog.asset.rename.v1', async (_event, input: unknown) =>
    renameCatalogAssetReportSchema.parse(
      await fileOperations.rename(renameCatalogAssetInputSchema.parse(input))
    )
  );
  ipcMain.handle('catalog.assets.rename.v1', async (_event, input: unknown) =>
    renameCatalogAssetsReportSchema.parse(await fileOperations.renameMany(renameCatalogAssetsInputSchema.parse(input)))
  );
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

  ipcMain.handle('providers.list.v1', () => providers.list());
  ipcMain.handle('providers.save.v1', (_event, input: unknown) =>
    providers.save(saveProviderProfileInputSchema.parse(input))
  );
  ipcMain.handle('providers.test.v1', (_event, input: unknown) =>
    providers.test(saveProviderProfileInputSchema.parse(input))
  );
  ipcMain.handle('tasks.list.v1', () => tasks.list());
  ipcMain.handle('tasks.enqueue.v1', (_event, input: unknown) => {
    const task = tasks.enqueue(enqueueTaskInputSchema.parse(input));
    taskRunner.wake();
    return task;
  });
  ipcMain.handle('tasks.cancel.v1', (_event, taskId: unknown) => {
    const id = taskIdSchema.parse(taskId);
    taskRunner.cancel(id);
    return tasks.cancel(id);
  });
  ipcMain.handle('tasks.retry.v1', (_event, taskId: unknown) => {
    const task = tasks.retry(taskIdSchema.parse(taskId));
    taskRunner.wake();
    return task;
  });
  ipcMain.handle('tasks.reorder.v1', (_event, taskIds: unknown) =>
    tasks.reorder(reorderTaskIdsSchema.parse(taskIds))
  );
  ipcMain.handle('templates.list.v1', () => templates.list());
  ipcMain.handle('templates.save.v1', (_event, input: unknown) =>
    templates.save(savePromptTemplateInputSchema.parse(input))
  );
  ipcMain.handle('analysis.list.v1', (_event, input: unknown) => {
    const { assetId } = listAnalysisInputSchema.parse(input);
    return analysis.list(assetId);
  });
  ipcMain.handle('generation.results.list.v1', (_event, input: unknown) => {
    const { assetId } = listGenerationResultsInputSchema.parse(input);
    return generation.list(assetId);
  });
  ipcMain.handle('generation.result.review.update.v1', (_event, input: unknown) =>
    generation.updateReview(updateGenerationResultReviewInputSchema.parse(input))
  );
  ipcMain.handle('generation.results.export.v1', async (_event, input: unknown) => {
    const { resultIds, presetId } = exportGenerationResultsInputSchema.parse(input);
    const selection = await dialog.showOpenDialog({
      title: '导出生成图片',
      buttonLabel: '导出到此处',
      properties: ['openDirectory', 'createDirectory']
    });
    if (selection.canceled || !selection.filePaths[0]) {
      return exportReportSchema.parse({
        id: null, canceled: true, total: resultIds.length,
        succeeded: 0, failed: 0, files: [], failures: []
      });
    }
    const preset = presetId ? exportPresets.list().find((item) => item.id === presetId) : undefined;
    if (presetId && !preset) throw new Error('EXPORT_PRESET_NOT_FOUND');
    return exportService.exportToDirectory(resultIds, selection.filePaths[0], preset);
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
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    trafficLightPosition: { x: 16, y: 18 },
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
    void window.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'));
  }

  return window;
}

const hasLock = app.requestSingleInstanceLock();
if (!hasLock) app.quit();

const customUserData = process.env.PHOTOALLISAI_USER_DATA;
if (customUserData) app.setPath('userData', customUserData);

app.whenReady().then(async () => {
  const libraryDirectory = join(app.getPath('userData'), 'library');
  mkdirSync(libraryDirectory, { recursive: true });
  const databasePath = join(libraryDirectory, 'catalog.sqlite');
  workspace = new WorkspaceService(databasePath);
  catalog = new CatalogService(databasePath);
  catalogWatcher = new CatalogWatcher(catalog);
  catalogWatcher.watchFolders(catalog.listFolderPaths());
  fileOperations = new FileOperationService(databasePath, undefined, {
    trashItem: (filePath) => shell.trashItem(filePath)
  });
  await fileOperations.recoverInterruptedOperations();
  tasks = new TaskService(databasePath);
  templates = new TemplateService(databasePath);
  imageCache = new ImageCacheService(join(app.getPath('userData'), 'cache', 'images'), catalog);
  void imageCache.prune(5 * 1024 * 1024 * 1024);
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
  exportService = new ExportService(databasePath, generation);
  exportPresets = new ExportPresetService(databasePath);
  taskRunner = new TaskRunner(tasks, analysis, generation);

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
  let mainWindow = createWindow();

  app.on('second-instance', () => {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  catalogWatcher?.stop();
  taskRunner?.stop();
  workspace?.close();
  generation?.close();
  exportService?.close();
  exportPresets?.close();
  analysis?.close();
  templates?.close();
  tasks?.close();
  fileOperations?.close();
  catalog?.close();
});
