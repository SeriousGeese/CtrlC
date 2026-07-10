import { app, BrowserWindow, ipcMain, clipboard, Menu, nativeImage, dialog } from 'electron';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { loadConfig, saveConfig, getDataDir, getClipsDir } from './config';
import { initDB, getRecentClips, deleteClip, cleanExpiredClips, clearAllClips, setDbPath, closeDB } from './db';
import { TrayManager } from './tray/tray';
import { HotkeyManager } from './hotkey/hotkey';
import { PopupManager } from './popup/popup';
import { ClipboardCapture } from './clipboard';
import { SettingsManager, AboutManager } from './windows';
import { enableAutoStart, disableAutoStart } from './auto-start';
import { registerGlobalShortcut } from './desktop-shortcut';
import { ClipData, AppConfig } from '../shared/types';
import { computePopupPosition, placeBelowPoint, POPUP_WIDTH, POPUP_HEIGHT } from './popup/position';
import { CaretTracker } from './caret';
import { synthesizePaste } from './paste';
import { ensureKWinHelper, restorePreviousFocus, placePopupAtCursor, placePopupCenterCursorScreen } from './kwin/helper';

// Set process name for task managers / ps
process.title = 'CtrlC';

// NOTE: This project is pinned to Electron 33. Electron 42 displays no
// windows at all on KDE Wayland (Bazzite) under either the native Wayland
// backend (surfaces render internally but are never composited) or forced
// ozone-platform=x11 (GPU-process crash loop, no X11 windows created). See
// issue CtrlC-ec7. Under Electron 33 the app runs via XWayland, where window
// positioning and cursor queries work. Wayland-session limitations are
// handled outside Electron: clipboard capture uses `wl-paste --watch` (see
// clipboard.ts) and global hotkeys are registered with the desktop
// environment (see hotkey.ts / desktop-shortcut.ts).

let mainWindow: BrowserWindow | null = null;
let trayManager: TrayManager | null = null;
let hotkeyManager: HotkeyManager | null = null;
let popupManager: PopupManager | null = null;
let clipboardCapture: ClipboardCapture | null = null;
let settingsManager: SettingsManager | null = null;
let aboutManager: AboutManager | null = null;
let config = loadConfig();
const caretTracker = new CaretTracker();

// Single-instance lock
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
  process.exit(0);
}
app.on('second-instance', (_event, argv) => {
  console.log('[CtrlC] second-instance:', argv.join(' '));
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
    width: POPUP_WIDTH,
    height: POPUP_HEIGHT,
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
  ipcMain.handle('clips:get-recent', async () => {
    const clips = await getRecentClips(config.historyDepth);
    // Image clips store the PNG's file path; the sandboxed renderer can't
    // read files, so attach the image data as a base64 preview.
    for (const clip of clips) {
      if (clip.type === 'image') {
        try {
          clip.preview = fs.readFileSync(clip.content).toString('base64');
        } catch {
          // file was cleaned up — renderer shows the [image] placeholder
        }
      }
    }
    return clips;
  });
  ipcMain.handle('clips:clear', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const opts: Electron.MessageBoxOptions = {
      type: 'warning',
      buttons: ['Clear History', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      title: 'Clear History',
      message: 'Clear all clipboard history?',
      detail: 'This permanently deletes every saved clip, including images.',
    };
    const { response } = win
      ? await dialog.showMessageBox(win, opts)
      : await dialog.showMessageBox(opts);
    if (response !== 0) return false;

    await clearAllClips();
    // Remove saved image files
    const clipsDir = getClipsDir();
    if (fs.existsSync(clipsDir)) {
      for (const file of fs.readdirSync(clipsDir)) {
        try {
          fs.unlinkSync(path.join(clipsDir, file));
        } catch {
          // best-effort cleanup
        }
      }
    }
    return true;
  });
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
  ipcMain.handle('clips:paste', async (_event, id: string) => {
    const clips = await getRecentClips(config.historyDepth);
    const clip = clips.find((c: ClipData) => c.id === id);
    if (!clip) return false;
    await copyClipToSystem(clip);
    // Hide, explicitly re-activate the pre-popup window (KWin's implicit
    // focus restore is unreliable and lands in the wrong app), then inject
    // Ctrl+V once the target has focus.
    popupManager?.close();
    await restorePreviousFocus();
    setTimeout(() => {
      void synthesizePaste();
    }, 250);
    return true;
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

  // Hotkey (reads the position mode live so settings changes apply instantly)
  hotkeyManager = new HotkeyManager(mainWindow, config.hotkey, () => config.popupPosition);

  // Popup manager
  popupManager = new PopupManager(mainWindow);

  // KWin helper: true-cursor popup placement and focus restore on Wayland
  void ensureKWinHelper(getDataDir());

  // Caret tracking (AT-SPI) for the "Cursor" position mode
  void caretTracker.start();

  // Show the popup, then correct its placement. For "caret", try the text
  // caret of the focused app first (AT-SPI), falling back to the mouse. For
  // pointer-anchored modes on KDE Wayland, ask KWin to move it to the real
  // cursor — Electron's cursor position is stale under XWayland whenever the
  // mouse is over a native Wayland window.
  const showPopup = (x: number, y: number): void => {
    void (async () => {
      if (config.popupPosition === 'caret') {
        const caret = await caretTracker.getCaretPoint();
        if (caret) {
          const pos = placeBelowPoint(caret);
          console.log(`[Popup] caret placement: caret=(${caret.x},${caret.y}) popup=(${pos.x},${pos.y})`);
          popupManager?.showAt(pos.x, pos.y);
          return;
        }
        console.log('[Popup] caret unknown — falling back to mouse placement');
      }
      popupManager?.showAt(x, y);
      if (config.popupPosition === 'mouse' || config.popupPosition === 'caret') {
        void placePopupAtCursor();
      } else if (config.popupPosition === 'center-current') {
        void placePopupCenterCursorScreen();
      }
      // center-primary needs no correction: the primary display is static
      // and Electron positions it exactly.
    })();
  };

  // Wire up hotkey → popup
  hotkeyManager.on('hotkey-pressed', (x: number, y: number) => {
    showPopup(x, y);
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

  // Wire up tray actions (tray emits placeholder coords; compute real ones)
  trayManager.on('show-popup', () => {
    const { x, y } = computePopupPosition(config.popupPosition);
    showPopup(x, y);
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
  caretTracker.stop();
  hotkeyManager?.destroy();
  settingsManager?.destroy();
  aboutManager?.destroy();
  trayManager?.destroy();
  await closeDB();
});
