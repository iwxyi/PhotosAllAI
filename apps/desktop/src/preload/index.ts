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
    ipcRenderer.invoke('providers.test.v1', input) as ReturnType<DesktopApi['testProviderConnection']>
};

contextBridge.exposeInMainWorld('desktopApi', Object.freeze(api));
