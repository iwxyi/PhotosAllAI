import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { app, BrowserWindow, dialog, ipcMain, net, protocol, safeStorage, shell } from 'electron';
import {
  appInfoSchema,
  catalogSnapshotSchema,
  enqueueTaskInputSchema,
  exportGenerationResultsInputSchema,
  exportReportSchema,
  listAnalysisInputSchema,
  listCatalogAssetsInputSchema,
  listGenerationResultsInputSchema,
  reorderTaskIdsSchema,
  savePromptTemplateInputSchema,
  saveProviderProfileInputSchema,
  taskIdSchema,
  updateCatalogMetadataInputSchema,
  updateCatalogTagsInputSchema
} from '@photoallisai/contracts';

import { CatalogService } from './catalog-service';
import { AnalysisService } from './analysis-service';
import { ImageCacheService, type ImageVariant } from './image-cache-service';
import { GenerationService } from './generation-service';
import { ExportService } from './export-service';
import { ProviderService } from './provider-service';
import { TaskService } from './task-service';
import { TaskRunner } from './task-runner';
import { TemplateService } from './template-service';

const APP_ORIGIN = 'app://photoallisai';
let catalog: CatalogService;
let imageCache: ImageCacheService;
let providers: ProviderService;
let tasks: TaskService;
let templates: TemplateService;
let analysis: AnalysisService;
let generation: GenerationService;
let exportService: ExportService;
let taskRunner: TaskRunner;

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

  ipcMain.handle('catalog.assets.list.v1', () => catalog.listAssets());
  ipcMain.handle('catalog.assets.page.v1', (_event, input: unknown) =>
    catalog.listAssetPage(listCatalogAssetsInputSchema.parse(input))
  );
  ipcMain.handle('catalog.folders.list.v1', () => catalog.listFolders());
  ipcMain.handle('catalog.tags.list.v1', () => catalog.listTags());
  ipcMain.handle('catalog.metadata.update.v1', (_event, input: unknown) =>
    catalog.updateMetadata(updateCatalogMetadataInputSchema.parse(input))
  );
  ipcMain.handle('catalog.tags.update.v1', (_event, input: unknown) =>
    catalog.updateTags(updateCatalogTagsInputSchema.parse(input))
  );

  ipcMain.handle('catalog.folders.import.v1', async () => {
    const result = await dialog.showOpenDialog({
      title: '添加照片文件夹',
      properties: ['openDirectory', 'multiSelections']
    });
    if (result.canceled) return null;

    const importedCount = await catalog.importFolders(result.filePaths);
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
  ipcMain.handle('generation.results.export.v1', async (_event, input: unknown) => {
    const { resultIds } = exportGenerationResultsInputSchema.parse(input);
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
    return exportService.exportToDirectory(resultIds, selection.filePaths[0]);
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

app.whenReady().then(() => {
  const libraryDirectory = join(app.getPath('userData'), 'library');
  mkdirSync(libraryDirectory, { recursive: true });
  const databasePath = join(libraryDirectory, 'catalog.sqlite');
  catalog = new CatalogService(databasePath);
  tasks = new TaskService(databasePath);
  templates = new TemplateService(databasePath);
  imageCache = new ImageCacheService(join(app.getPath('userData'), 'cache', 'images'), catalog);
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
  taskRunner?.stop();
  generation?.close();
  exportService?.close();
  analysis?.close();
  templates?.close();
  tasks?.close();
  catalog?.close();
});
