import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { app, BrowserWindow, dialog, ipcMain, net, protocol, shell } from 'electron';
import { appInfoSchema, catalogSnapshotSchema } from '@photoallisai/contracts';

import { CatalogService } from './catalog-service';

const APP_ORIGIN = 'app://photoallisai';
let catalog: CatalogService;

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
  catalog = new CatalogService(join(libraryDirectory, 'catalog.sqlite'));

  protocol.handle('photoasset', (request) => {
    const url = new URL(request.url);
    if (url.host !== 'asset') return new Response('Not found', { status: 404 });
    const assetId = url.pathname.slice(1);
    const previewPath = catalog.resolvePreviewPath(assetId);
    if (!previewPath) return new Response('Preview unavailable', { status: 404 });
    return net.fetch(pathToFileURL(previewPath).toString());
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
  catalog?.close();
});
