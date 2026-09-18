import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopApi } from '@photoallisai/contracts';

const api: DesktopApi = {
  getAppInfo: () => ipcRenderer.invoke('app.info.v1') as ReturnType<DesktopApi['getAppInfo']>,
  chooseImportFolders: () =>
    ipcRenderer.invoke('catalog.choose-import-folders.v1') as ReturnType<
      DesktopApi['chooseImportFolders']
    >
};

contextBridge.exposeInMainWorld('desktopApi', Object.freeze(api));

