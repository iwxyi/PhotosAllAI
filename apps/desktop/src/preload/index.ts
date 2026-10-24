import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopApi, MenuCommand } from '@photoallisai/contracts';

const api: DesktopApi = {
  onMenuCommand: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, command: MenuCommand) => listener(command);
    ipcRenderer.on('menu.command.v1', handler);
    return () => ipcRenderer.removeListener('menu.command.v1', handler);
  },
  updateMenuState: (state) => {
    ipcRenderer.send('menu.state.update.v1', state);
  },
  getAppInfo: () => ipcRenderer.invoke('app.info.v1') as ReturnType<DesktopApi['getAppInfo']>,
  getAppSettings: () => ipcRenderer.invoke('app.settings.get.v1') as ReturnType<DesktopApi['getAppSettings']>,
  saveAppSettings: (input) => ipcRenderer.invoke('app.settings.save.v1', input) as ReturnType<DesktopApi['saveAppSettings']>,
  getDiagnosticSnapshot: () => ipcRenderer.invoke('app.diagnostics.v1') as ReturnType<DesktopApi['getDiagnosticSnapshot']>,
  exportDiagnosticSnapshot: () => ipcRenderer.invoke('app.diagnostics.export.v1') as ReturnType<DesktopApi['exportDiagnosticSnapshot']>,
  runLibraryIntegrityCheck: () => ipcRenderer.invoke('app.integrity.scan.v1') as ReturnType<DesktopApi['runLibraryIntegrityCheck']>,
  backupDatabase: () => ipcRenderer.invoke('app.database.backup.v1') as ReturnType<DesktopApi['backupDatabase']>,
  backupLibrary: () => ipcRenderer.invoke('app.library.backup.v1') as ReturnType<DesktopApi['backupLibrary']>,
  verifyLibraryBackup: () => ipcRenderer.invoke('app.library.backup.verify.v1') as ReturnType<DesktopApi['verifyLibraryBackup']>,
  restoreLibraryBackup: () => ipcRenderer.invoke('app.library.restore.v1') as ReturnType<DesktopApi['restoreLibraryBackup']>,
  getWorkspaceSession: () =>
    ipcRenderer.invoke('workspace.session.get.v1') as ReturnType<DesktopApi['getWorkspaceSession']>,
  saveWorkspaceSession: (session) =>
    ipcRenderer.invoke('workspace.session.save.v1', session) as ReturnType<DesktopApi['saveWorkspaceSession']>,
  listCatalogAssets: () =>
    ipcRenderer.invoke('catalog.assets.list.v1') as ReturnType<DesktopApi['listCatalogAssets']>,
  listCatalogAssetPage: (input) =>
    ipcRenderer.invoke('catalog.assets.page.v1', input) as ReturnType<DesktopApi['listCatalogAssetPage']>,
  listCatalogFolders: () =>
    ipcRenderer.invoke('catalog.folders.list.v1') as ReturnType<DesktopApi['listCatalogFolders']>,
  listCatalogTags: () =>
    ipcRenderer.invoke('catalog.tags.list.v1') as ReturnType<DesktopApi['listCatalogTags']>,
  deleteCatalogTag: (tagId) =>
    ipcRenderer.invoke('catalog.tags.delete.v1', tagId) as ReturnType<DesktopApi['deleteCatalogTag']>,
  listCatalogAlbums: () =>
    ipcRenderer.invoke('catalog.albums.list.v1') as ReturnType<DesktopApi['listCatalogAlbums']>,
  listCatalogSmartCollections: () =>
    ipcRenderer.invoke('catalog.smart-collections.list.v1') as ReturnType<DesktopApi['listCatalogSmartCollections']>,
  saveCatalogAlbum: (input) =>
    ipcRenderer.invoke('catalog.album.save.v1', input) as ReturnType<DesktopApi['saveCatalogAlbum']>,
  deleteCatalogAlbum: (albumId) =>
    ipcRenderer.invoke('catalog.album.delete.v1', albumId) as ReturnType<DesktopApi['deleteCatalogAlbum']>,
  updateCatalogAlbumAssets: (input) =>
    ipcRenderer.invoke('catalog.album.assets.update.v1', input) as ReturnType<DesktopApi['updateCatalogAlbumAssets']>,
  updateCatalogMetadata: (input) =>
    ipcRenderer.invoke('catalog.metadata.update.v1', input) as ReturnType<DesktopApi['updateCatalogMetadata']>,
  updateCatalogTags: (input) =>
    ipcRenderer.invoke('catalog.tags.update.v1', input) as ReturnType<DesktopApi['updateCatalogTags']>,
  moveCatalogAssets: (input) =>
    ipcRenderer.invoke('catalog.assets.move.v1', input) as ReturnType<DesktopApi['moveCatalogAssets']>,
  copyCatalogAssets: (input) =>
    ipcRenderer.invoke('catalog.assets.copy.v1', input) as ReturnType<DesktopApi['copyCatalogAssets']>,
  previewCatalogCompanions: (assetIds) =>
    ipcRenderer.invoke('catalog.assets.companions.v1', assetIds) as ReturnType<DesktopApi['previewCatalogCompanions']>,
  renameCatalogAsset: (input) =>
    ipcRenderer.invoke('catalog.asset.rename.v1', input) as ReturnType<DesktopApi['renameCatalogAsset']>,
  renameCatalogAssets: (input) =>
    ipcRenderer.invoke('catalog.assets.rename.v1', input) as ReturnType<DesktopApi['renameCatalogAssets']>,
  removeCatalogAssets: (input) =>
    ipcRenderer.invoke('catalog.assets.remove.v1', input) as ReturnType<DesktopApi['removeCatalogAssets']>,
  trashCatalogAssets: (input) =>
    ipcRenderer.invoke('catalog.assets.trash.v1', input) as ReturnType<DesktopApi['trashCatalogAssets']>,
  listFileOperationHistory: () =>
    ipcRenderer.invoke('files.operations.list.v1') as ReturnType<DesktopApi['listFileOperationHistory']>,
  undoFileOperation: (input) =>
    ipcRenderer.invoke('files.operations.undo.v1', input) as ReturnType<DesktopApi['undoFileOperation']>,
  importFolders: () =>
    ipcRenderer.invoke('catalog.folders.import.v1') as ReturnType<
      DesktopApi['importFolders']
    >,
  relinkCatalogFolder: (folderId) =>
    ipcRenderer.invoke('catalog.folder.relink.v1', folderId) as ReturnType<DesktopApi['relinkCatalogFolder']>,
  renameCatalogFolder: (input) =>
    ipcRenderer.invoke('catalog.folder.rename.v1', input) as ReturnType<DesktopApi['renameCatalogFolder']>,
  moveCatalogFolder: (input) =>
    ipcRenderer.invoke('catalog.folder.move.v1', input) as ReturnType<DesktopApi['moveCatalogFolder']>,
  synchronizeCatalogFolder: (folderId) =>
    ipcRenderer.invoke('catalog.folder.synchronize.v1', folderId) as ReturnType<DesktopApi['synchronizeCatalogFolder']>,
  revealCatalogFolder: (folderId) =>
    ipcRenderer.invoke('catalog.folder.reveal.v1', folderId) as ReturnType<DesktopApi['revealCatalogFolder']>,
  unregisterCatalogFolder: (input) =>
    ipcRenderer.invoke('catalog.folder.unregister.v1', input) as ReturnType<DesktopApi['unregisterCatalogFolder']>,
  revealCatalogAsset: (assetId) =>
    ipcRenderer.invoke('catalog.asset.reveal.v1', assetId) as ReturnType<DesktopApi['revealCatalogAsset']>,
  listProviderProfiles: () =>
    ipcRenderer.invoke('providers.list.v1') as ReturnType<DesktopApi['listProviderProfiles']>,
  saveProviderProfile: (input) =>
    ipcRenderer.invoke('providers.save.v1', input) as ReturnType<DesktopApi['saveProviderProfile']>,
  deleteProviderProfile: (profileId) =>
    ipcRenderer.invoke('providers.delete.v1', profileId) as ReturnType<DesktopApi['deleteProviderProfile']>,
  testProviderConnection: (input) =>
    ipcRenderer.invoke('providers.test.v1', input) as ReturnType<DesktopApi['testProviderConnection']>,
  listTaskPage: (input) => ipcRenderer.invoke('tasks.page.v1', input) as ReturnType<DesktopApi['listTaskPage']>,
  listTaskBatch: (input) => ipcRenderer.invoke('tasks.batch.v1', input) as ReturnType<DesktopApi['listTaskBatch']>,
  getTask: (taskId) => ipcRenderer.invoke('tasks.get.v1', taskId) as ReturnType<DesktopApi['getTask']>,
  enqueueTask: (input) =>
    ipcRenderer.invoke('tasks.enqueue.v1', input) as ReturnType<DesktopApi['enqueueTask']>,
  cancelTask: (taskId) =>
    ipcRenderer.invoke('tasks.cancel.v1', taskId) as ReturnType<DesktopApi['cancelTask']>,
  deleteTasks: (input) => ipcRenderer.invoke('tasks.delete.v1', input) as ReturnType<DesktopApi['deleteTasks']>,
  actOnTaskBatch: (input) => ipcRenderer.invoke('tasks.batch.action.v1', input) as ReturnType<DesktopApi['actOnTaskBatch']>,
  pauseTask: (taskId) =>
    ipcRenderer.invoke('tasks.pause.v1', taskId) as ReturnType<DesktopApi['pauseTask']>,
  resumeTask: (taskId) =>
    ipcRenderer.invoke('tasks.resume.v1', taskId) as ReturnType<DesktopApi['resumeTask']>,
  retryTask: (taskId) =>
    ipcRenderer.invoke('tasks.retry.v1', taskId) as ReturnType<DesktopApi['retryTask']>,
  retryFailedTasks: () => ipcRenderer.invoke('tasks.retry-all-failed.v1') as ReturnType<DesktopApi['retryFailedTasks']>,
  moveQueuedTask: (input) =>
    ipcRenderer.invoke('tasks.move.v1', input) as ReturnType<DesktopApi['moveQueuedTask']>,
  retryFailedGenerationTasks: (input = {}) =>
    ipcRenderer.invoke('tasks.generation.retry-failed.v1', input) as ReturnType<DesktopApi['retryFailedGenerationTasks']>,
  updateQueuedGenerationTask: (input) =>
    ipcRenderer.invoke('tasks.generation.update.v1', input) as ReturnType<DesktopApi['updateQueuedGenerationTask']>,
  updateQueuedGenerationTasks: (input) =>
    ipcRenderer.invoke('tasks.generation.update-many.v1', input) as ReturnType<DesktopApi['updateQueuedGenerationTasks']>,
  resizeQueuedGenerationBatch: (input) =>
    ipcRenderer.invoke('tasks.generation.resize.v1', input) as ReturnType<DesktopApi['resizeQueuedGenerationBatch']>,
  listPromptTemplates: () =>
    ipcRenderer.invoke('templates.list.v1') as ReturnType<DesktopApi['listPromptTemplates']>,
  savePromptTemplate: (input) =>
    ipcRenderer.invoke('templates.save.v1', input) as ReturnType<DesktopApi['savePromptTemplate']>,
  archivePromptTemplate: (templateId) =>
    ipcRenderer.invoke('templates.archive.v1', templateId) as ReturnType<DesktopApi['archivePromptTemplate']>,
  listAnalysisRevisions: (assetId) =>
    ipcRenderer.invoke('analysis.list.v1', { assetId }) as ReturnType<DesktopApi['listAnalysisRevisions']>,
  listGenerationResults: (assetId) =>
    ipcRenderer.invoke('generation.results.list.v1', { assetId }) as ReturnType<DesktopApi['listGenerationResults']>,
  listTrashedGenerationResults: (assetId) =>
    ipcRenderer.invoke('generation.results.trash.list.v1', { assetId }) as ReturnType<DesktopApi['listTrashedGenerationResults']>,
  trashGenerationResult: (input) =>
    ipcRenderer.invoke('generation.result.trash.v1', input) as ReturnType<DesktopApi['trashGenerationResult']>,
  restoreGenerationResult: (input) =>
    ipcRenderer.invoke('generation.result.restore.v1', input) as ReturnType<DesktopApi['restoreGenerationResult']>,
  getGenerationTrashSummary: () =>
    ipcRenderer.invoke('generation.trash.summary.v1') as ReturnType<DesktopApi['getGenerationTrashSummary']>,
  emptyGenerationTrash: () =>
    ipcRenderer.invoke('generation.trash.empty.v1') as ReturnType<DesktopApi['emptyGenerationTrash']>,
  updateGenerationResultReview: (input) =>
    ipcRenderer.invoke('generation.result.review.update.v1', input) as ReturnType<DesktopApi['updateGenerationResultReview']>,
  revealGenerationResult: (resultId) =>
    ipcRenderer.invoke('generation.result.reveal.v1', resultId) as ReturnType<DesktopApi['revealGenerationResult']>,
  exportGenerationResults: (input) =>
    ipcRenderer.invoke('generation.results.export.v1', input) as ReturnType<DesktopApi['exportGenerationResults']>,
  revealExportDestination: (taskId) =>
    ipcRenderer.invoke('export.destination.reveal.v1', taskId) as ReturnType<DesktopApi['revealExportDestination']>,
  listExportPresets: () => ipcRenderer.invoke('export.presets.list.v1') as ReturnType<DesktopApi['listExportPresets']>,
  saveExportPreset: (input) => ipcRenderer.invoke('export.presets.save.v1', input) as ReturnType<DesktopApi['saveExportPreset']>,
  deleteExportPreset: (presetId) => ipcRenderer.invoke('export.presets.delete.v1', presetId) as ReturnType<DesktopApi['deleteExportPreset']>
  , getImageCacheStats: () => ipcRenderer.invoke('cache.stats.get.v1') as ReturnType<DesktopApi['getImageCacheStats']>
  , pruneImageCache: (input) => ipcRenderer.invoke('cache.prune.v1', input) as ReturnType<DesktopApi['pruneImageCache']>
};

contextBridge.exposeInMainWorld('desktopApi', Object.freeze(api));
