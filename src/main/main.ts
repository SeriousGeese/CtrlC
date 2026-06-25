import { app, BrowserWindow, ipcMain, Tray, Menu, globalShortcut, clipboard, Notification, nativeImage } from 'electron';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { loadConfig, saveConfig, getDataDir, getClipsDir } from './config';
import { initDB, insertClip, getRecentClips, deleteClip, cleanExpiredClips, setDbPath } from './db';
import { TrayManager } from './tray/tray';
import { HotkeyManager } from './hotkey/hotkey';
import { PopupManager } from './popup/popup';
import { ClipboardCapture } from './clipboard';
import { DEFAULT_CONFIG, ClipData } from '../shared/types';

let mainWindow: BrowserWindow | null = null;
let trayManager: TrayManager | null = null;
let hotkeyManager: HotkeyManager | null = null;
let popupManager: PopupManager | null = null;
let clipboardCapture: ClipboardCapture | null = null;
let config = loadConfig();

// Ensure data directory exists
function ensureDataDir(): void {
  const dataDir = getDataDir();
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  }
  const clipsDir = getClipsDir();
  if (!fs.existsSync(clipsDir)) {
    fs.mkdirSync(clipsDir, { recursive: true, mode: 0o700 });
  }
}

// Create the main window (popup)
function createPopupWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 480,
    height: 360,
    show: false,
    frame: false,
    transparent: true,
    hasShadow: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.loadFile(path.join(__dirname, '../../renderer/popup.html'));

  // Position at current mouse location (set from renderer via IPC)
  win.once('show', () => {
    const pos = popupManager?.getPosition();
    if (pos) {
      win.setPosition(pos.x, pos.y, false);
    }
  });

  return win;
}

// IPC handlers
function setupIPC(): void {
  // Config
  ipcMain.handle('config:get', () => config);
  ipcMain.handle('config:update', (_event, updates: Partial<typeof config>) => {
    config = { ...config, ...updates };
    saveConfig(updates);

    // Restart hotkey if changed
    if (updates.hotkey && updates.hotkey !== config.hotkey) {
      hotkeyManager?.removeHotkey();
      hotkeyManager?.registerHotkey(updates.hotkey);
    }

    // Clean expired clips
    cleanExpiredClips(config.retentionDays);

    return config;
  });

  // Clips
  ipcMain.handle('clips:get-recent', () => getRecentClips(config.historyDepth));
  ipcMain.handle('clips:delete', async (_event, id: string) => {
    await deleteClip(id);
    return true;
  });
  ipcMain.handle('clips:copy', async (_event, id: string) => {
    const clips = await getRecentClips(config.historyDepth);
    const clip = clips.find((c: ClipData) => c.id === id);
    if (clip) {
      if (clip.type === 'image') {
        clipboard.writeBuffer('public.png', Buffer.from(clip.content, 'utf-8'));
      } else if (clip.type === 'html') {
        clipboard.write({ html: clip.content, text: clip.content });
      } else {
        clipboard.writeText(clip.content);
      }
      return true;
    }
    return false;
  });
  ipcMain.handle('clips:copy-selected', async (_event, id: string) => {
    const clips = await getRecentClips(config.historyDepth);
    const clip = clips.find((c: ClipData) => c.id === id);
    if (clip) {
      if (clip.type === 'image') {
        clipboard.writeBuffer('public.png', Buffer.from(clip.content, 'utf-8'));
      } else if (clip.type === 'html') {
        clipboard.write({ html: clip.content, text: clip.content });
      } else {
        clipboard.writeText(clip.content);
      }
      return true;
    }
    return false;
  });
  ipcMain.handle('clips:capture', () => {
    clipboardCapture?.captureCurrent();
    return true;
  });

  // Popup
  ipcMain.handle('popup:show', (_event, x: number, y: number) => {
    popupManager?.showAt(x, y);
  });
  ipcMain.handle('popup:close', () => {
    popupManager?.close();
  });

  // Navigation (for about/settings windows)
  ipcMain.handle('nav:about', () => {
    // TODO: Open about window
  });
  ipcMain.handle('nav:settings', () => {
    // TODO: Open settings window
  });
}

// App lifecycle
app.whenReady().then(async () => {
  ensureDataDir();

  // Set DB path
  const dataDir = getDataDir();
  const dbFilePath = path.join(dataDir, '.config', 'cutc.db');
  setDbPath(dbFilePath);

  await initDB();
  setupIPC();

  // Clean expired clips on startup
  cleanExpiredClips(config.retentionDays);

  // Create popup window (hidden initially)
  mainWindow = createPopupWindow();

  // Tray
  trayManager = new TrayManager(mainWindow);

  // Hotkey
  hotkeyManager = new HotkeyManager(mainWindow, config.hotkey);

  // Popup manager (coordinates window positioning)
  popupManager = new PopupManager(mainWindow);

  // Wire up hotkey to popup
  hotkeyManager.on('hotkey-pressed', (x: number, y: number) => {
    popupManager?.showAt(x, y);
  });

  // Handle tray actions
  trayManager.on('show-popup', (x: number, y: number) => {
    popupManager?.showAt(x, y);
  });
  trayManager.on('copy-last', async () => {
    const recent = await getRecentClips(1);
    if (recent.length > 0) {
      const clip = recent[0];
      if (clip.type === 'image') {
        clipboard.writeBuffer('public.jpeg', Buffer.from(clip.content, 'base64'));
      } else {
        clipboard.writeText(clip.content);
      }
    }
  });
  trayManager.on('settings', () => {
    // Open settings window
  });
  trayManager.on('about', () => {
    // Open about window
  });
  trayManager.on('exit', () => {
    app.quit();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createPopupWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('will-quit', () => {
  if (hotkeyManager) {
    hotkeyManager.destroy();
  }
});
