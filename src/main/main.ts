import { app, BrowserWindow, ipcMain, clipboard, Menu, nativeImage, dialog, shell } from 'electron';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { loadConfig, saveConfig, getDataDir, getClipsDir } from './config';
import { initDB, getRecentClips, deleteClip, updateClipContent, cleanExpiredClips, clearAllClips, pruneOrphanClipFiles, touchClipByHash, setDbPath, closeDB } from './db';
import { TrayManager } from './tray/tray';
import { HotkeyManager } from './hotkey/hotkey';
import { PopupManager } from './popup/popup';
import { ClipboardCapture } from './clipboard';
import { SettingsManager, AboutManager } from './windows';
import { enableAutoStart, disableAutoStart } from './auto-start';
import { registerGlobalShortcut } from './desktop-shortcut';
import { ClipData, AppConfig } from '../shared/types';
import { computePopupPosition, POPUP_WIDTH, POPUP_HEIGHT } from './popup/position';
import { synthesizePaste } from './paste';
import { ensureKWinHelper, restorePreviousFocus, placePopupAtCursor, placePopupCenterCursorScreen } from './kwin/helper';
import { htmlToText } from './html-text';
import { ensureYdotoold, teardownLinuxIntegration } from './linux-setup';
import { launcherParts } from './exec-info';
import { ensureWinPasteHelper, captureForegroundWindow, pasteToCapturedWindow, pasteElevated, stopWinPasteHelper } from './win-paste';
import { startUpdatePoller, checkForUpdatesDetailed } from './update-checker';
import { isElevated, restartAsAdmin, enableElevatedAutoStart, disableElevatedAutoStart, isElevatedAutoStartEnabled } from './elevate';
import type { UpdateInfo, UpdateCheckResult } from '../shared/types';

// Set process name for task managers / ps
process.title = 'CtrlC';

// If the launching terminal closes (or its pty vanishes across
// suspend/logout), stdout/stderr become dead sockets and every console.*
// write emits EIO/EPIPE on the stream — an uncaught main-process exception
// unless someone listens. Logging is best-effort; swallow write errors.
process.stdout.on('error', () => {});
process.stderr.on('error', () => {});

// NOTE: This project is pinned to Electron 33. Electron 42 displays no
// windows at all on KDE Wayland (Bazzite) under either the native Wayland
// backend (surfaces render internally but are never composited) or forced
// ozone-platform=x11 (GPU-process crash loop, no X11 windows created). See
// issue CtrlC-ec7. Under Electron 33 the app runs via XWayland, where window
// positioning and cursor queries work. Wayland-session limitations are
// handled outside Electron: clipboard capture uses `wl-paste --watch` (see
// clipboard.ts) and global hotkeys are registered with the desktop
// environment (see hotkey.ts / desktop-shortcut.ts).

let latestUpdate: UpdateInfo | null = null;
let mainWindow: BrowserWindow | null = null;
let trayManager: TrayManager | null = null;
let hotkeyManager: HotkeyManager | null = null;
let popupManager: PopupManager | null = null;
let clipboardCapture: ClipboardCapture | null = null;
let settingsManager: SettingsManager | null = null;
let aboutManager: AboutManager | null = null;
let config = loadConfig();
let elevated = false; // Windows admin elevation state

// `ctrlc --teardown`: remove everything installed outside the app (DE
// shortcut, autostart entry, ydotoold unit, KWin helper). Used by
// uninstallers; runs and exits without starting the app — and must skip the
// single-instance lock so it works while the app is running.
const isTeardown = process.argv.includes('--teardown');
// Only a child launched by restartAsAdmin can bypass the regular Electron
// single-instance lock. This avoids a lock handoff race during elevation.
const isElevatedRestart = process.argv.includes('--elevated-restart');
if (isTeardown) {
  void app.whenReady()
    .then(() => teardownLinuxIntegration(getDataDir()))
    .finally(() => app.exit(0));
}

