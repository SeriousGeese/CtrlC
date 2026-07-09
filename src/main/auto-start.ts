import * as path from 'node:path';
import * as fs from 'node:fs';
import os from 'node:os';
import { app } from 'electron';

const APP_NAME = 'ctrlc';
const DESKTOP_FILENAME = `${APP_NAME}.desktop`;

/**
 * Enable auto-start on login for the current platform.
 * Creates a .desktop file in the autostart directory on Linux.
 */
export function enableAutoStart(): void {
  if (process.platform !== 'linux') return;

  const autostartDir = path.join(os.homedir(), '.config', 'autostart');
  if (!fs.existsSync(autostartDir)) {
    fs.mkdirSync(autostartDir, { recursive: true, mode: 0o700 });
  }

  // In dev (process.defaultApp), execPath is the bare electron binary and
  // needs the app path as its first argument; a packaged binary must not
  // receive it.
  const executable = process.defaultApp
    ? `${process.execPath} ${app.getAppPath()}`
    : process.execPath;
  const desktopPath = path.join(autostartDir, DESKTOP_FILENAME);
  const iconPath = path.join(__dirname, '../../assets/tray-icon.png');

  const desktopContent = `[Desktop Entry]
Type=Application
GenericName=Clipboard Manager
Comment=Cross-platform clipboard manager
Exec=${executable} --silent
Icon=${iconPath}
Terminal=false
Categories=Utility;
StartupNotify=false
`;

  fs.writeFileSync(desktopPath, desktopContent, 'utf-8');
}

/**
 * Disable auto-start on login.
 * Removes the .desktop file from the autostart directory.
 */
export function disableAutoStart(): void {
  if (process.platform !== 'linux') return;

  const autostartDir = path.join(os.homedir(), '.config', 'autostart');
  const desktopPath = path.join(autostartDir, DESKTOP_FILENAME);

  if (fs.existsSync(desktopPath)) {
    fs.unlinkSync(desktopPath);
  }
}

/**
 * Check if auto-start is currently enabled.
 */
export function isAutoStartEnabled(): boolean {
  if (process.platform !== 'linux') return false;

  const autostartDir = path.join(os.homedir(), '.config', 'autostart');
  const desktopPath = path.join(autostartDir, DESKTOP_FILENAME);

  return fs.existsSync(desktopPath);
}
