import { globalShortcut } from 'electron';
import { EventEmitter } from 'node:events';
import { BrowserWindow } from 'electron';
import { PopupPositionMode } from '../../shared/types';
import { computePopupPosition } from '../popup/position';

export class HotkeyManager extends EventEmitter {
  private hotkey: string;
  private mainWindowRef: BrowserWindow;
  private getPositionMode: () => PopupPositionMode;

  constructor(
    mainWindow: BrowserWindow,
    hotkey: string,
    getPositionMode: () => PopupPositionMode = () => 'mouse',
  ) {
    super();
    this.mainWindowRef = mainWindow;
    this.hotkey = hotkey;
    this.getPositionMode = getPositionMode;
    this.registerHotkey(hotkey);
  }

  registerHotkey(hotkey: string): boolean {
    // Normalize hotkey for Linux
    let normalizedHotkey = hotkey;
    if (process.platform === 'linux') {
      normalizedHotkey = hotkey
        .replace('CommandOrControl', 'Ctrl')
        .replace('Command', 'Super');
    }

    // Electron 42's accelerator parser doesn't accept 'Backquote' as a key
    // name — it expects the actual backtick character. Replace any variant.
    normalizedHotkey = normalizedHotkey.replace(/[Bb]ackquote/g, '`');

    this.hotkey = normalizedHotkey;

    // On a Wayland session the compositor owns global shortcuts.
    // globalShortcut.register() either false-positively returns true (native
    // Wayland backend) or grabs at the X11 level where it only fires while
    // another XWayland window is focused. Neither works, so report failure
    // immediately — main.ts then registers a compositor-level shortcut
    // (GNOME gsettings / KDE kglobalshortcutsrc) that runs `ctrlc --show-popup`.
    const waylandSession =
      process.platform === 'linux' &&
      (!!process.env.WAYLAND_DISPLAY || process.env.XDG_SESSION_TYPE === 'wayland');
    if (waylandSession) {
      console.log(
        `[CtrlC] Wayland session detected — delegating hotkey "${normalizedHotkey}" to the desktop environment.`,
      );
      setImmediate(() => this.emit('hotkey-registered', false, normalizedHotkey));
      return false;
    }

    const ok = globalShortcut.register(normalizedHotkey, () => {
      const { x, y } = computePopupPosition(this.getPositionMode());
      this.emit('hotkey-pressed', x, y);
    });

    // globalShortcut.register() returns false on failure. On Wayland the
    // compositor owns global shortcuts, so this commonly fails silently —
    // surface it so the user knows to bind a compositor-level shortcut to
    // `ctrlc --show-popup` instead (handled via the single-instance hook).
    const registered = ok && globalShortcut.isRegistered(normalizedHotkey);
    if (!registered) {
      const onWayland =
        process.platform === 'linux' &&
        (process.env.WAYLAND_DISPLAY || process.env.XDG_SESSION_TYPE === 'wayland');
      console.warn(
        `[CtrlC] Global hotkey "${normalizedHotkey}" failed to register.` +
          (onWayland
            ? ' Wayland blocks app-level global shortcuts. Bind a custom' +
              ' compositor shortcut (GNOME/KDE Settings) to the command' +
              ' "ctrlc --show-popup" to open the popup.'
            : ' It may conflict with another application.'),
      );
    } else {
      console.log(`[CtrlC] Global hotkey registered: ${normalizedHotkey}`);
    }
    // Defer the event so listeners attached right after construction (in
    // main.ts) still receive it — the constructor calls this synchronously.
    setImmediate(() => this.emit('hotkey-registered', registered, normalizedHotkey));
    return registered;
  }

  /** Trigger the popup programmatically (used by the --show-popup CLI hook). */
  triggerPopup(): void {
    const { x, y } = computePopupPosition(this.getPositionMode());
    this.emit('hotkey-pressed', x, y);
  }

  removeHotkey(): void {
    globalShortcut.unregister(this.hotkey);
  }

  destroy(): void {
    globalShortcut.unregisterAll();
  }
}
