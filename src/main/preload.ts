import { contextBridge, ipcRenderer } from 'electron';
import { AppConfig, ClipData } from '../shared/types';

contextBridge.exposeInMainWorld('ctrlc', {
  // Config
  getConfig: () => ipcRenderer.invoke('config:get'),
  updateConfig: (updates: Partial<AppConfig>) =>
    ipcRenderer.invoke('config:update', updates),

  // Clips
  getRecentClips: () => ipcRenderer.invoke('clips:get-recent'),
  deleteClip: (id: string) => ipcRenderer.invoke('clips:delete', id),
  copyClip: (id: string) => ipcRenderer.invoke('clips:copy', id),
  pasteClip: (id: string) => ipcRenderer.invoke('clips:paste', id),
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
      getConfig: () => Promise<AppConfig>;
      updateConfig: (updates: Partial<AppConfig>) => Promise<AppConfig>;
      getRecentClips: () => Promise<ClipData[]>;
      deleteClip: (id: string) => Promise<boolean>;
      copyClip: (id: string) => Promise<boolean>;
      pasteClip: (id: string) => Promise<boolean>;
      capture: () => Promise<boolean>;
      clearHistory: () => Promise<boolean>;
      showPopup: (x: number, y: number) => Promise<void>;
      closePopup: () => Promise<void>;
      openSettings: () => Promise<void>;
      openAbout: () => Promise<void>;
    };
  }
}
