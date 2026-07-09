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

/**
 * Where the popup appears when triggered.
 * 'caret' — at the text cursor; no portable Linux API exists yet, so it
 * currently behaves like 'mouse' (see CtrlC-e9u follow-up).
 */
export type PopupPositionMode = 'caret' | 'mouse' | 'center-primary' | 'center-current';

export const POPUP_POSITION_MODES: PopupPositionMode[] = [
  'caret', 'mouse', 'center-primary', 'center-current',
];

export interface AppConfig {
  hotkey: string;
  historyDepth: number;
  retentionDays: number;
  saveImages: boolean;
  saveHtml: boolean;
  saveBinary: boolean;
  autoStart: boolean;
  dataDir: string;
  popupPosition: PopupPositionMode;
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
  popupPosition: 'mouse',
};

// Tray menu item definitions
export interface TrayMenuItem {
  label: string;
  action: 'show-popup' | 'copy-last' | 'settings' | 'about' | 'exit';
}
