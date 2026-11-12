import { createHash, randomUUID } from 'node:crypto';
import type { EventEmitter } from 'node:events';
import { appendFileSync, constants as fsConstants, existsSync, mkdirSync, statSync } from 'node:fs';
import { copyFile, mkdir, realpath, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { imageSizeFromFile } from 'image-size/fromFile';

import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, net, protocol, safeStorage, shell, type MenuItemConstructorOptions } from 'electron';
import {
  appInfoSchema,
  createAgentSessionSchema,
  agentSessionIdSchema,
  agentSendSchema,
  agentControlSchema,
  appSettingsSchema,
  fileWorkflowConfigSchema,
  previewFileWorkflowInputSchema,
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
  catalogSmartCollectionSchema,
  saveSmartCollectionInputSchema,
  deleteCatalogTagInputSchema,
  copyCatalogAssetsInputSchema,
  copyDisplayedFilesInputSchema,
  copyCatalogAssetsReportSchema,
  catalogCompanionPreviewInputSchema,
  catalogCompanionPreviewSchema,
  catalogFolderSyncReportSchema,
  enqueueTaskInputSchema,
  taskBatchInputSchema,
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
  moveCatalogFolderInputSchema,
  moveCatalogFolderResultSchema,
  renameCatalogAssetInputSchema,
  renameCatalogAssetsInputSchema,
  renameCatalogAssetsReportSchema,
  renameCatalogAssetReportSchema,
  relinkCatalogFolderResultSchema,
  renameCatalogFolderInputSchema,
  createCatalogFolderInputSchema,
  renameCatalogFolderResultSchema,
  resizeQueuedGenerationBatchInputSchema,
  retryFailedGenerationTasksInputSchema,
  updateQueuedGenerationTaskInputSchema,
  updateQueuedGenerationTasksInputSchema,
  savePromptTemplateInputSchema,
  saveProviderProfileInputSchema,
  taskIdSchema,
  deleteTasksInputSchema,
  taskBatchActionInputSchema,
  updateCatalogMetadataInputSchema,
  lightroomImportOptionsSchema,
  updateCatalogTagsInputSchema,
  unregisterCatalogFolderInputSchema,
  unregisterCatalogFolderReportSchema,
  undoFileOperationInputSchema,
  undoFileOperationReportSchema,
  saveCatalogAlbumInputSchema,
  updateCatalogAlbumAssetsInputSchema,
  workspaceSessionSchema,
  temporaryMediaPageInputSchema,
  menuStateSchema
} from '@photoallisai/contracts';
import { fileDetailsPageInputSchema, fileDetailsPageSchema, fileDetailsSchema, quickViewSessionSchema } from '@photoallisai/contracts';
import type { AppSettings, MenuCommand, MenuState, QuickViewSession } from '@photoallisai/contracts';

import { CatalogService } from './catalog-service';
import { LightroomImportService } from './lightroom-import-service';
import { isDirectPreviewImage, ImageFileService } from './image-file-service';
import { TemporaryMediaIndex } from './temporary-media-index';
import { identifyMediaFormat, isSupportedBrowseMedia } from './media-format-registry';
import { CatalogWatcher } from './catalog-watcher';
import { AnalysisService } from './analysis-service';
import { ImageCacheService, type ImageVariant } from './image-cache-service';
import { GenerationService } from './generation-service';
import { ExportService } from './export-service';
import { ExportPresetService } from './export-preset-service';
import { FileOperationService } from './file-operation-service';
import { readFilesFromClipboard, writeFilesToClipboard } from './file-clipboard';
import { ProviderService } from './provider-service';
import { replaceRegularFileSafely } from './safe-file-write';
import { TaskService } from './task-service';
import { AgentRuntime } from './agent-runtime';
import { AgentStore } from './agent-store';
import { ProviderAgentModel } from './agent-model';
import { AgentVision } from './agent-vision';
import { createAgentTools } from './agent-tools';
import { createAgentAppTools } from './agent-app-tools';
import { createAgentProgramTools } from './agent-program-tools';
import { AgentMcpServer } from './agent-mcp';
import { TaskRunner } from './task-runner';
import { AgentProcessor } from './agent-processor';
import { toRendererTask } from './task-sanitizer';
import { TemplateService } from './template-service';
import { WorkspaceService } from './workspace-service';
import { AppSettingsService } from './app-settings-service';
import { FileWorkflowService } from './file-workflow-service';
import { DatabaseBackupService } from './database-backup-service';
import { LibraryBackupService } from './library-backup-service';
import { DatabaseMigrationService } from './database-migration-service';
import { LibraryRestoreService } from './library-restore-service';
import { LibraryIntegrityService } from './library-integrity-service';
import { classifyAutomaticBackupFailure, classifyAutomaticBackupResult, type AutomaticBackupStatus } from './automatic-backup-status';
import { settleBeforeShutdown } from './shutdown-coordinator';
import { createStartupFailureDialog, writeStartupFailureLog } from './startup-failure';
import { getWindowChromeOptions } from './window-chrome';

const APP_ORIGIN = 'app://photoallisai';
const APPLICATION_SCHEMA_VERSION = 4;
let catalog: CatalogService;
let fileWorkflows: FileWorkflowService;
let catalogWatcher: CatalogWatcher;
let imageCache: ImageCacheService;
let imageFiles: ImageFileService;
let temporaryMediaIndex: TemporaryMediaIndex;
let pendingOpenPaths: string[] = [];
let pendingOpenSession: QuickViewSession | null = null;
let openingImages = Promise.resolve();
let providers: ProviderService;
let tasks: TaskService;
let templates: TemplateService;
let analysis: AnalysisService;
let generation: GenerationService;
let exportService: ExportService;
let exportPresets: ExportPresetService;
let fileOperations: FileOperationService;
let taskRunner: TaskRunner;
let agentRuntime: AgentRuntime;
let agentMcp: AgentMcpServer;
let workspace: WorkspaceService;
let appSettings: AppSettingsService;
let databaseBackup: DatabaseBackupService;
let libraryBackup: LibraryBackupService;
let libraryRestore: LibraryRestoreService;
let libraryIntegrity: LibraryIntegrityService;
let contentHashTimer: NodeJS.Timeout | undefined;
let catalogValidationTimer: NodeJS.Timeout | undefined;
let contentHashPass: Promise<void> | undefined;
let contentHashPassRunning = false;
let shuttingDown = false;
let shutdownStarted = false;
let shutdownFinished = false;
let mainWindow: BrowserWindow | null = null;
let startupReady = false;
let menuState: MenuState = {
  activeTab: 'library', hasSelection: false, selectionCount: 0,
  hasVisionProvider: false, hasGenerationProvider: false, taskCount: 0, hasRunningTask: false
};
let appLocale: AppSettings['locale'] = 'zh-CN';
const menuText = {
  'zh-CN': { file: '文件', edit: '编辑', library: '图库', photo: '照片', ai: 'AI', view: '查看', window: '窗口', help: '帮助', workflow: 'AI 工作流', openLibrary: '打开图库', addFolder: '添加关联文件夹…', closeWorkspace: '关闭当前工作区', refresh: '刷新图库', tasks: '打开任务中心', selectAll: '全选', clear: '取消全选', openViewer: '打开看图', fit: '适合窗口', zoom: '100% 查看', toggle: '原图 / 生成图切换', analyze: '分析选中照片', generate: '生成修图结果', templates: '提示词模板', settings: '设置', shortcuts: '快捷键', idle: '任务队列空闲', running: '任务队列正在运行', quit: '退出' },
  'en-US': { file: 'File', edit: 'Edit', library: 'Library', photo: 'Photo', ai: 'AI', view: 'View', window: 'Window', help: 'Help', workflow: 'AI Workflow', openLibrary: 'Open Library', addFolder: 'Add Linked Folder…', closeWorkspace: 'Close Workspace', refresh: 'Refresh Library', tasks: 'Open Task Center', selectAll: 'Select All', clear: 'Clear Selection', openViewer: 'Open Viewer', fit: 'Fit Image', zoom: 'View at 100%', toggle: 'Toggle Original / Generated', analyze: 'Analyze Selected Photos', generate: 'Generate Edited Results', templates: 'Prompt Templates', settings: 'Settings', shortcuts: 'Shortcuts', idle: 'Task queue idle', running: 'Task queue running', quit: 'Quit' }
} as const;
let startupRecovery = {
  trashPurges: { total: 0, recovered: 0, conflicts: 0, failed: 0 },
  fileOperations: { total: 0, resolved: 0, failed: 0 },
  generationWrites: { total: 0, recovered: 0, failed: 0 },
  automaticBackup: { status: 'pending' as AutomaticBackupStatus }
};

