import { app, BrowserWindow, ipcMain, clipboard, Menu, nativeImage } from 'electron';
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
import { registerGlobalShortcut } from './desktop-shortcut';
import { ClipData, AppConfig } from '../shared/types';

// Set process name for task managers / ps
process.title = 'CtrlC';

// On Linux, force the X11 (XWayland) backend. Under native Wayland, a client
// can only read or write the clipboard while one of its windows has focus, so
// background clipboard polling captures nothing, window positioning is
// ignored, and globalShortcut silently never fires. Under XWayland the
// compositor (KWin/Mutter) syncs the Wayland clipboard to X11, so polling
// from a hidden window works.
if (process.platform === 'linux') {
  app.commandLine.appendSwitch('ozone-platform', 'x11');
}

let mainWindow: BrowserWindow | null = null;
let trayManager: TrayManager | null = null;
let hotkeyManager: HotkeyManager | null = null;
let popupManager: PopupManager | null = null;
let clipboardCapture: ClipboardCapture | null = null;
let settingsManager: SettingsManager | null = null;
let aboutManager: AboutManager | null = null;
let config = loadConfig();

// Single-instance lock
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
  process.exit(0);
}
app.on('second-instance', (_event, argv) => {
  // A compositor-level shortcut can run `ctrlc --show-popup`; that launches a
  // second instance, which we intercept here to open the popup. This is the
  // Wayland workaround for global hotkeys (the compositor owns shortcuts).
  if (argv.includes('--show-popup')) {
    hotkeyManager?.triggerPopup();
    return;
  }
  // Another instance started — focus our window
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

// Set app icon globally
const appIconPath = path.join(__dirname, '../../assets/tray-icon.png');
if (fs.existsSync(appIconPath)) {
  app.dock?.setIcon(appIconPath);
}

// Remove default menu bar
Menu.setApplicationMenu(null);

// Set app icon on the popup window
function setAppIcon(win: BrowserWindow): void {
  const iconPath = path.join(__dirname, '../../assets/tray-icon.png');
  if (fs.existsSync(iconPath)) {
    win.setIcon(iconPath);
  }
}

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

  void win.loadFile(path.join(__dirname, '../renderer/popup.html'));
  win.once('show', () => {
    const pos = popupManager?.getPosition();
    if (pos) {
      win.setPosition(pos.x, pos.y, false);
    }
  });

  setAppIcon(win);

  return win;
}

// Copy a clip to system clipboard
async function copyClipToSystem(clip: ClipData): Promise<boolean> {
  if (clip.type === 'image') {
    // Image clips store the PNG's file path on disk, not the image bytes.
    const img = nativeImage.createFromPath(clip.content);
    if (img.isEmpty()) return false;
    clipboard.writeImage(img);
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
    const prevHotkey = config.hotkey;
    config = { ...config, ...updates };
    // Persist the full config — writing only the updates would drop every
    // other setting from config.toml (serializeToml skips undefined keys).
    await saveConfig(config);

    // Restart hotkey if changed
    if (updates.hotkey && updates.hotkey !== prevHotkey) {
      hotkeyManager?.removeHotkey();
      hotkeyManager?.registerHotkey(updates.hotkey);
    }

    // Keep the capture loop's view of the config current
    clipboardCapture?.updateConfig(config);

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

  // Clipboard capture
  clipboardCapture = new ClipboardCapture(config);
  clipboardCapture.start();

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

  // If Electron's native global shortcut failed to register (always the case
  // on Wayland — the compositor owns shortcuts), fall back to registering a
  // DE-level shortcut that runs `<electron> <app> --show-popup`. The running
  // instance intercepts that via the single-instance hook above.
  hotkeyManager.on('hotkey-registered', (registered: boolean) => {
    if (registered) return;
    const iconPath = path.join(__dirname, '../../assets/tray-icon.png');
    void registerGlobalShortcut({
      execPath: process.execPath,
      appPath: app.getAppPath(),
      iconPath,
      hotkey: config.hotkey,
    }).then((result) => {
      if (result.ok) {
        console.log(`[CtrlC] ${result.message}`);
        if (result.conflict) {
          console.warn(
            `[CtrlC] Hotkey conflict: "${result.conflict}" already uses this ` +
              `shortcut. Change CtrlC's hotkey in Settings or unbind the other app.`,
          );
        }
      } else {
        console.warn(`[CtrlC] ${result.message}`);
      }
    });
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
    // Manual cleanup before force-exit — app.quit() stalls because the
    // popup window's close handler preventsDefault() (hides instead of
    // closing). app.exit() skips will-quit events, so clean up here.
    hotkeyManager?.destroy();
    settingsManager?.destroy();
    aboutManager?.destroy();
    trayManager?.destroy();
    void closeDB().finally(() => app.exit(0));
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
