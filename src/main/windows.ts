import { BrowserWindow, ipcMain } from 'electron';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { centerOnPrimary } from './popup/position';

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

    this.window = new BrowserWindow({
      width: 480,
      height: 440,
      frame: true,
      transparent: false,
      resizable: false,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    centerWindowOnPrimary(this.window, 480, 440);

    // Set app icon
    const iconPath = path.join(__dirname, '../../assets/tray-icon.png');
    if (fs.existsSync(iconPath)) {
      this.window.setIcon(iconPath);
    }

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
      width: 360,
      height: 320,
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
    centerWindowOnPrimary(this.window, 360, 320);

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
