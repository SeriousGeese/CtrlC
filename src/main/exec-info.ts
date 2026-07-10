import { app } from 'electron';

/**
 * The command that re-launches this app from outside (DE shortcuts,
 * autostart entries). Three cases:
 *  - AppImage: process.execPath points into the transient /tmp mount that
 *    changes every run — use the stable $APPIMAGE path instead.
 *  - Dev (process.defaultApp): the bare electron binary needs the app path
 *    as its first argument.
 *  - Packaged (deb/nsis/...): the binary is the app.
 */
export function launcherParts(): { execPath: string; appPath: string } {
  if (process.env.APPIMAGE) {
    return { execPath: process.env.APPIMAGE, appPath: '' };
  }
  if (process.defaultApp) {
    return { execPath: process.execPath, appPath: app.getAppPath() };
  }
  return { execPath: process.execPath, appPath: '' };
}
