import { Tray, Menu, BrowserWindow, nativeImage } from 'electron';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { EventEmitter } from 'node:events';

export class TrayManager extends EventEmitter {
  private tray: Tray | null = null;
  private configPath: string;

  constructor(_mainWindow: BrowserWindow) {
    super();
    const home = process.env.HOME || process.env.USERPROFILE || '';
    this.configPath = path.join(home, '.CtrlC', 'config.toml');
    this.createTray();
  }

  private getHotkeyFromConfig(): string {
    if (!fs.existsSync(this.configPath)) return 'Ctrl+`';
    try {
      const content = fs.readFileSync(this.configPath, 'utf-8');
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (trimmed.startsWith('hotkey') && trimmed.includes('=')) {
          const eqIdx = trimmed.indexOf('=');
          let value = trimmed.substring(eqIdx + 1).trim();
          // Remove quotes
          if ((value.startsWith('"') && value.endsWith('"')) ||
              (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
          }
          return value;
        }
      }
    } catch {
      // ignore
    }
    return 'Ctrl+`';
  }

  private createTray(): void {
    const iconPath = path.join(__dirname, '../../../assets/tray-icon.png');
    const hotkey = this.getHotkeyFromConfig();

    let icon: import('electron').NativeImage;
    if (fs.existsSync(iconPath)) {
      icon = nativeImage.createFromPath(iconPath);
      icon = icon.resize({ width: 22, height: 22 });
    } else {
      icon = nativeImage.createEmpty();
    }

    this.tray = new Tray(icon);
    this.tray.setToolTip('CtrlC — Clipboard Manager (' + hotkey + ')');

    const contextMenu = Menu.buildFromTemplate([
      { label: 'Show Popup (' + hotkey + ')', click: () => this.emit('show-popup', 0, 0) },
      { type: 'separator' },
      { label: 'Copy Last Clip', click: () => this.emit('copy-last') },
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
