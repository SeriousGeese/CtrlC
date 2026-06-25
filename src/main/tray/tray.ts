import { Tray, Menu, BrowserWindow, nativeImage } from 'electron';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';

export class TrayManager extends EventEmitter {
  private tray: Tray | null = null;

  constructor(_mainWindow: BrowserWindow) {
    super();
    this.createTray();
  }

  private createTray(): void {
    const iconPath = path.join(__dirname, '../../assets/tray-icon.png');

    // Fallback icon if file doesn't exist yet
    if (!require('node:fs').existsSync(iconPath)) {
      // Create a minimal fallback using nativeImage
      const fallback = nativeImage.createEmpty();
      this.tray = new Tray(fallback);
    } else {
      this.tray = new Tray(iconPath);
    }

    this.tray.setToolTip('CtrlC — Clipboard Manager');

    const contextMenu = Menu.buildFromTemplate([
      { label: 'Search Clips', click: () => this.emit('show-popup', 0, 0) },
      { type: 'separator' },
      { label: 'Settings', click: () => this.emit('settings') },
      { label: 'About CtrlC', click: () => this.emit('about') },
      { type: 'separator' },
      { label: 'Exit', click: () => this.emit('exit') },
    ]);

    this.tray.setContextMenu(contextMenu);

    // Left-click shows popup
    this.tray.on('click', () => {
      this.emit('show-popup', 0, 0);
    });
  }

  destroy(): void {
    if (this.tray) {
      this.tray.destroy();
      this.tray = null;
    }
  }
}