function sendMenuCommand(command: MenuCommand): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('menu.command.v1', command);
}

function validateImageId(id: unknown): string {
  if (typeof id !== 'string' || !/^[0-9a-f-]{20,40}$/iu.test(id)) throw new Error('INVALID_ASSET_ID');
  return id;
}

function reportOpenFailure(error: unknown): void {
  dialog.showErrorBox('无法打开图片', error instanceof Error ? error.message : String(error));
}

async function openImagePaths(paths: string[], notify = true): Promise<QuickViewSession> {
  const earlyProgress: QuickViewSession[] = [];
  const openState: { sessionId: string | undefined } = { sessionId: undefined };
  const operation = openingImages.then(() => imageFiles.open(paths, (progress) => {
    const update = temporaryMediaIndex ? { ...progress, items: [], indexed: true, totalCount: imageFiles.pageTemporary(progress.sessionId!, 0, 1).totalCount } : progress;
    if (!openState.sessionId) { earlyProgress.push(update); return; }
    const pending = pendingOpenSession;
    if (notify && pending && pending.sessionId === progress.sessionId) {
      // The pending session belongs to the main process until the renderer takes it.
      // Appending a batch in place avoids copying and validating the entire directory
      // once per progress event (quadratic work for large directories).
      if (!pending.indexed) pending.items.push(...progress.items);
      pending.complete = progress.complete;
      pending.totalCount = update.totalCount;
      if (progress.complete && !pending.indexed) pending.items.sort((a, b) => a.fileName.localeCompare(b.fileName, undefined, { numeric: true }));
      return;
    }
    mainWindow?.webContents.send('image.open.progress.v1', quickViewSessionSchema.parse(update));
  }));
  openingImages = operation.then(() => undefined, () => undefined);
  let session = quickViewSessionSchema.parse(await operation);
  openState.sessionId = session.sessionId;
  for (const progress of earlyProgress) {
    if (progress.sessionId !== session.sessionId) continue;
    if (!session.indexed) session.items.push(...progress.items);
    session.complete = progress.complete;
    if (session.indexed) session.totalCount = imageFiles.pageTemporary(session.sessionId!, 0, 1).totalCount;
  }
  if (session.complete && !session.indexed) session = { ...session, items: session.items.sort((a, b) => a.fileName.localeCompare(b.fileName, undefined, { numeric: true })) };
  if (session.indexed) session = { ...session, items: session.items.filter((item) => item.id === session.selectedId), totalCount: imageFiles.pageTemporary(session.sessionId!, 0, 1).totalCount };
  if (notify) {
    pendingOpenSession = session;
    showMainWindow();
    mainWindow?.webContents.send('image.opened.v1', session);
  }
  return session;
}

