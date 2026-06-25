import { globalShortcut, screen } from 'electron';
import { EventEmitter } from 'node:events';
import { BrowserWindow } from 'electron';

export class HotkeyManager extends EventEmitter {
  private hotkey: string;
  private mainWindowRef: BrowserWindow;

  constructor(mainWindow: BrowserWindow, hotkey: string) {
    super();
    this.mainWindowRef = mainWindow;
    this.hotkey = hotkey;
    this.registerHotkey(hotkey);
  }

  registerHotkey(hotkey: string): boolean {
    globalShortcut.register(hotkey, () => {
      // Show popup at center of screen
      // TODO: On Windows/macOS, use cursor position. On Wayland, we need
      // a native sidecar binary to get the actual mouse position.
      const display = screen.getPrimaryDisplay();
      const x = Math.round(display.bounds.x + display.bounds.width / 2 - 240);
      const y = Math.round(display.bounds.y + display.bounds.height / 2 - 180);

      this.emit('hotkey-pressed', x, y);
    });

    this.hotkey = hotkey;
    return true;
  }

  removeHotkey(): void {
    globalShortcut.unregister(this.hotkey);
  }

  destroy(): void {
    globalShortcut.unregisterAll();
  }
}
