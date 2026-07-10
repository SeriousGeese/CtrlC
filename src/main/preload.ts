import { contextBridge, ipcRenderer } from 'electron';
import { AppConfig, ClipData, UpdateInfo } from '../shared/types';

contextBridge.exposeInMainWorld('ctrlc', {
  // App
  getVersion: () => ipcRenderer.invoke('app:version'),
  getUpdateInfo: (): Promise<UpdateInfo | null> => ipcRenderer.invoke('app:get-update'),
  openUpdatePage: (): Promise<void> => ipcRenderer.invoke('app:open-update'),
  onUpdateAvailable: (cb: (info: UpdateInfo) => void): void => {
    ipcRenderer.on('update:available', (_event, info: UpdateInfo) => cb(info));
  },

  // Config
  getConfig: () => ipcRenderer.invoke('config:get'),
  updateConfig: (updates: Partial<AppConfig>) =>
    ipcRenderer.invoke('config:update', updates),

  // Clips
  getRecentClips: () => ipcRenderer.invoke('clips:get-recent'),
  deleteClip: (id: string) => ipcRenderer.invoke('clips:delete', id),
  updateClip: (id: string, content: string) => ipcRenderer.invoke('clips:update', id, content),
  copyClip: (id: string) => ipcRenderer.invoke('clips:copy', id),
  pasteClip: (id: string, plain?: boolean) => ipcRenderer.invoke('clips:paste', id, plain === true),
  capture: () => ipcRenderer.invoke('clips:capture'),
  clearHistory: () => ipcRenderer.invoke('clips:clear'),

  // Popup
  showPopup: (x: number, y: number) =>
    ipcRenderer.invoke('popup:show', x, y),
  closePopup: () => ipcRenderer.invoke('popup:close'),

  // Windows
  openSettings: () => ipcRenderer.invoke('settings:open'),
  openAbout: () => ipcRenderer.invoke('about:open'),
});

declare global {
  interface Window {
    ctrlc: {
      getVersion: () => Promise<string>;
      getUpdateInfo: () => Promise<UpdateInfo | null>;
      openUpdatePage: () => Promise<void>;
      onUpdateAvailable: (cb: (info: UpdateInfo) => void) => void;
      getConfig: () => Promise<AppConfig>;
      updateConfig: (updates: Partial<AppConfig>) => Promise<AppConfig>;
      getRecentClips: () => Promise<ClipData[]>;
      deleteClip: (id: string) => Promise<boolean>;
      updateClip: (id: string, content: string) => Promise<boolean>;
      copyClip: (id: string) => Promise<boolean>;
      pasteClip: (id: string, plain?: boolean) => Promise<boolean>;
      capture: () => Promise<boolean>;
      clearHistory: () => Promise<boolean>;
      showPopup: (x: number, y: number) => Promise<void>;
      closePopup: () => Promise<void>;
      openSettings: () => Promise<void>;
      openAbout: () => Promise<void>;
    };
  }
}
