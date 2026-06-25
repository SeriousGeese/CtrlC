import { BrowserWindow, ipcMain } from 'electron';
import * as path from 'node:path';

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

    void this.window.loadFile(path.join(__dirname, '../../src/renderer/settings.html'));

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

    void this.window.loadFile(path.join(__dirname, '../../src/renderer/about.html'));

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
