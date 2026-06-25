import { BrowserWindow, ipcMain } from 'electron';

export class PopupManager {
  private window: BrowserWindow;
  private position: { x: number; y: number } = { x: 0, y: 0 };

  constructor(window: BrowserWindow) {
    this.window = window;

    // Listen for mouse position from renderer
    ipcMain.on('popup:motion', (_event, x: number, y: number) => {
      this.position = { x, y };
    });
  }

  showAt(x: number, y: number): void {
    this.position = { x, y };
    // Move window to position first, then show and focus
    this.window.setPosition(x, y, false);
    this.window.show();
    this.window.focus();
  }

  showCurrentPosition(): void {
    this.window.show();
  }

  close(): void {
    this.window.hide();
  }

  getPosition(): { x: number; y: number } {
    return this.position;
  }

  getWindow(): BrowserWindow {
    return this.window;
  }
}
