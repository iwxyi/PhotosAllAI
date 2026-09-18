import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopApi } from '@photoallisai/contracts';

const api: DesktopApi = {
  getAppInfo: () => ipcRenderer.invoke('app.info.v1') as ReturnType<DesktopApi['getAppInfo']>,
  listCatalogAssets: () =>
    ipcRenderer.invoke('catalog.assets.list.v1') as ReturnType<DesktopApi['listCatalogAssets']>,
  importFolders: () =>
    ipcRenderer.invoke('catalog.folders.import.v1') as ReturnType<
      DesktopApi['importFolders']
    >,
  listProviderProfiles: () =>
    ipcRenderer.invoke('providers.list.v1') as ReturnType<DesktopApi['listProviderProfiles']>,
  saveProviderProfile: (input) =>
    ipcRenderer.invoke('providers.save.v1', input) as ReturnType<DesktopApi['saveProviderProfile']>,
  testProviderConnection: (input) =>
    ipcRenderer.invoke('providers.test.v1', input) as ReturnType<DesktopApi['testProviderConnection']>,
  listTasks: () => ipcRenderer.invoke('tasks.list.v1') as ReturnType<DesktopApi['listTasks']>,
  enqueueTask: (input) =>
    ipcRenderer.invoke('tasks.enqueue.v1', input) as ReturnType<DesktopApi['enqueueTask']>,
  cancelTask: (taskId) =>
    ipcRenderer.invoke('tasks.cancel.v1', taskId) as ReturnType<DesktopApi['cancelTask']>,
  retryTask: (taskId) =>
    ipcRenderer.invoke('tasks.retry.v1', taskId) as ReturnType<DesktopApi['retryTask']>,
  reorderTasks: (taskIds) =>
    ipcRenderer.invoke('tasks.reorder.v1', taskIds) as ReturnType<DesktopApi['reorderTasks']>
};

contextBridge.exposeInMainWorld('desktopApi', Object.freeze(api));
