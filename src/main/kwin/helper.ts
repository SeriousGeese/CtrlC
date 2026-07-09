// KWin scripting helper for KDE Plasma Wayland.
//
// Under XWayland, Electron only sees the mouse while it's over an X11 window
// (stale otherwise), and it can neither see nor re-activate native-Wayland
// windows (so paste-after-popup lands in the wrong app). KWin scripts can do
// all of that, and they can be poked from outside via kglobalaccel's
// invokeShortcut D-Bus method — no data channel needed:
//
//  - The script continuously tracks the last non-CtrlC active window.
//  - "CtrlCRestoreFocus" re-activates it (called before injecting Ctrl+V).
//  - "CtrlCPlacePopup" moves the popup to the real cursor position, clamped
//    to that output's placement area, and focuses it.
//
// Everything is best-effort: on non-KDE or X11 sessions these are no-ops and
// callers fall back to Electron/xdotool behavior.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs';
import * as path from 'node:path';

const execFileAsync = promisify(execFile);

const RESTORE_FOCUS_SHORTCUT = 'CtrlCRestoreFocus';
const PLACE_POPUP_SHORTCUT = 'CtrlCPlacePopup';
const PLACE_POPUP_CENTER_SHORTCUT = 'CtrlCPlacePopupCenter';

// Keep in sync with popup/position.ts POINTER_GAP
const HELPER_SCRIPT = `
var ctrlcPrev = null;

workspace.windowActivated.connect(function (w) {
  if (w && w.resourceClass !== "ctrlc") {
    ctrlcPrev = w;
  }
});

function ctrlcPopupWindow() {
  var list = workspace.windowList();
  for (var i = 0; i < list.length; i++) {
    var w = list[i];
    if (w.resourceClass === "ctrlc" && w.caption === "CtrlC") {
      return w;
    }
  }
  return null;
}

function ctrlcCursorArea() {
  var c = workspace.cursorPos;
  var scr = workspace.activeScreen;
  var screens = workspace.screens;
  for (var j = 0; j < screens.length; j++) {
    var sg = screens[j].geometry;
    if (c.x >= sg.x && c.x < sg.x + sg.width && c.y >= sg.y && c.y < sg.y + sg.height) {
      scr = screens[j];
      break;
    }
  }
  return workspace.clientArea(KWin.PlacementArea, scr, workspace.currentDesktop);
}

registerShortcut("${RESTORE_FOCUS_SHORTCUT}", "CtrlC: restore previous focus (internal)", "", function () {
  if (ctrlcPrev && !ctrlcPrev.deleted) {
    workspace.activeWindow = ctrlcPrev;
  }
});

registerShortcut("${PLACE_POPUP_SHORTCUT}", "CtrlC: place popup at cursor (internal)", "", function () {
  var w = ctrlcPopupWindow();
  if (!w) { return; }
  var c = workspace.cursorPos;
  var area = ctrlcCursorArea();
  var g = w.frameGeometry;
  var x = Math.min(Math.max(c.x, area.x), area.x + area.width - g.width);
  var y = c.y + 12;
  if (y + g.height > area.y + area.height) {
    y = c.y - g.height - 12;
  }
  if (y < area.y) {
    y = area.y;
  }
  w.frameGeometry = { x: Math.round(x), y: Math.round(y), width: g.width, height: g.height };
  workspace.activeWindow = w;
});

registerShortcut("${PLACE_POPUP_CENTER_SHORTCUT}", "CtrlC: center popup on cursor screen (internal)", "", function () {
  var w = ctrlcPopupWindow();
  if (!w) { return; }
  var area = ctrlcCursorArea();
  var g = w.frameGeometry;
  w.frameGeometry = {
    x: Math.round(area.x + (area.width - g.width) / 2),
    y: Math.round(area.y + (area.height - g.height) / 2),
    width: g.width,
    height: g.height
  };
  workspace.activeWindow = w;
});
`;

let helperLoaded = false;

export function isKdeWaylandSession(env: NodeJS.ProcessEnv = process.env): boolean {
  const desktop = (env.XDG_CURRENT_DESKTOP || '').toLowerCase();
  const wayland = !!env.WAYLAND_DISPLAY || env.XDG_SESSION_TYPE === 'wayland';
  return process.platform === 'linux' && wayland && desktop.includes('kde');
}

async function kwinScripting(method: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(
    'busctl',
    ['--user', 'call', 'org.kde.KWin', '/Scripting', 'org.kde.kwin.Scripting', method, ...args],
    { timeout: 5000 },
  );
  return stdout.trim();
}

/**
 * Install and start the helper script in the running KWin. Idempotent per
 * app run; safe to call on every startup (reloads the script so edits and
 * app upgrades take effect).
 */
export async function ensureKWinHelper(dataDir: string): Promise<boolean> {
  if (!isKdeWaylandSession()) return false;
  if (helperLoaded) return true;

  try {
    const scriptPath = path.join(dataDir, 'kwin-helper.js');
    fs.writeFileSync(scriptPath, HELPER_SCRIPT, 'utf-8');

    // Unload a stale copy from a previous app run, then load and start.
    await kwinScripting('unloadScript', ['s', scriptPath]).catch(() => '');
    const idRaw = await kwinScripting('loadScript', ['s', scriptPath]);
    const id = idRaw.split(/\s+/).pop();
    await execFileAsync(
      'busctl',
      ['--user', 'call', 'org.kde.KWin', `/Scripting/Script${id}`, 'org.kde.kwin.Script', 'run'],
      { timeout: 5000 },
    );
    helperLoaded = true;
    console.log('[KWinHelper] Helper script loaded (focus restore + popup placement)');
    return true;
  } catch (err) {
    console.warn('[KWinHelper] Could not load KWin helper script:', (err as Error).message);
    return false;
  }
}

async function invokeShortcut(name: string): Promise<boolean> {
  try {
    await execFileAsync(
      'busctl',
      ['--user', 'call', 'org.kde.kglobalaccel', '/component/kwin',
        'org.kde.kglobalaccel.Component', 'invokeShortcut', 's', name],
      { timeout: 3000 },
    );
    return true;
  } catch {
    return false;
  }
}

/** Re-activate the window that was focused before the popup appeared. */
export async function restorePreviousFocus(): Promise<boolean> {
  if (!helperLoaded) return false;
  return invokeShortcut(RESTORE_FOCUS_SHORTCUT);
}

/** Move the popup to the true (Wayland) cursor position and focus it. */
export async function placePopupAtCursor(): Promise<boolean> {
  if (!helperLoaded) return false;
  return invokeShortcut(PLACE_POPUP_SHORTCUT);
}

/** Center the popup on the screen the (true) cursor is on, and focus it. */
export async function placePopupCenterCursorScreen(): Promise<boolean> {
  if (!helperLoaded) return false;
  return invokeShortcut(PLACE_POPUP_CENTER_SHORTCUT);
}
