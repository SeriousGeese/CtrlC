import { BrowserWindow, ipcMain, shell, screen } from 'electron';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { centerOnPrimary } from './popup/position';

// Route target="_blank" / window.open links to the user's default browser
// instead of spawning a bare Electron window.
function openLinksExternally(win: BrowserWindow): void {
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
}

// Dialogs always open centered on the primary monitor. The position is set
// both in the constructor and re-asserted after the window maps — the window
// manager's map-time placement can override the requested position.
function centerWindowOnPrimary(win: BrowserWindow, width: number, height: number): void {
  const { x, y } = centerOnPrimary(width, height);
  win.setPosition(x, y, false);
  win.once('show', () => win.setPosition(x, y, false));
  win.once('ready-to-show', () => win.setPosition(x, y, false));
}

export class SettingsManager {
  private window: BrowserWindow | null = null;

  constructor() {
    ipcMain.handle('settings:open', () => {
      this.show();
    });
  }

  show(): void {
    if (this.window && !this.window.isDestroyed()) {
      this.window.focus();
      return;
    }

    // Cap at 2/3 of the primary display's work area. On small screens the
    // window may scroll; on large screens it shrinks to fit content exactly.
    const maxH = Math.max(440, Math.floor(screen.getPrimaryDisplay().workAreaSize.height * 2 / 3));

    this.window = new BrowserWindow({
      width: 480,
      height: maxH,
      frame: true,
      transparent: false,
      resizable: false,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    centerWindowOnPrimary(this.window, 480, maxH);

    // After the page renders, shrink the window to exactly fit the content
    // (capped at maxH so it never exceeds 2/3 of the screen).
    this.window.webContents.on('did-finish-load', () => {
      this.window!.webContents.executeJavaScript('document.documentElement.scrollHeight')
        .then((contentH: number) => {
          const h = Math.min(contentH + 4, maxH);
          this.window!.setSize(480, h);
          centerWindowOnPrimary(this.window!, 480, h);
        })
        .catch(() => { /* content height unavailable — keep maxH */ });
    });

    // Set app icon
    const iconPath = path.join(__dirname, '../../assets/tray-icon.png');
    if (fs.existsSync(iconPath)) {
      this.window.setIcon(iconPath);
    }

    openLinksExternally(this.window);
    void this.window.loadFile(path.join(__dirname, '../renderer/settings.html'));

    this.window.on('closed', () => {
      this.window = null;
    });
  }

  destroy(): void {
    if (this.window) {
      this.window.close();
      this.window = null;
    }
  }
}

export class AboutManager {
  private window: BrowserWindow | null = null;

  constructor() {
    ipcMain.handle('about:open', () => {
      this.show();
    });
  }

  show(): void {
    if (this.window && !this.window.isDestroyed()) {
      this.window.focus();
      return;
    }

    this.window = new BrowserWindow({
      width: 380,
      height: 440,
      useContentSize: true, // page area, excluding the frame — no scrolling
      frame: true,
      transparent: false,
      resizable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    centerWindowOnPrimary(this.window, 380, 440);

    openLinksExternally(this.window);
    void this.window.loadFile(path.join(__dirname, '../renderer/about.html'));

    this.window.on('closed', () => {
      this.window = null;
    });
  }

  destroy(): void {
    if (this.window) {
      this.window.close();
      this.window = null;
    }
  }
}
