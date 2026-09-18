import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { app, BrowserWindow, dialog, ipcMain, net, protocol, safeStorage, shell } from 'electron';
import {
  appInfoSchema,
  catalogSnapshotSchema,
  enqueueTaskInputSchema,
  reorderTaskIdsSchema,
  saveProviderProfileInputSchema,
  taskIdSchema
} from '@photoallisai/contracts';

import { CatalogService } from './catalog-service';
import { ImageCacheService, type ImageVariant } from './image-cache-service';
import { ProviderService } from './provider-service';
import { TaskService } from './task-service';

const APP_ORIGIN = 'app://photoallisai';
let catalog: CatalogService;
let imageCache: ImageCacheService;
let providers: ProviderService;
let tasks: TaskService;

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'photoasset',
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
  ipcMain.handle('tasks.enqueue.v1', (_event, input: unknown) =>
    tasks.enqueue(enqueueTaskInputSchema.parse(input))
  );
  ipcMain.handle('tasks.cancel.v1', (_event, taskId: unknown) => tasks.cancel(taskIdSchema.parse(taskId)));
  ipcMain.handle('tasks.retry.v1', (_event, taskId: unknown) => tasks.retry(taskIdSchema.parse(taskId)));
  ipcMain.handle('tasks.reorder.v1', (_event, taskIds: unknown) =>
    tasks.reorder(reorderTaskIdsSchema.parse(taskIds))
  );
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
  imageCache = new ImageCacheService(join(app.getPath('userData'), 'cache', 'images'), catalog);
  providers = new ProviderService(join(app.getPath('userData'), 'settings', 'providers.json'), {
    available: () => safeStorage.isEncryptionAvailable(),
    encrypt: (value) => safeStorage.encryptString(value).toString('base64'),
    decrypt: (value) => safeStorage.decryptString(Buffer.from(value, 'base64'))
  });

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

  registerIpc();
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
  tasks?.close();
  catalog?.close();
});
