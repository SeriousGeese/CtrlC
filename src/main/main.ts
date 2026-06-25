import { app, BrowserWindow, ipcMain, clipboard } from 'electron';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { loadConfig, saveConfig, getDataDir } from './config';
import { initDB, getRecentClips, deleteClip, cleanExpiredClips, setDbPath, closeDB } from './db';
import { TrayManager } from './tray/tray';
import { HotkeyManager } from './hotkey/hotkey';
import { PopupManager } from './popup/popup';
import { ClipboardCapture } from './clipboard';
import { SettingsManager, AboutManager } from './windows';
import { enableAutoStart, disableAutoStart } from './auto-start';
import { ClipData, AppConfig } from '../shared/types';

let mainWindow: BrowserWindow | null = null;
let trayManager: TrayManager | null = null;
let hotkeyManager: HotkeyManager | null = null;
let popupManager: PopupManager | null = null;
let clipboardCapture: ClipboardCapture | null = null;
let settingsManager: SettingsManager | null = null;
let aboutManager: AboutManager | null = null;
let config = loadConfig();

// Ensure data directory exists
function ensureDataDir(): void {
  const dataDir = getDataDir();
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  }
}

// Create the popup window
function createPopupWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 480,
    height: 360,
    show: false,
    frame: false,
    transparent: true,
    hasShadow: true,
    skipTaskbar: true,
    alwaysOnTop: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  void win.loadFile(path.join(__dirname, '../../src/renderer/popup.html'));
  win.once('show', () => {
    const pos = popupManager?.getPosition();
    if (pos) {
      win.setPosition(pos.x, pos.y, false);
    }
  });

  return win;
}

// Copy a clip to system clipboard
async function copyClipToSystem(clip: ClipData): Promise<boolean> {
  if (clip.type === 'image') {
    clipboard.writeBuffer('public.png', Buffer.from(clip.content, 'utf-8'));
  } else if (clip.type === 'html') {
    clipboard.write({ html: clip.content, text: clip.content });
  } else {
    clipboard.writeText(clip.content);
  }
  return true;
}

// IPC handlers
function setupIPC(): void {
  // Config
  ipcMain.handle('config:get', () => config);
  ipcMain.handle('config:update', async (_event, updates: Partial<AppConfig>) => {
    config = { ...config, ...updates };
    await saveConfig(updates);

    // Restart hotkey if changed
    if (updates.hotkey && updates.hotkey !== config.hotkey) {
      hotkeyManager?.removeHotkey();
      hotkeyManager?.registerHotkey(updates.hotkey);
    }

    // Toggle auto-start
    if (updates.autoStart !== undefined) {
      if (updates.autoStart) {
        enableAutoStart();
      } else {
        disableAutoStart();
      }
    }

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
    if (clip) return copyClipToSystem(clip);
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

  // Windows are handled by SettingsManager and AboutManager constructors
}

// App lifecycle
void app.whenReady().then(async () => {
  ensureDataDir();

  // Set DB path
  const dbFilePath = path.join(getDataDir(), '.config', 'cutc.db');
  setDbPath(dbFilePath);

  await initDB();
  setupIPC();

  // Clean expired clips on startup (fire and forget)
  void cleanExpiredClips(config.retentionDays);

  // Create popup window (hidden initially)
  mainWindow = createPopupWindow();

  // Settings + About
  settingsManager = new SettingsManager();
  aboutManager = new AboutManager();

  // Tray
  trayManager = new TrayManager(mainWindow);

  // Hotkey
  hotkeyManager = new HotkeyManager(mainWindow, config.hotkey);

  // Popup manager
  popupManager = new PopupManager(mainWindow);

  // Wire up hotkey → popup
  hotkeyManager.on('hotkey-pressed', (x: number, y: number) => {
    popupManager?.showAt(x, y);
  });

  // Wire up tray actions
  trayManager.on('show-popup', (x: number, y: number) => {
    popupManager?.showAt(x, y);
  });
  trayManager.on('copy-last', async () => {
    const recent = await getRecentClips(1);
    if (recent.length > 0) {
      await copyClipToSystem(recent[0]);
    }
  });
  trayManager.on('settings', () => {
    settingsManager?.show();
  });
  trayManager.on('about', () => {
    aboutManager?.show();
  });
  trayManager.on('exit', () => {
    app.quit();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createPopupWindow();
    }
  });
}).catch(err => {
  console.error('CtrlC startup failed:', err);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('will-quit', async () => {
  hotkeyManager?.destroy();
  settingsManager?.destroy();
  aboutManager?.destroy();
  trayManager?.destroy();
  await closeDB();
});