async function openImageDialog(notify = true): Promise<QuickViewSession | null> {
  const selection = await dialog.showOpenDialog({ title: appLocale === 'en-US' ? 'Open Images' : '打开图片', properties: ['openFile', 'multiSelections'], filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif', 'avif', 'bmp', 'ico', 'heic', 'heif', 'tif', 'tiff', 'dng', 'cr2', 'cr3', 'nef', 'nrw', 'arw', 'raf', 'rw2', 'orf', 'pef'] }] });
  return selection.canceled ? null : openImagePaths(selection.filePaths, notify);
}

function commandItem(label: string, command: MenuCommand, options: Partial<MenuItemConstructorOptions> = {}): MenuItemConstructorOptions {
  return { label, click: () => sendMenuCommand(command), ...options };
}

function buildApplicationMenu(): void {
  const text = menuText[appLocale];
  const hasPhotos = menuState.hasSelection;
  const onLibrary = menuState.activeTab === 'library' || menuState.activeTab === 'viewer';
  const template: MenuItemConstructorOptions[] = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' as const }] : []),
    {
      label: text.file, submenu: [
        { label: appLocale === 'en-US' ? 'Open Images…' : '打开图片…', accelerator: 'CmdOrCtrl+O', click: () => { void openImageDialog().catch(reportOpenFailure); } },
        commandItem(text.openLibrary, 'open-library', { accelerator: 'CmdOrCtrl+Shift+L' }),
        commandItem(text.addFolder, 'import-folders', { accelerator: 'CmdOrCtrl+Shift+O' }),
        commandItem(text.closeWorkspace, 'close-workspace', { enabled: menuState.activeTab !== 'library', accelerator: 'CmdOrCtrl+W' }),
        { type: 'separator' },
        { role: 'quit', label: process.platform === 'darwin' ? `${text.quit} PhotoAllIsAI` : text.quit }
      ]
    },
    {
      label: text.edit, submenu: [
        commandItem(text.selectAll, 'select-all', { accelerator: 'CmdOrCtrl+A' }),
        commandItem(text.clear, 'clear-selection', { enabled: hasPhotos, accelerator: 'CmdOrCtrl+Shift+A' }),
        { type: 'separator' },
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: appLocale === 'en-US' ? 'Cut' : '剪切' },
        { role: 'copy', label: appLocale === 'en-US' ? 'Copy' : '复制' },
        { role: 'paste', label: appLocale === 'en-US' ? 'Paste' : '粘贴' }
      ]
    },
    {
      label: text.library, submenu: [
        commandItem(text.refresh, 'refresh-catalog', { enabled: onLibrary, accelerator: 'CmdOrCtrl+R' }),
        commandItem(text.tasks, 'open-task-center', { accelerator: 'CmdOrCtrl+J' }),
        { type: 'separator' },
        { label: '当前排序和筛选由图库工具栏控制', enabled: false }
      ]
    },
    {
      label: text.photo, submenu: [
        commandItem(text.openViewer, 'open-viewer', { enabled: hasPhotos, accelerator: 'CmdOrCtrl+Enter' }),
        commandItem(text.fit, 'fit-image', { enabled: menuState.activeTab === 'viewer' && hasPhotos }),
        commandItem(text.zoom, 'zoom-100', { enabled: menuState.activeTab === 'viewer' && hasPhotos }),
        commandItem(text.toggle, 'toggle-original', { enabled: menuState.activeTab === 'viewer' && hasPhotos })
      ]
    },
    {
      label: text.ai, submenu: [
        commandItem(text.workflow, 'open-workflow'),
        commandItem(text.analyze, 'analyze-selection', { enabled: hasPhotos && menuState.hasVisionProvider }),
        commandItem(text.generate, 'generate-selection', { enabled: hasPhotos && menuState.hasGenerationProvider }),
        { type: 'separator' },
        commandItem(text.tasks, 'open-task-center'),
        commandItem(text.templates, 'open-prompt-templates')
      ]
    },
    {
      label: text.view, submenu: [
        commandItem(text.library, 'open-library', { type: 'normal' }),
        commandItem(text.openViewer, 'open-viewer', { enabled: menuState.hasSelection }),
        commandItem(text.workflow, 'open-workflow'),
        commandItem(text.templates, 'open-templates'),
        commandItem(`${text.tasks}${menuState.taskCount > 0 ? ` · ${menuState.taskCount}` : ''}`, 'open-tasks'),
        commandItem(text.settings, 'open-settings'),
        { type: 'separator' },
        { label: menuState.hasRunningTask ? text.running : text.idle, enabled: false }
      ]
    },
    {
      label: text.window, submenu: [
        { role: 'minimize', label: '最小化' },
        { role: 'zoom', label: '缩放' },
        ...(process.platform === 'darwin' ? [{ role: 'front' as const, label: '置于最前' }] : [])
      ]
    },
    {
      label: text.help, submenu: [
        commandItem(text.shortcuts, 'show-shortcuts'),
        { role: 'about', label: '关于 PhotoAllIsAI' }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

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
  },
  {
    scheme: 'photovideo',
    privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true }
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

let exifIndexRunning = false;
const dimensionIndexPending = new Set<string>();
let dimensionIndexRunning = false;
function scheduleVisibleDimensions(ids: readonly string[]): void {
  for (const id of ids) dimensionIndexPending.add(id);
  if (dimensionIndexRunning || dimensionIndexPending.size === 0) return;
  dimensionIndexRunning = true;
  setImmediate(() => {
    void (async () => {
      while (dimensionIndexPending.size > 0 && !shuttingDown) {
        const ids = [...dimensionIndexPending].slice(0, 8);
        for (const id of ids) dimensionIndexPending.delete(id);
        await Promise.allSettled(ids.map(async (id) => {
          if (!catalog.hasCurrentDimensions(id)) catalog.saveExifDetails(id, await imageFiles.details(id));
        }));
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    })().finally(() => { dimensionIndexRunning = false; });
  });
}
function scheduleSmartCollectionExifIndex(): void {
  if (exifIndexRunning || !catalog.hasExifSmartCollections()) return;
  exifIndexRunning = true;
  setImmediate(() => {
    void (async () => {
      let afterId = '';
      try {
        for (;;) {
          const ids = catalog.listExifIndexCandidates(8, afterId);
          if (!ids.length) break;
          afterId = ids.at(-1)!;
          await Promise.allSettled(ids.map(async (id) => {
            const details = await imageFiles.details(id);
            catalog.saveExifDetails(id, details);
          }));
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
      } finally { exifIndexRunning = false; }
    })().catch(() => { exifIndexRunning = false; });
  });
}

function registerIpc(): void {
  const importExternalMedia = async (input: unknown, fromClipboard: boolean): Promise<number> => {
    if (!input || typeof input !== 'object') throw new Error('INVALID_MEDIA_IMPORT');
    const { paths, targetFolderId } = input as { paths?: unknown; targetFolderId?: unknown };
    if (targetFolderId !== null && targetFolderId !== undefined && (typeof targetFolderId !== 'string' || !/^[a-f0-9]{32}$/u.test(targetFolderId))) throw new Error('INVALID_FOLDER_ID');
    if (paths !== undefined && (!Array.isArray(paths) || paths.length > 1000 || !paths.every((item) => typeof item === 'string' && isAbsolute(item) && !item.includes('\0')))) throw new Error('INVALID_MEDIA_PATHS');
    const sourcePaths = fromClipboard ? readFilesFromClipboard() : paths as string[];
    const folder = targetFolderId ? catalog.listFolders().find((item) => item.id === targetFolderId) : null;
    if (targetFolderId && !folder) throw new Error('CATALOG_FOLDER_NOT_FOUND');
    const directory = folder ? catalog.resolveFolderPath(folder.id)! : join(app.getPath('userData'), 'Imported Media');
    await mkdir(directory, { recursive: true });
    const destination = await realpath(directory);
    const copied: string[] = [];
    const nameFor = (name: string, index: number) => {
      const extension = extname(name);
      return index === 1 ? name : `${name.slice(0, -extension.length || undefined)} (${index})${extension}`;
    };
    for (const requestedPath of [...new Set(sourcePaths)]) {
      const source = await realpath(requestedPath).catch(() => null);
      if (!source || !isSupportedBrowseMedia(source) || !(await stat(source)).isFile()) continue;
      for (let index = 1; ; index += 1) {
        const target = join(destination, nameFor(basename(source), index));
        try {
          await copyFile(source, target, fsConstants.COPYFILE_EXCL);
          copied.push(target);
          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        }
      }
    }
    if (fromClipboard && sourcePaths.length === 0) {
      const image = clipboard.readImage();
      if (!image.isEmpty()) {
        const name = `Clipboard image ${new Date().toISOString().replace(/[:.]/gu, '-')}.png`;
        for (let index = 1; ; index += 1) {
          const target = join(destination, nameFor(name, index));
          try {
            await writeFile(target, image.toPNG(), { flag: 'wx' });
            copied.push(target);
            break;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
          }
        }
      }
    }
    if (copied.length === 0) return 0;
    if (!folder) await catalog.importFolders([destination]);
    else {
      const root = catalog.resolveFolderPath(folder.rootId)!;
      for (const filePath of copied) await catalog.synchronizeImportedFile(root, relative(root, filePath));
    }
    catalogWatcher.watchFolders(catalog.listFolderPaths());
    return copied.length;
  };
  ipcMain.handle('catalog.media.import.v1', (_event, input: unknown) => importExternalMedia(input, false));
  ipcMain.handle('catalog.media.paste.v1', (_event, input: unknown) => importExternalMedia(input, true));
  ipcMain.handle('image.details.v1', async (_event, id: unknown) => {
    const assetId = validateImageId(id);
    const details = fileDetailsSchema.parse(await imageFiles.details(assetId));
    catalog.saveExifDetails(assetId, details);
    return details;
  });
  ipcMain.handle('image.details.page.v1', async (_event, rawIds: unknown) => {
    const ids = fileDetailsPageInputSchema.parse(rawIds);
    const details: Record<string, Awaited<ReturnType<typeof imageFiles.details>> | null> = {};
    for (let offset = 0; offset < ids.length; offset += 6) {
      const entries = await Promise.all(ids.slice(offset, offset + 6).map(async (id) =>
        [id, await imageFiles.details(id).then((item) => { catalog.saveExifDetails(id, item); return item; }).catch(() => null)] as const));
      Object.assign(details, Object.fromEntries(entries));
    }
    return fileDetailsPageSchema.parse(details);
  });
  ipcMain.handle('image.open-external.v1', async (_event, id: unknown) => {
    const source = imageFiles.resolve(validateImageId(id));
    if (!source || !existsSync(source)) throw new Error('图片文件已移动或不可访问');
    const error = await shell.openPath(source);
    if (error) throw new Error(error);
  });
  ipcMain.handle('image.link-directory.v1', async (_event, id: unknown) => {
    const source = imageFiles.resolve(validateImageId(id));
    if (!source || !existsSync(source)) throw new Error('图片文件已移动或不可访问');
    await catalog.importFolders([dirname(source)]);
    catalogWatcher.watchFolders(catalog.listFolderPaths());
    for (const window of BrowserWindow.getAllWindows()) window.webContents.send('catalog.changed.v1');
  });
  ipcMain.handle('image.open.v1', async (_event, paths: unknown) => {
    if (paths === undefined) return openImageDialog(false);
    if (!Array.isArray(paths) || paths.length === 0 || paths.length > 1000 || !paths.every((item) => typeof item === 'string' && isAbsolute(item) && !item.includes('\0'))) throw new Error('INVALID_IMAGE_PATHS');
    return openImagePaths(paths, false);
  });
  ipcMain.handle('image.pending.v1', () => { const session = pendingOpenSession; pendingOpenSession = null; return session; });
  ipcMain.handle('image.temporary.page.v1', (_event, input: unknown) => {
    const { sessionId, offset, limit, selectedId } = temporaryMediaPageInputSchema.parse(input);
    return imageFiles.pageTemporary(sessionId, offset, limit, selectedId);
  });
  ipcMain.handle('file-workflow.config.get.v1', () => fileWorkflows.get());
  ipcMain.handle('file-workflow.config.save.v1', async (_event, input: unknown) => {
    const saved = await fileWorkflows.save(fileWorkflowConfigSchema.parse(input));
    for (const window of BrowserWindow.getAllWindows()) window.webContents.send('catalog.changed.v1');
    return saved;
  });
  ipcMain.handle('file-workflow.preview.v1', (_event, input: unknown) => {
    const parsed = previewFileWorkflowInputSchema.parse(input);
    return fileWorkflows.page({ folderId: parsed.folderId, albumId: parsed.albumId, limit: 100 }, parsed.config);
  });
  ipcMain.on('menu.state.update.v1', (_event, input: unknown) => {
    try {
      menuState = menuStateSchema.parse(input);
      buildApplicationMenu();
    } catch {
      // Menu state is advisory; an invalid update must not interrupt the renderer.
    }
  });
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
    appLocale = saved.locale;
    buildApplicationMenu();
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
  ipcMain.handle('catalog.assets.page.v1', async (_event, input: unknown) => {
    const page = await fileWorkflows.page(listCatalogAssetsInputSchema.parse(input));
    scheduleVisibleDimensions(page.items.filter((item) => !item.width || !item.height).map((item) => item.id));
    return page;
  });
  ipcMain.handle('catalog.folders.list.v1', () => catalog.listFolders());
  ipcMain.handle('catalog.tags.list.v1', () => catalog.listTags());
  ipcMain.handle('catalog.tags.delete.v1', (_event, input: unknown) => {
    catalog.deleteTag(deleteCatalogTagInputSchema.parse(input));
  });
  ipcMain.handle('catalog.albums.list.v1', () => catalog.listAlbums());
  ipcMain.handle('catalog.smart-collections.list.v1', () => { scheduleSmartCollectionExifIndex(); return catalog.listSmartCollections(); });
  ipcMain.handle('catalog.smart-collection.save.v1', (_event, input: unknown) => {
    const saved = catalogSmartCollectionSchema.parse(catalog.saveSmartCollection(saveSmartCollectionInputSchema.parse(input)));
    scheduleSmartCollectionExifIndex();
    return saved;
  });
  ipcMain.handle('catalog.smart-collection.delete.v1', (_event, input: unknown) => catalog.deleteSmartCollection(String(input)));
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
  ipcMain.handle('catalog.metadata.update.v1', (_event, input: unknown) => {
    const updated = catalog.updateMetadata(updateCatalogMetadataInputSchema.parse(input));
    for (const window of BrowserWindow.getAllWindows()) window.webContents.send('catalog.changed.v1', updated);
    return updated;
  });
  const lightroomImport = new LightroomImportService(catalog);
  let lightroomCatalogName = '';
  let lightroomSelectionToken = '';
  ipcMain.handle('lightroom.catalog.choose.v1', async () => {
    const selection = await dialog.showOpenDialog({
      title: '选择 Lightroom Classic 目录',
      properties: ['openFile'],
      filters: [{ name: 'Lightroom Classic 目录', extensions: ['lrcat'] }]
    });
    if (selection.canceled || !selection.filePaths[0]) return null;
    const selected = selection.filePaths[0];
    if (extname(selected).toLowerCase() !== '.lrcat') throw new Error('请选择 .lrcat 文件');
    const roots = lightroomImport.select(selected);
    lightroomCatalogName = basename(selected);
    lightroomSelectionToken = randomUUID();
    return { token: lightroomSelectionToken, catalogName: lightroomCatalogName, sourceRoots: roots };
  });
  ipcMain.handle('lightroom.target.choose.v1', async () => {
    const selection = await dialog.showOpenDialog({ title: '选择当前照片目录', properties: ['openDirectory'] });
    return selection.canceled ? null : selection.filePaths[0] ?? null;
  });
  ipcMain.handle('lightroom.import.preview.v1', (_event, input: unknown) => {
    const raw = input as { token?: unknown };
    if (raw?.token !== lightroomSelectionToken || !lightroomCatalogName) throw new Error('请先选择 Lightroom 目录');
    return lightroomImport.preview({ ...lightroomImportOptionsSchema.parse(raw), catalogName: lightroomCatalogName });
  });
  ipcMain.handle('lightroom.import.apply.v1', (_event, token: unknown) => {
    if (typeof token !== 'string') throw new Error('导入预览已失效');
    const result = lightroomImport.apply(token);
    if (result.updated) for (const window of BrowserWindow.getAllWindows()) window.webContents.send('catalog.changed.v1');
    return result;
  });
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
  const resolveDisplayedPaths = (input: unknown): string[] => {
    const { items } = copyDisplayedFilesInputSchema.parse(input);
    const paths = items.map((item) => item.kind === 'asset'
      ? catalog.resolveAssetFile(item.assetId)?.path
      : generation.resolveResultFile(item.resultId));
    if (paths.some((filePath) => {
      try { return !filePath || !statSync(filePath).isFile(); } catch { return true; }
    })) {
      throw new Error('COPY_FILE_NOT_FOUND');
    }
    return [...new Set(paths as string[])];
  };
  ipcMain.handle('catalog.files.clipboard.v1', (_event, input: unknown) => {
    const paths = resolveDisplayedPaths(input);
    writeFilesToClipboard(paths);
    return paths.length;
  });
  ipcMain.handle('catalog.image.clipboard.v1', (_event, input: unknown) => {
    const paths = resolveDisplayedPaths(input);
    if (paths.length !== 1) throw new Error('COPY_IMAGE_REQUIRES_ONE_FILE');
    const image = nativeImage.createFromPath(paths[0]!);
    if (image.isEmpty()) throw new Error('COPY_IMAGE_UNSUPPORTED_FORMAT');
    clipboard.writeImage(image);
  });
  ipcMain.on('catalog.files.drag.v1', (event, input: unknown) => {
    try {
      const paths = resolveDisplayedPaths(input);
      event.sender.startDrag({ file: paths[0]!, files: paths, icon: nativeImage.createEmpty() });
    } catch { /* A missing file cannot be dragged. */ }
  });
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
    const previousPath = catalog.resolveFolderPath(folderId);
    const result = await dialog.showOpenDialog({
      title: '重新定位照片文件夹',
      buttonLabel: '选择新位置',
      ...(previousPath ? { defaultPath: dirname(previousPath) } : {}),
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
    const report = await catalog.synchronizeFolder(folderId);
    await Promise.allSettled(catalog.takeExternalRelocations().map((item) => generation.relocatePortableResults(
      item.assetId, item.previousPath, item.nextPath, item.previousFileName, item.nextFileName
    )));
    return catalogFolderSyncReportSchema.parse(report);
  });
  ipcMain.handle('catalog.folder.reveal.v1', (_event, input: unknown) => {
    const folderId = String(input);
    if (!/^[a-f0-9]{32}$/u.test(folderId)) throw new Error('INVALID_FOLDER_ID');
    const folderPath = catalog.resolveFolderPath(folderId);
    if (!folderPath || !existsSync(folderPath)) return false;
    shell.showItemInFolder(folderPath);
    return true;
  });
  ipcMain.handle('catalog.folder.rename.v1', async (_event, input: unknown) => {
    const report = await catalog.renameFolder(renameCatalogFolderInputSchema.parse(input));
    await Promise.allSettled(report.relocations.map((item) => generation.relocatePortableResults(
      item.assetId, item.previousPath, item.nextPath, item.previousFileName, item.nextFileName
    )));
    catalogWatcher.watchFolders(catalog.listFolderPaths());
    return renameCatalogFolderResultSchema.parse(report);
  });
  ipcMain.handle('catalog.folder.create.v1', async (_event, input: unknown) =>
    renameCatalogFolderResultSchema.parse(await catalog.createFolder(createCatalogFolderInputSchema.parse(input)))
  );
  ipcMain.handle('catalog.folder.move.v1', async (_event, input: unknown) => {
    const report = await catalog.moveFolder(moveCatalogFolderInputSchema.parse(input));
    await Promise.allSettled(report.relocations.map((item) => generation.relocatePortableResults(
      item.assetId,
      item.previousPath,
      item.nextPath,
      item.previousFileName,
      item.nextFileName
    )));
    catalogWatcher.watchFolders(catalog.listFolderPaths());
    return moveCatalogFolderResultSchema.parse(report);
  });
  ipcMain.handle('catalog.folder.unregister.v1', (_event, input: unknown) => {
    const report = catalog.unregisterFolder(unregisterCatalogFolderInputSchema.parse(input).folderId);
    catalogWatcher.watchFolders(catalog.listFolderPaths());
    return unregisterCatalogFolderReportSchema.parse(report);
  });
  ipcMain.handle('catalog.folder.trash.v1', async (_event, input: unknown) => {
    const folderId = String(input);
    if (!/^[a-f0-9]{32}$/u.test(folderId)) throw new Error('INVALID_FOLDER_ID');
    await catalog.trashFolder(folderId, (folderPath) => shell.trashItem(folderPath));
    catalogWatcher.watchFolders(catalog.listFolderPaths());
  });
  ipcMain.handle('catalog.asset.reveal.v1', (_event, input: unknown) => {
    const assetId = String(input);
    if (!/^[0-9a-f-]{20,40}$/iu.test(assetId)) throw new Error('INVALID_ASSET_ID');
    const source = imageFiles.resolve(assetId);
    if (!source || !existsSync(source)) return false;
    shell.showItemInFolder(source);
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
    return { ...page, items: page.items.map((task) => ({
      ...toRendererTask(task),
      ...(task.assetId ? { assetFileName: catalog.resolveAssetFile(task.assetId)?.fileName } : {})
    })) };
  });
  ipcMain.handle('tasks.batch.v1', (_event, input: unknown) => {
    const { kind, batchId } = taskBatchInputSchema.parse(input);
    return tasks.listBatch(kind, batchId).map((task) => ({ ...toRendererTask(task),
      ...(task.assetId ? { assetFileName: catalog.resolveAssetFile(task.assetId)?.fileName } : {}) }));
  });
  ipcMain.handle('tasks.get.v1', (_event, taskId: unknown) => {
    const task = tasks.find(taskIdSchema.parse(taskId));
    return task ? toRendererTask(task) : null;
  });
  ipcMain.handle('agent.sessions.create.v1', (_event, input: unknown) => agentRuntime.create(createAgentSessionSchema.parse(input).assetIds));
  ipcMain.handle('agent.sessions.list.v1', () => agentRuntime.list());
  ipcMain.handle('agent.mcp.status.v1', () => agentMcp.status());
  ipcMain.handle('agent.mcp.enable.v1', (_event, enabled: unknown) => {
    if (typeof enabled !== 'boolean') throw new Error('INVALID_MCP_ENABLED');
    return agentMcp.setEnabled(enabled);
  });
  ipcMain.handle('agent.sessions.get.v1', (_event, id: unknown) => agentRuntime.get(agentSessionIdSchema.parse(id)));
  ipcMain.handle('agent.sessions.delete.v1', (_event, id: unknown) => { agentRuntime.delete(agentSessionIdSchema.parse(id)); });
  ipcMain.handle('agent.sessions.send.v1', (_event, input: unknown) => { const value = agentSendSchema.parse(input); return agentRuntime.send(value.sessionId, value.text, value.assetIds); });
  ipcMain.handle('agent.sessions.control.v1', (_event, input: unknown) => { const value = agentControlSchema.parse(input); return agentRuntime.control(value.sessionId, value.action, value.callId); });
  ipcMain.handle('tasks.enqueue.v1', async (_event, input: unknown) => {
    const parsed = enqueueTaskInputSchema.parse(input);
    if (parsed.kind === 'agent') throw new Error('请使用 Agent 会话安排任务。');
    if (parsed.kind === 'export') throw new Error('EXPORT_TASK_REQUIRES_DIRECTORY_SELECTION');
    if (parsed.kind === 'analysis' || parsed.kind === 'collection-analysis') {
      parsed.payload.locale ??= (await appSettings.get()).locale;
    }
    const task = tasks.enqueue(parsed);
    taskRunner.wake();
    return toRendererTask(task);
  });
  ipcMain.handle('tasks.cancel.v1', (_event, taskId: unknown) => {
    const id = taskIdSchema.parse(taskId);
    taskRunner.cancel(id);
    return toRendererTask(tasks.cancel(id));
  });
  ipcMain.handle('tasks.delete.v1', async (_event, rawInput: unknown) => {
    const input = deleteTasksInputSchema.parse(rawInput);
    const targets = tasks.deletionTargets(input);
    if (!targets.length) return { deletedIds: [] };
    const running = targets.filter((task) => ['preparing', 'uploading', 'processing', 'downloading', 'saving'].includes(task.status));
    if (running.length || targets.length > 1 || input.scope !== 'task') {
      const confirmation = await dialog.showMessageBox({
        type: 'question', title: '删除任务',
        message: `删除 ${targets.length} 条任务？`,
        detail: `${running.length ? `其中 ${running.length} 条正在执行，将停止处理。\n` : ''}仅删除任务记录，保留原图、分析结果和已生成的文件。`,
        buttons: ['取消', '删除'], defaultId: 0, cancelId: 0, noLink: true
      });
      if (confirmation.response !== 1) return { deletedIds: [] };
    }
    for (const task of targets) taskRunner.cancel(task.id);
    return { deletedIds: tasks.deleteTasks(targets.map((task) => task.id)) };
  });
  ipcMain.handle('tasks.batch.action.v1', (_event, rawInput: unknown) => {
    const input = taskBatchActionInputSchema.parse(rawInput);
    const eligible = {
      retry: ['failed', 'canceled'], pause: ['queued', 'preparing', 'uploading', 'processing', 'downloading'],
      resume: ['paused'], cancel: ['draft', 'queued', 'paused', 'preparing', 'uploading', 'processing', 'downloading']
    }[input.action];
    const targets = tasks.batchForTask(input.taskId).filter((task) => eligible.includes(task.status)
      && !(input.action === 'retry' && task.errorCode === 'GENERATION_RESULT_UNCERTAIN'));
    for (const task of targets) {
      tasks[input.action](task.id);
      if (input.action === 'pause' || input.action === 'cancel') taskRunner.cancel(task.id);
    }
    if (input.action === 'retry' || input.action === 'resume') taskRunner.wake();
    return targets.length;
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
  ipcMain.handle('tasks.retry-all-failed.v1', () => {
    const failed = tasks.list().filter((task) => task.status === 'failed' && task.errorCode !== 'GENERATION_RESULT_UNCERTAIN');
    for (const task of failed) tasks.retry(task.id);
    if (failed.length) taskRunner.wake();
    return failed.length;
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
    if (shuttingDown) return [];
    return generation.list(assetId);
  });
  ipcMain.handle('generation.results.trash.list.v1', (_event, input: unknown) => {
    const { assetId } = listGenerationResultsInputSchema.parse(input);
    if (shuttingDown) return [];
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
  ipcMain.handle('generation.result.details.v1', async (_event, input: unknown) => {
    const { resultId } = generationResultIdInputSchema.parse({ resultId: input });
    const filePath = generation.resolveResultFile(resultId);
    if (!filePath) throw new Error('生成版本不可用');
    const metadata = await stat(filePath);
    if (!metadata.isFile()) throw new Error('生成文件不可用');
    const dimensions = await imageSizeFromFile(filePath).catch(() => null);
    return fileDetailsSchema.parse({ path: filePath, sizeBytes: metadata.size, modifiedAt: metadata.mtimeMs,
      ...(dimensions?.width && dimensions.height ? { width: dimensions.width, height: dimensions.height } : {}) });
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
  ipcMain.handle('cache.folder.clear.v1', async (_event, folderId: unknown) => {
    if (typeof folderId !== 'string' || !folderId) throw new Error('FOLDER_NOT_FOUND');
    return imageCache.clearAssets(catalog.listAssetIdsInFolder(folderId));
  });
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    title: 'PhotoAllIsAI',
    width: 1480,
    height: 940,
    minWidth: 1080,
    minHeight: 700,
    backgroundColor: '#111311',
    show: false,
    ...getWindowChromeOptions(process.platform),
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  // Electron 37's visibilityChanged listener calls isVisible() after the native
  // window may have been destroyed by a late show/hide event.
  const visibilityChanged = window.listeners('show').find((listener) => listener.name === 'visibilityChanged');
  if (visibilityChanged) {
    const emitter = window as unknown as EventEmitter;
    const guardVisibility = () => {
      if (!window.isDestroyed() && !window.webContents.isDestroyed()) visibilityChanged();
    };
    for (const eventName of ['show', 'hide', 'minimize', 'maximize', 'restore']) {
      emitter.removeListener(eventName, visibilityChanged as (...args: unknown[]) => void);
      emitter.on(eventName, guardVisibility);
    }
  }
  let closing = false;

  window.webContents.setWindowOpenHandler(({ url }) => {
    const parsed = new URL(url);
    if (parsed.protocol === 'https:') void shell.openExternal(url);
    return { action: 'deny' };
  });

  window.on('focus', () => catalogWatcher?.refresh());

  window.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    console.error(`[renderer] failed to load ${validatedURL}: ${errorCode} ${errorDescription}`);
    if (!window.isDestroyed()) {
      void window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html><html><body style="margin:0;background:#111311;color:#d9ded2;font:14px system-ui;padding:32px"><h2>PhotoAllIsAI 无法加载</h2><p>渲染页面加载失败，请重新启动应用。</p><small>${errorCode} ${errorDescription}</small></body></html>`)}`);
    }
  });
  window.webContents.on('render-process-gone', (_event, details) => {
    console.error(`[renderer] process gone: ${details.reason}`);
  });

  window.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(APP_ORIGIN) && !process.env.ELECTRON_RENDERER_URL) event.preventDefault();
  });

  window.once('ready-to-show', () => {
    if (!closing && !window.isDestroyed() && !shuttingDown) {
      window.show();
      window.focus();
    }
  });
  window.on('close', () => {
    closing = true;
  });
  window.on('closed', () => {
    if (mainWindow === window) {
      mainWindow = null;
    }
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

const customUserData = process.env.PHOTOALLISAI_USER_DATA;
if (customUserData) app.setPath('userData', customUserData);

const hasLock = app.requestSingleInstanceLock();
if (!hasLock) app.exit(0);

function showMainWindow(): void {
  if (!startupReady || shuttingDown) return;
  if (!mainWindow || mainWindow.isDestroyed()) {
    mainWindow = createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

// Register before async startup so Dock and second-instance events are never lost.
app.on('open-file', (event, file) => {
  event.preventDefault();
  if (startupReady) void openImagePaths([file]).catch(reportOpenFailure);
  else pendingOpenPaths.push(file);
});
app.on('second-instance', (_event, argv) => {
  showMainWindow();
  const paths = argv.filter((arg) => isAbsolute(arg) && isSupportedBrowseMedia(arg));
  if (paths.length) {
    if (startupReady) void openImagePaths(paths).catch(reportOpenFailure);
    else pendingOpenPaths.push(...paths);
  }
});
app.on('activate', showMainWindow);

let startupStage = '准备启动';
const startupStartedAt = performance.now();
let startupStageStartedAt = startupStartedAt;
function traceCrash(phase: string): void {
  if (process.env.PHOTOALLISAI_CRASH_TRACE !== '1') return;
  try {
    const logPath = join(app.getPath('userData'), 'logs', 'crash-trace.log');
    mkdirSync(dirname(logPath), { recursive: true });
    appendFileSync(logPath, `${new Date().toISOString()} pid=${process.pid} ${phase}\n`);
  } catch { /* Diagnostics must not change shutdown behavior. */ }
}
function enterStartupStage(stage: string): void {
  if (process.env.PHOTOALLISAI_STARTUP_TRACE === '1') {
    try {
      const logPath = join(app.getPath('userData'), 'logs', 'startup-timing.log');
      mkdirSync(dirname(logPath), { recursive: true });
      appendFileSync(logPath, `${new Date().toISOString()} ${startupStage} ${Math.round(performance.now() - startupStageStartedAt)}ms total=${Math.round(performance.now() - startupStartedAt)}ms\n`);
    } catch { /* Diagnostics must never block startup. */ }
  }
  startupStage = stage;
  startupStageStartedAt = performance.now();
}
app.whenReady().then(async () => {
  if (!hasLock) return;
  enterStartupStage('检查待恢复图库');
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
  enterStartupStage('检查数据库与迁移');
  const migration = new DatabaseMigrationService(databasePath);
  const migrationCheckpoint = await migration.prepare(APPLICATION_SCHEMA_VERSION);
  enterStartupStage('读取工作区与设置');
  workspace = new WorkspaceService(databasePath);
  appSettings = new AppSettingsService(join(app.getPath('userData'), 'settings', 'app.json'));
  const initialAppSettings = await appSettings.get();
  appLocale = initialAppSettings.locale;
  databaseBackup = new DatabaseBackupService(databasePath);
  enterStartupStage('初始化图库');
  catalog = new CatalogService(databasePath);
  temporaryMediaIndex = new TemporaryMediaIndex();
  imageFiles = new ImageFileService(catalog, temporaryMediaIndex);
  fileWorkflows = new FileWorkflowService(join(app.getPath('userData'), 'settings', 'file-workflows.json'), catalog);
  enterStartupStage('准备关联文件夹监听');
  catalogWatcher = new CatalogWatcher(catalog, { onChanged: async () => {
    await Promise.allSettled(catalog.takeExternalRelocations().map((item) => generation.relocatePortableResults(
      item.assetId, item.previousPath, item.nextPath, item.previousFileName, item.nextFileName
    )));
    for (const window of BrowserWindow.getAllWindows()) window.webContents.send('catalog.changed.v1');
  } });
  enterStartupStage('初始化文件操作与任务');
  fileOperations = new FileOperationService(databasePath, undefined, {
    trashItem: (filePath) => shell.trashItem(filePath)
  }, process.platform, catalog);
  tasks = new TaskService(databasePath);
  templates = new TemplateService(databasePath);
  imageCache = new ImageCacheService(
    join(app.getPath('userData'), 'cache', 'images'), catalog, undefined, initialAppSettings.cacheMaxBytes
  );
  await imageCache.cleanupTemporaryFiles();
  void imageCache.prune(initialAppSettings.cacheMaxBytes);
  enterStartupStage('初始化模型服务');
  providers = new ProviderService(join(app.getPath('userData'), 'settings', 'providers.json'), {
    available: () => safeStorage.isEncryptionAvailable(),
    encrypt: (value) => safeStorage.encryptString(value).toString('base64'),
    decrypt: (value) => safeStorage.decryptString(Buffer.from(value, 'base64'))
  });
  analysis = new AnalysisService(databasePath, providers, imageCache, async () => (await appSettings.get()).locale);
  generation = new GenerationService(
    databasePath,
    join(libraryDirectory, 'generated'),
    providers,
    imageCache,
    catalog
  );
  catalogWatcher.watchFolders(catalog.listFolderPaths());
  enterStartupStage('恢复中断的文件操作');
  const trashPurges = await generation.recoverInterruptedTrashPurges();
  const recoveredFileOperations = await fileOperations.recoverInterruptedOperations(async (change) => {
    await generation.relocatePortableResults(
      change.assetId, change.previousPath, change.path, change.previousFileName, change.fileName
    );
  });
  const generationWrites = await generation.recoverInterruptedWrites();
  for (const taskId of tasks.uncertainGenerationTaskIds()) {
    const committed = await generation.findCommittedTaskResult(taskId);
    if (committed) tasks.recoverCommittedGeneration(taskId, committed);
  }
  startupRecovery = {
    trashPurges,
    fileOperations: recoveredFileOperations,
    generationWrites,
    automaticBackup: { status: 'pending' as AutomaticBackupStatus }
  };
  libraryIntegrity = new LibraryIntegrityService(databasePath, join(libraryDirectory, 'generated'));
  exportService = new ExportService(databasePath, generation);
  exportPresets = new ExportPresetService(databasePath);
  enterStartupStage('完成数据库迁移');
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
        taskId,
        (progress) => tasks.reportProgress(taskId, progress.total ? (progress.succeeded + progress.failed) / progress.total : 0, progress)
      );
      signal?.throwIfAborted();
      return report;
    }
  }, new AgentProcessor({ catalog: { listAssets: catalog.listAssets.bind(catalog), updateMetadata: catalog.updateMetadata.bind(catalog), updateTags: catalog.updateTags.bind(catalog), removeFromCatalog: (input) => fileOperations.removeFromCatalog(input) }, files: { move: (input) => fileOperations.move(input) }, generation, providers }));
  enterStartupStage('初始化 Agent');
  const agentVision = new AgentVision(providers, imageCache, generation);
  const agentChanged = () => { for (const window of BrowserWindow.getAllWindows()) window.webContents.send('catalog.changed.v1'); };
  const agentTools = [...createAgentTools({
    catalog, providers, analysis, generation, files: fileOperations, tasks,
    inspect: (input, signal) => agentVision.inspect(input, signal),
    wake: () => taskRunner.wake(),
    changed: agentChanged
  }), ...createAgentAppTools({ catalog, generation, files: fileOperations, workflows: fileWorkflows, tasks, wake: () => taskRunner.wake(), changed: agentChanged }),
  ...createAgentProgramTools({ catalog, generation, files: fileOperations, tasks, templates, exportPresets, settings: appSettings,
    wake: () => taskRunner.wake(), cancelTask: (id) => taskRunner.cancel(id), changed: agentChanged,
    watchFolders: () => catalogWatcher.watchFolders(catalog.listFolderPaths()), diagnostics: createDiagnosticSnapshot,
    relocate: relocatePortableAfterFileOperation,
    settingsChanged: async () => { const settings = await appSettings.get(); appLocale = settings.locale; buildApplicationMenu(); await imageCache.setMaxBytes(settings.cacheMaxBytes); }
  })].map((tool) => {
    if (!['files.move', 'files.rename', 'files.rename-many', 'files.undo'].includes(tool.name)) return tool;
    const execute = tool.execute;
    return { ...tool, execute: async (args: unknown, context: Parameters<typeof execute>[1]) => {
      const ids = tool.name === 'files.undo' ? fileOperations.getUndoAssetIds(String((args as { operationId: string }).operationId)) : context.session.assetIds;
      const before = new Map(ids.map((id) => [id, catalog.resolveAssetFile(id)]));
      try { return await execute(args, context); }
      finally {
        for (const [id, previous] of before) await relocatePortableAfterFileOperation(id, previous);
        agentChanged();
      }
    } };
  });
  agentRuntime = new AgentRuntime(new AgentStore(databasePath), new ProviderAgentModel(providers), agentTools, (id) => { const task = tasks.find(id); if (task && !['completed', 'failed', 'canceled'].includes(task.status)) { tasks.cancel(id); taskRunner.cancel(id); } });
  agentMcp = new AgentMcpServer(agentRuntime, async (session, kind, id) => {
    const allowed = kind === 'original' ? session.assetIds.includes(id) : session.assetIds.some((assetId) => generation.list(assetId).some((r) => r.id === id));
    if (!allowed) throw new Error('图片超出会话范围');
    return agentVision.preview(id, kind);
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

  enterStartupStage('注册图片协议');
  const activePreviewRequests = new Map<string, AbortController>();
  const canceledPreviewRequests = new Map<string, number>();
  const validPreviewRequestId = (id: unknown): id is string => typeof id === 'string' && /^[0-9a-f-]{36}$/i.test(id);
  ipcMain.on('image.preview.cancel.v1', (_event, id: unknown) => {
    if (!validPreviewRequestId(id)) return;
    const active = activePreviewRequests.get(id);
    if (active) { active.abort(); return; }
    const now = Date.now();
    canceledPreviewRequests.set(id, now);
    for (const [key, at] of canceledPreviewRequests) {
      if (now - at > 5_000) canceledPreviewRequests.delete(key);
    }
    while (canceledPreviewRequests.size > 1_024) canceledPreviewRequests.delete(canceledPreviewRequests.keys().next().value!);
  });
  protocol.handle('photoasset', async (request) => {
    if (shuttingDown) return new Response('Shutting down', { status: 503 });
    const url = new URL(request.url);
    if (!['thumbnail', 'medium', 'preview', 'original', 'temporary', 'temporary-thumbnail'].includes(url.host)) {
      return new Response('Not found', { status: 404 });
    }
    const assetId = url.pathname.slice(1);
    if (url.host === 'temporary-thumbnail') traceCrash(`thumbnail-start ${assetId}`);
    if (!/^[0-9a-f-]{20,40}$/i.test(assetId)) return new Response('Invalid asset', { status: 400 });
    const requestId = url.searchParams.get('requestId');
    const controller = validPreviewRequestId(requestId) ? new AbortController() : null;
    if (controller && requestId) {
      activePreviewRequests.set(requestId, controller);
      if (canceledPreviewRequests.delete(requestId) || request.signal.aborted) controller.abort();
    }
    const onAbort = () => controller?.abort();
    if (controller) request.signal.addEventListener('abort', onAbort, { once: true });
    const signal = controller?.signal ?? request.signal;

    try {
      if (url.host === 'original' || url.host === 'temporary' || url.host === 'temporary-thumbnail') {
        const source = imageFiles.resolve(assetId);
        if (!source) return new Response('Not found', { status: 404 });
        if (url.host !== 'temporary-thumbnail' && isDirectPreviewImage(source)) return net.fetch(pathToFileURL(source).toString());
        if (url.host === 'original') return new Response('Original decoding unavailable', { status: 415 });
        const metadata = await stat(source);
        const preview = await imageCache.getOrCreate(assetId, url.host === 'temporary-thumbnail' ? 'thumbnail' : 'preview', { path: source, modifiedAt: metadata.mtimeMs, sizeBytes: metadata.size }, url.searchParams.get('priority') === 'visible' ? 'visible' : undefined, signal);
        if (url.host === 'temporary-thumbnail') traceCrash(`thumbnail-done ${assetId}`);
        return preview ? net.fetch(pathToFileURL(preview).toString()) : new Response('Preview unavailable', { status: 422 });
      }
      const imagePath = await imageCache.getOrCreate(assetId, url.host as ImageVariant, undefined, url.searchParams.get('priority') === 'visible' ? 'visible' : undefined, signal);
      if (!imagePath) return new Response('Not found', { status: 404 });
      return net.fetch(pathToFileURL(imagePath).toString());
    } catch {
      return new Response('Preview unavailable', { status: 422 });
    } finally {
      if (controller) request.signal.removeEventListener('abort', onAbort);
      if (requestId && activePreviewRequests.get(requestId) === controller) activePreviewRequests.delete(requestId);
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

  protocol.handle('photovideo', (request) => {
    const url = new URL(request.url);
    if (url.host !== 'temporary') return new Response('Not found', { status: 404 });
    const assetId = url.pathname.slice(1);
    if (!/^[0-9a-f-]{20,40}$/i.test(assetId)) return new Response('Invalid asset', { status: 400 });
    const source = imageFiles.resolve(assetId);
    if (!source || identifyMediaFormat(source)?.kind !== 'video') return new Response('Not found', { status: 404 });
    return net.fetch(pathToFileURL(source).toString(), { headers: request.headers });
  });

  enterStartupStage('注册应用接口');
  registerIpc();
  taskRunner.start();
  startupReady = true;
  enterStartupStage('打开主窗口');
  showMainWindow();
  enterStartupStage('主窗口已创建');
  // Keep the last committed index available immediately. Validation of large
  // imported roots can take minutes on external disks and must not gate UI.
  catalogValidationTimer = setInterval(() => {
    if (!shuttingDown && !tasks.hasActiveTasks()) catalogWatcher.refresh();
  }, 30_000);
  catalogValidationTimer.unref();
  buildApplicationMenu();
  const startupPaths = [...pendingOpenPaths, ...process.argv.filter((arg) => isAbsolute(arg) && isSupportedBrowseMedia(arg))];
  pendingOpenPaths = [];
  if (startupPaths.length) void openImagePaths([...new Set(startupPaths)]).catch(reportOpenFailure);
}).catch((error: unknown) => {
  console.error('[startup] failed to open library', error);
  const logPath = join(app.getPath('userData'), 'logs', 'startup-failure.log');
  const logged = writeStartupFailureLog(logPath, startupStage, error);
  const failure = createStartupFailureDialog(error, startupStage, logged ? logPath : undefined);
  dialog.showErrorBox(failure.title, failure.content);
  app.exit(1);
});

app.on('window-all-closed', () => {
  // A dev window depends on a live Vite server. Do not leave an invisible
  // Electron process holding the lock after closing that development session.
  if (process.platform !== 'darwin' || process.env.ELECTRON_RENDERER_URL) app.quit();
});

app.on('before-quit', (event) => {
  traceCrash('before-quit');
  if (shutdownFinished || !hasLock) return;
  event.preventDefault();
  if (shutdownStarted) return;
  shutdownStarted = true;
  shuttingDown = true;
  traceCrash('shutdown-start');
  // Bound the entire shutdown, including watcher and database cleanup failures.
  const deadline = setTimeout(() => {
    console.error('[shutdown] cleanup timed out; terminating process');
    process.exit(0);
  }, 10_000);
  void (async () => {
    try {
      if (contentHashTimer) clearTimeout(contentHashTimer);
      if (catalogValidationTimer) clearInterval(catalogValidationTimer);
      traceCrash('watcher-stop-start');
      catalogWatcher?.stop();
      traceCrash('watcher-stop-done');
      const result = await settleBeforeShutdown([
        ...(imageCache ? [imageCache.stop().then(() => traceCrash('image-cache-stopped'))] : []),
        ...(taskRunner ? [taskRunner.stop()] : []),
        ...(agentRuntime ? [agentRuntime.stop()] : []),
        ...(agentMcp ? [agentMcp.stop()] : []),
        ...(contentHashPass ? [contentHashPass] : [])
      ], 9_000);
      traceCrash(`services-stop-${result}`);
      if (result === 'timed-out') {
        console.error('[shutdown] service stop timed out; terminating process');
        process.exit(0);
        return;
      }
      for (const [name, service] of Object.entries({ agentRuntime, workspace, generation, exportService, exportPresets, analysis, templates, tasks, fileOperations, catalog })) {
        try {
          traceCrash(`close-${name}-start`);
          service?.close();
          traceCrash(`close-${name}-done`);
        } catch (error) {
          console.error('[shutdown] failed to close service', error);
          traceCrash(`close-${name}-error`);
        }
      }
      temporaryMediaIndex.close();
      traceCrash('temporary-index-close-done');
    } catch (error) {
      console.error('[shutdown] cleanup failed', error);
    } finally {
      shutdownFinished = true;
      clearTimeout(deadline);
      // Quick Look promises must settle before Electron disposes the V8 isolate.
      // A forced process.exit() alone also runs native teardown and is not a fix.
      traceCrash('app-quit');
      app.quit();
    }
  })();
});

// electron-vite terminates its child on restart / Ctrl+C. Use the same cleanup.
process.on('SIGTERM', () => app.quit());
process.on('SIGINT', () => app.quit());
