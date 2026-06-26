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

    // Close popup when it loses focus (click outside)
    this.window.on('blur', () => {
      if (this.window.isVisible()) {
        this.window.hide();
      }
    });

    // Also hide when the user presses the window close button or Alt+F4
    this.window.on('close', (e) => {
      e.preventDefault();
      this.window.hide();
    });
  }

  showAt(x: number, y: number): void {
    this.position = { x, y };
    // Move window to position first, then show and focus
    this.window.setPosition(x, y, false);
    this.window.show();
    this.window.focus();
    // Force focus on Wayland where .focus() may not work
    this.window.setAlwaysOnTop(true);
    this.window.moveTop();
  }

  showCurrentPosition(): void {
    this.window.show();
    this.window.focus();
    this.window.moveTop();
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