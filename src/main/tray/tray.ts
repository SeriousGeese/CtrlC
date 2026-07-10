import { Tray, Menu, BrowserWindow, nativeImage, shell } from 'electron';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { EventEmitter } from 'node:events';
import type { UpdateInfo } from '../../shared/types';

export class TrayManager extends EventEmitter {
  private tray: Tray | null = null;
  private configPath: string;
  private pendingUpdate: UpdateInfo | null = null;

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
          return this.shortenHotkey(value);
        }
      }
    } catch {
      // ignore
    }
    return 'Ctrl+`';
  }

  private shortenHotkey(hotkey: string): string {
    if (!hotkey) return '';
    return hotkey
      .replace(/^CommandOrControl\+/g, '')
      .replace(/^Command\+/g, '')
      .replace(/^Control\+/g, '')
      .replace(/[Bb]ackquote/g, '`');
  }

  setUpdateAvailable(info: UpdateInfo | null): void {
    this.pendingUpdate = info;
    this.rebuildMenu();
  }

  private rebuildMenu(): void {
    if (!this.tray) return;
    const hotkey = this.getHotkeyFromConfig();

    type MenuItemTemplate = Parameters<typeof Menu.buildFromTemplate>[0][number];
    const template: MenuItemTemplate[] = [];

    if (this.pendingUpdate) {
      template.push({
        label: `↑ Update available — ${this.pendingUpdate.version}`,
        click: () => { void shell.openExternal(this.pendingUpdate!.url); },
      });
      template.push({ type: 'separator' });
    }

    template.push(
      { label: 'Show Popup (' + hotkey + ')', click: () => this.emit('show-popup', 0, 0) },
      { type: 'separator' },
      { label: 'Settings', click: () => this.emit('settings') },
      { label: 'About CtrlC', click: () => this.emit('about') },
      { type: 'separator' },
      { label: 'Exit', click: () => this.emit('exit') },
    );

    const contextMenu = Menu.buildFromTemplate(template);
    this.tray.setContextMenu(contextMenu);
    this.tray.setToolTip(
      this.pendingUpdate
        ? `CtrlC — Update available ${this.pendingUpdate.version}`
        : `CtrlC — Clipboard Manager (${hotkey})`,
    );
  }

  private createTray(): void {
    const iconPath = path.join(__dirname, '../../../assets/tray-icon.png');

    let icon: import('electron').NativeImage;
    if (fs.existsSync(iconPath)) {
      icon = nativeImage.createFromPath(iconPath);
      icon = icon.resize({ width: 22, height: 22 });
    } else {
      icon = nativeImage.createEmpty();
    }

    this.tray = new Tray(icon);
    this.rebuildMenu();

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
