// Synthesize a Ctrl+V keystroke into whatever window has focus, so picking a
// clip pastes it directly (Ditto behavior) instead of just copying.
//
// Linux tool order:
//  - ydotool: injects via /dev/uinput, works for both Wayland and X11
//    targets. Needs ydotoold running (Bazzite ships it as a user service).
//  - xdotool: X server injection; only reaches XWayland windows on a
//    Wayland session, but better than nothing when ydotoold is down.
// If neither works the clip is still on the clipboard — the user pastes
// manually. We log the failure once per session.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as path from 'node:path';

const execFileAsync = promisify(execFile);

// uinput key codes: KEY_LEFTCTRL=29, KEY_V=47 (":1" press, ":0" release)
const YDOTOOL_CTRL_V = ['key', '29:1', '47:1', '47:0', '29:0'];

/** ydotoold (user service) puts its socket in XDG_RUNTIME_DIR. */
function ydotoolEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    YDOTOOL_SOCKET:
      process.env.YDOTOOL_SOCKET ||
      path.join(process.env.XDG_RUNTIME_DIR || '/tmp', '.ydotool_socket'),
  };
}

let warnedNoTool = false;

export async function synthesizePaste(): Promise<boolean> {
  // Test hook: exercise the full selection flow without injecting keys into
  // whatever window regains focus.
  if (process.env.CTRLC_NO_PASTE_INJECT) return false;

  if (process.platform === 'win32') {
    // WScript.Shell SendKeys — no native module needed. ^v = Ctrl+V.
    try {
      await execFileAsync(
        'powershell',
        ['-NoProfile', '-NonInteractive', '-Command',
          '$w = New-Object -ComObject WScript.Shell; $w.SendKeys("^v")'],
        { timeout: 5000, windowsHide: true },
      );
      return true;
    } catch {
      return false;
    }
  }

  if (process.platform === 'darwin') {
    // System Events keystroke = Cmd+V into the frontmost app. Requires the
    // user to grant CtrlC Accessibility permission (System Settings >
    // Privacy & Security > Accessibility); without it osascript errors and we
    // fall through to the manual-paste warning below.
    try {
      await execFileAsync(
        'osascript',
        ['-e', 'tell application "System Events" to keystroke "v" using command down'],
        { timeout: 5000 },
      );
      return true;
    } catch {
      if (!warnedNoTool) {
        warnedNoTool = true;
        console.warn(
          '[Paste] Could not synthesize Cmd+V. Grant CtrlC Accessibility ' +
            'permission (System Settings > Privacy & Security > Accessibility) ' +
            'to enable auto-paste. The clip is on the clipboard — paste manually.',
        );
      }
      return false;
    }
  }

  try {
    await execFileAsync('ydotool', YDOTOOL_CTRL_V, { timeout: 3000, env: ydotoolEnv() });
    return true;
  } catch {
    // daemon not running or tool missing — try X11 injection
  }

  try {
    await execFileAsync('xdotool', ['key', '--clearmodifiers', 'ctrl+v'], {
      timeout: 3000,
    });
    return true;
  } catch {
    // no X display or tool missing
  }

  if (!warnedNoTool) {
    warnedNoTool = true;
    console.warn(
      '[Paste] Could not synthesize Ctrl+V (tried ydotool, xdotool). ' +
        'The clip is on the clipboard — paste manually. For Wayland-wide ' +
        'paste, enable ydotoold: systemctl --user enable --now ydotool',
    );
  }
  return false;
}
