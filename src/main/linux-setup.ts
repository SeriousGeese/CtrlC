// First-run setup / teardown of the Linux Wayland integration pieces that
// live outside the app binary:
//
//  - ydotoold user service (paste injection needs the daemon; Bazzite/Fedora
//    ship the ydotool binary but no user unit, and /dev/uinput is already
//    user-writable there)
//  - the DE-level global shortcut + launcher (registered elsewhere at
//    runtime; removed here on teardown)
//  - the autostart entry and the KWin helper script file
//
// Setup is idempotent and best-effort: every step logs and degrades
// gracefully so the app still runs without paste injection.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { unregisterGlobalShortcut } from './desktop-shortcut';
import { disableAutoStart } from './auto-start';

const execFileAsync = promisify(execFile);

const YDOTOOLD_UNIT = 'ydotoold.service';

const YDOTOOLD_UNIT_CONTENT = `[Unit]
Description=ydotool user daemon (virtual input via /dev/uinput, used by CtrlC paste)

[Service]
ExecStart=/usr/bin/ydotoold --socket-path=%t/.ydotool_socket
Restart=on-failure

[Install]
WantedBy=default.target
`;

function userUnitPath(): string {
  return path.join(os.homedir(), '.config', 'systemd', 'user', YDOTOOLD_UNIT);
}

async function has(cmd: string): Promise<boolean> {
  try {
    await execFileAsync('which', [cmd], { timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Make sure ydotoold is running for paste injection on Wayland. No-op when
 * not on a Wayland session, when ydotool isn't installed, or when a socket
 * already exists (e.g. the distro runs its own system service).
 */
export async function ensureYdotoold(): Promise<void> {
  const onWayland =
    process.platform === 'linux' &&
    (!!process.env.WAYLAND_DISPLAY || process.env.XDG_SESSION_TYPE === 'wayland');
  if (!onWayland) return;

  const socket = path.join(process.env.XDG_RUNTIME_DIR || '/tmp', '.ydotool_socket');
  if (fs.existsSync(socket)) return; // some daemon already provides it

  if (!(await has('ydotoold')) || !(await has('systemctl'))) {
    console.warn(
      '[LinuxSetup] ydotoold not available — paste injection disabled. ' +
        'Install ydotool for paste-on-select.',
    );
    return;
  }

  try {
    const unitPath = userUnitPath();
    if (!fs.existsSync(unitPath)) {
      fs.mkdirSync(path.dirname(unitPath), { recursive: true });
      fs.writeFileSync(unitPath, YDOTOOLD_UNIT_CONTENT, 'utf-8');
      await execFileAsync('systemctl', ['--user', 'daemon-reload'], { timeout: 10000 });
    }
    await execFileAsync('systemctl', ['--user', 'enable', '--now', YDOTOOLD_UNIT], {
      timeout: 10000,
    });
    console.log('[LinuxSetup] ydotoold user service enabled (paste injection)');
  } catch (err) {
    console.warn('[LinuxSetup] Could not enable ydotoold:', (err as Error).message);
  }
}

/**
 * Remove everything CtrlC installed outside its own binary/data dir.
 * Invoked via `ctrlc --teardown` (used by uninstallers; safe to run twice).
 * Clipboard history in ~/.CtrlC is left alone.
 */
export async function teardownLinuxIntegration(dataDir: string): Promise<void> {
  if (process.platform !== 'linux') return;

  // Autostart entry + DE-level shortcut and its launcher .desktop
  try { disableAutoStart(); } catch { /* best-effort */ }
  await unregisterGlobalShortcut().catch(() => undefined);

  // ydotoold user unit (only if it's ours — identified by the description)
  try {
    const unitPath = userUnitPath();
    if (fs.existsSync(unitPath) && fs.readFileSync(unitPath, 'utf-8').includes('used by CtrlC')) {
      await execFileAsync('systemctl', ['--user', 'disable', '--now', YDOTOOLD_UNIT], {
        timeout: 10000,
      }).catch(() => undefined);
      fs.unlinkSync(unitPath);
      await execFileAsync('systemctl', ['--user', 'daemon-reload'], { timeout: 10000 })
        .catch(() => undefined);
    }
  } catch { /* best-effort */ }

  // KWin helper script file (KWin drops the loaded copy on next restart)
  try {
    const helper = path.join(dataDir, 'kwin-helper.js');
    if (fs.existsSync(helper)) fs.unlinkSync(helper);
  } catch { /* best-effort */ }

  console.log('[LinuxSetup] Teardown complete (clipboard history in ~/.CtrlC was kept)');
}
