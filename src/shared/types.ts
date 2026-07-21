// Shared type definitions for CtrlC clipboard manager

export interface ClipData {
  id: string;
  createdAt: number;
  type: ClipType;
  content: string;
  contentText?: string; // plain-text flavor captured alongside html clips
  contentHash: string;
  source?: string; // app that copied it
  preview?: string; // base64 PNG attached for image clips (content is the file path)
}

export type ClipType = 'text' | 'html' | 'image' | 'file' | 'binary';

/** Where the popup appears when triggered. */
export type PopupPositionMode = 'mouse' | 'center-primary' | 'center-current';

export const POPUP_POSITION_MODES: PopupPositionMode[] = [
  'mouse', 'center-primary', 'center-current',
];

/** Modifier held while selecting a clip to paste it as plain text. */
export type PlainPasteModifier = 'ctrl' | 'shift' | 'alt';

export const PLAIN_PASTE_MODIFIERS: PlainPasteModifier[] = ['ctrl', 'shift', 'alt'];

export interface AppConfig {
  hotkey: string;
  historyDepth: number;
  retentionDays: number;
  saveImages: boolean;
  saveHtml: boolean;
  saveBinary: boolean;
  autoStart: boolean;
  runElevated: boolean; // Windows: start as admin (uses Task Scheduler)
  dataDir: string;
  popupPosition: PopupPositionMode;
  plainPasteModifier: PlainPasteModifier;
}

export const DEFAULT_CONFIG: AppConfig = {
  hotkey: 'CommandOrControl+`',
  historyDepth: 100,
  retentionDays: 30,
  saveImages: true,
  saveHtml: true,
  saveBinary: true,
  autoStart: false,
  runElevated: false,
  dataDir: '', // resolved at runtime to ~/.CtrlC
  popupPosition: 'mouse',
  plainPasteModifier: 'ctrl',
};

export interface UpdateInfo {
  version: string;     // e.g. "v0.2.0"
  url: string;         // GitHub release HTML URL
  publishedAt: string; // ISO 8601
}

// Result of an on-demand "Check for updates" — distinguishes up-to-date from a
// failed check so the UI can show a meaningful message (the background poller
// only cares about the 'available' case).
export type UpdateCheckResult =
  | { status: 'available'; info: UpdateInfo }
  | { status: 'current'; version: string }
  | { status: 'error' };

// Tray menu item definitions
export interface TrayMenuItem {
  label: string;
  action: 'show-popup' | 'copy-last' | 'settings' | 'about' | 'exit';
}
