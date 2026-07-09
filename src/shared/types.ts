// Shared type definitions for CtrlC clipboard manager

export interface ClipData {
  id: string;
  createdAt: number;
  type: ClipType;
  content: string;
  contentHash: string;
  source?: string; // app that copied it
  preview?: string; // base64 PNG attached for image clips (content is the file path)
}

export type ClipType = 'text' | 'html' | 'image' | 'file' | 'binary';

export interface AppConfig {
  hotkey: string;
  historyDepth: number;
  retentionDays: number;
  saveImages: boolean;
  saveHtml: boolean;
  saveBinary: boolean;
  autoStart: boolean;
  dataDir: string;
}

export const DEFAULT_CONFIG: AppConfig = {
  hotkey: 'CommandOrControl+`',
  historyDepth: 100,
  retentionDays: 30,
  saveImages: true,
  saveHtml: true,
  saveBinary: true,
  autoStart: false,
  dataDir: '', // resolved at runtime to ~/.CtrlC
};

// Tray menu item definitions
export interface TrayMenuItem {
  label: string;
  action: 'show-popup' | 'copy-last' | 'settings' | 'about' | 'exit';
}