// Single-instance lock
if (!isTeardown && !isElevatedRestart && !app.requestSingleInstanceLock()) {
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
    // Offer both flavors, like the original copy did: rich targets take the
    // html, plain-text targets (terminals, Discord, code editors) take the
    // text. Never hand raw markup to the text flavor.
    clipboard.write({
      html: clip.content,
      text: clip.contentText || htmlToText(clip.content),
    });
  } else {
    clipboard.writeText(clip.content);
  }
  return true;
}

// Record a newer release and surface it everywhere: tray badge + all open
// renderer windows. Shared by the background poller and the on-demand check.
function announceUpdate(info: UpdateInfo): void {
  latestUpdate = info;
  trayManager?.setUpdateAvailable(info);
  BrowserWindow.getAllWindows().forEach(w => {
    w.webContents.send('update:available', info);
  });
}

// IPC handlers
function setupIPC(): void {
  // App
  ipcMain.handle('app:version', () => app.getVersion());
  ipcMain.handle('app:get-update', () => latestUpdate);
  ipcMain.handle('app:open-update', () => {
    if (latestUpdate) void shell.openExternal(latestUpdate.url);
  });
  // Open an arbitrary external link in the user's default browser. Restricted
  // to http(s) so a compromised renderer can't launch file:// or app schemes.
  ipcMain.handle('app:open-external', (_event, url: string) => {
    if (typeof url === 'string' && /^https?:\/\//.test(url)) {
      void shell.openExternal(url);
    }
  });
  // On-demand check triggered by the Settings "Check for updates" button.
  ipcMain.handle('app:check-update', async (): Promise<UpdateCheckResult> => {
    const result = await checkForUpdatesDetailed();
    if (result.status === 'available') announceUpdate(result.info);
    return result;
  });

  // Elevation (Windows admin mode)
  ipcMain.handle('app:is-elevated', (): boolean => elevated);
  ipcMain.handle('app:is-windows', (): boolean => process.platform === 'win32');
  ipcMain.handle('app:restart-as-admin', (): void => {
    restartAsAdmin();
  });

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

    // Toggle elevated auto-start (Windows Task Scheduler)
    if (updates.runElevated !== undefined) {
      if (updates.runElevated && process.platform === 'win32') {
        void enableElevatedAutoStart();
      } else if (process.platform === 'win32') {
        void disableElevatedAutoStart();
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
    // The capture loop's consecutive-duplicate guard must forget the last
    // hash, or re-copying the most recent content after clearing is skipped.
    clipboardCapture?.resetDedup();
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
    clipboardCapture?.resetDedup();
    return true;
  });
  ipcMain.handle('clips:update', async (_event, id: string, content: string) => {
    if (typeof content !== 'string' || content.length === 0) return false;
    const ok = await updateClipContent(id, content);
    clipboardCapture?.resetDedup();
    return ok;
  });
  ipcMain.handle('clips:copy', async (_event, id: string) => {
    const clips = await getRecentClips(config.historyDepth);
    const clip = clips.find((c: ClipData) => c.id === id);
    if (clip) return copyClipToSystem(clip);
    return false;
  });
  ipcMain.handle('clips:paste', async (_event, id: string, plain = false) => {
    const clips = await getRecentClips(config.historyDepth);
    const clip = clips.find((c: ClipData) => c.id === id);
    if (!clip) return false;
    if (plain && clip.type === 'html') {
      // Plain-text paste: offer only the stripped text, no html flavor
      clipboard.writeText(clip.contentText || htmlToText(clip.content));
    } else {
      await copyClipToSystem(clip);
    }
    // Pasted clip moves to the top of the history (Ditto behavior)
    await touchClipByHash(clip.contentHash);
    // Hide, explicitly re-activate the pre-popup window (implicit focus
    // restore is unreliable on both KWin and Windows and lands in the wrong
    // app — or none), then inject Ctrl+V once the target has focus.
    popupManager?.close();
    if (process.platform === 'win32') {
      const pasted = await pasteToCapturedWindow();
      if (!pasted) {
        // Helper unavailable — best-effort one-shot fallback
        if (!elevated) {
          // Not running as admin; try elevated one-shot for admin windows
          const elevatedPasted = await pasteElevated(getDataDir());
          if (!elevatedPasted) {
            setTimeout(() => { void synthesizePaste(); }, 250);
          }
        } else {
          setTimeout(() => { void synthesizePaste(); }, 250);
        }
      }
      return true;
    }
    if (process.platform === 'darwin') {
      // Showing the popup activated CtrlC, stealing focus from the target app
      // (TextEdit etc.). Hiding CtrlC hands focus back to whatever app was
      // frontmost before the popup — standard macOS "hide restores the
      // previous app" behavior. Without this, the Cmd+V below lands on CtrlC,
      // which has no text field, so macOS just beeps and nothing pastes. The
      // delay lets the focus handoff settle before the keystroke.
      app.hide();
      setTimeout(() => { void synthesizePaste(); }, 150);
      return true;
    }
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
if (!isTeardown) void app.whenReady().then(async () => {
  ensureDataDir();

  // Detect Windows elevation state
  elevated = await isElevated();
  if (elevated) {
    console.log('[CtrlC] Running with administrator privileges — paste works in elevated windows');
  }
  if (process.platform === 'win32' && !isTeardown) {
    // Sync elevated auto-start preference from Task Scheduler
    const taskExists = await isElevatedAutoStartEnabled();
    if (taskExists !== config.runElevated) {
      config.runElevated = taskExists;
      await saveConfig(config);
    }
  }

  // Set DB path
  const dbFilePath = path.join(getDataDir(), '.config', 'cutc.db');
  setDbPath(dbFilePath);

  await initDB();
  setupIPC();

  // Clean expired clips on startup (fire and forget): drop rows past the
  // retention window and their image files, then sweep any orphaned files that
  // older builds stranded in Clips/ by deleting rows without their PNGs.
  void (async () => {
    await cleanExpiredClips(config.retentionDays);
    await pruneOrphanClipFiles(getClipsDir());
  })();

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
  trayManager.setElevated(elevated);

  // Hotkey (reads the position mode live so settings changes apply instantly)
  hotkeyManager = new HotkeyManager(mainWindow, config.hotkey, () => config.popupPosition);

  // Popup manager
  popupManager = new PopupManager(mainWindow);

  // KWin helper: true-cursor popup placement and focus restore on Wayland
  void ensureKWinHelper(getDataDir());

  // First-run: make sure ydotoold is available for paste injection
  void ensureYdotoold();

  // Windows: persistent helper that re-activates the pre-popup window and
  // injects Ctrl+V (no-op elsewhere)
  ensureWinPasteHelper(getDataDir());

  // Update checker: poll GitHub releases API on startup (delayed) and every 24h.
  // The on-demand "Check for updates" button (app:check-update) reuses the same
  // announce path, so both surface a newer release identically.
  startUpdatePoller(announceUpdate);

  // Show the popup, then (for pointer-anchored modes on KDE Wayland) ask
  // KWin to correct the placement — Electron's cursor position is stale
  // under XWayland whenever the mouse is over a native Wayland window.
  const showPopup = (x: number, y: number): void => {
    // Remember the paste target before the popup steals focus (win32 no-op
    // elsewhere; on KDE the KWin helper tracks this continuously)
    captureForegroundWindow();
    popupManager?.showAt(x, y);
    if (config.popupPosition === 'mouse') {
      void placePopupAtCursor();
    } else if (config.popupPosition === 'center-current') {
      void placePopupCenterCursorScreen();
    }
    // center-primary needs no correction: the primary display is static and
    // Electron positions it exactly.
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
    const launcher = launcherParts();
    void registerGlobalShortcut({
      execPath: launcher.execPath,
      appPath: launcher.appPath,
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
  trayManager.on('settings', () => {
    settingsManager?.show();
  });
  trayManager.on('about', () => {
    aboutManager?.show();
  });
  trayManager.on('restart-as-admin', () => {
    restartAsAdmin();
  });
  trayManager.on('exit', () => {
    // Manual cleanup before force-exit — app.quit() stalls because the
    // popup window's close handler preventsDefault() (hides instead of
    // closing). app.exit() skips will-quit events, so clean up here.
    stopWinPasteHelper();
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
  stopWinPasteHelper();
  hotkeyManager?.destroy();
  settingsManager?.destroy();
  aboutManager?.destroy();
  trayManager?.destroy();
  await closeDB();
});
