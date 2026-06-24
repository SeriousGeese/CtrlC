import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('ctrlc', {
  // Config
  getConfig: () => ipcRenderer.invoke('config:get'),
  updateConfig: (updates: Record<string, unknown>) =>
    ipcRenderer.invoke('config:update', updates),

  // Clips
  getRecentClips: () => ipcRenderer.invoke('clips:get-recent'),
  deleteClip: (id: string) => ipcRenderer.invoke('clips:delete', id),
  copyClip: (id: string) => ipcRenderer.invoke('clips:copy', id),

  // Popup
  showPopup: (x: number, y: number) =>
    ipcRenderer.invoke('popup:show', x, y),
  closePopup: () => ipcRenderer.invoke('popup:close'),

  // Navigation
  showAbout: () => ipcRenderer.invoke('nav:about'),
  showSettings: () => ipcRenderer.invoke('nav:settings'),
});

declare global {
  interface Window {
    ctrlc: {
      getConfig: () => Promise<any>;
      updateConfig: (updates: Record<string, unknown>) => Promise<any>;
      getRecentClips: () => Promise<any[]>;
      deleteClip: (id: string) => Promise<boolean>;
      copyClip: (id: string) => Promise<boolean>;
      showPopup: (x: number, y: number) => Promise<void>;
      closePopup: () => Promise<void>;
      showAbout: () => Promise<void>;
      showSettings: () => Promise<void>;
    };
  }
}
