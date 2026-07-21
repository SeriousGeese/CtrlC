// Windows elevation support.
//
// On Windows, a non-elevated process cannot inject keystrokes (keybd_event,
// SendKeys, SendInput) into a window with a higher integrity level (i.e. an
// admin window). Windows UIPI (User Interface Privilege Isolation) blocks
// cross-integrity-level input injection.
//
// CtrlC handles this the same way PowerToys does:
//  1. The app CAN run as administrator — the NSIS installer installs
//     per-machine so it's available to all users.
//  2. A tray menu item lets the user "Restart as Administrator" on demand.
//  3. When auto-start + elevated mode is enabled, a Task Scheduler task runs
//     the app at logon with highest privileges (requires no UAC prompt on
//     subsequent logins).
//  4. The app detects its elevation state at startup and adapts.

import { app } from 'electron';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { launcherParts } from './exec-info';

const execFileAsync = promisify(execFile);

const ELEVATED_TASK_NAME = 'CtrlC';

/**
 * Check whether the current process is running with elevated (admin)
 * privileges on Windows. On non-Windows platforms, always returns false.
 *
 * Uses a lightweight PowerShell check that calls the .NET security principal
 * APIs — no native modules, runs in ~50ms.
 */
export async function isElevated(): Promise<boolean> {
  if (process.platform !== 'win32') return false;

  try {
    const { stdout } = await execFileAsync(
      'powershell',
      [
        '-NoProfile', '-NonInteractive', '-Command',
        '[Security.Principal.WindowsPrincipal]::new(' +
          '[Security.Principal.WindowsIdentity]::GetCurrent()' +
        ').IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)',
      ],
      { timeout: 10000, windowsHide: true },
    );
    return stdout.trim() === 'True';
  } catch {
    return false;
  }
}

/**
 * Spawn a new elevated instance and quit the current one.
  *
  * Uses PowerShell Start-Process -Verb RunAs directly on the target
  * executable, which shows a UAC prompt on non-elevated sessions and is a
  * no-op UAC-wise on already-elevated sessions (the new instance still starts
  * elevated). If the user cancels UAC, the current instance continues.
  *
  * For packaged builds: Start-Process on the app EXE with --silent
  * For dev builds: Start-Process on electron.exe with the app path
  */
 export function restartAsAdmin(): void {
   if (process.platform !== 'win32') return;

   const launcher = launcherParts();
   const args = launcher.appPath
     ? `"${launcher.appPath}" --silent`
     : '--silent';

   const psCmd = [
     '-NoProfile', '-NonInteractive', '-Command',
     `Start-Process -FilePath "${launcher.execPath}" -Verb RunAs -ArgumentList '${args}'`,
   ];

   void (async () => {
     try {
       await execFileAsync('powershell', psCmd, { timeout: 30000, windowsHide: true });
     } catch {
       // UAC was cancelled — keep running as-is
     }
   })();

   // Give the elevated child a moment to start, then quit.
   setTimeout(() => app.exit(0), 1500);
 }

/**
 * Enable elevated auto-start via a Windows Task Scheduler task.
 * This creates a task that runs CtrlC at user logon with highest privileges
 * (no UAC prompt on login). Idempotent — safe to call on every startup.
 */
export async function enableElevatedAutoStart(): Promise<boolean> {
  if (process.platform !== 'win32') return false;

  const launcher = launcherParts();
  const executable = launcher.appPath
    ? `"${launcher.execPath}" "${launcher.appPath}" --silent`
    : `"${launcher.execPath}" --silent`;

  try {
    await execFileAsync('schtasks', [
      '/CREATE', '/F',                    // /F = force overwrite if exists
      '/TN', ELEVATED_TASK_NAME,
      '/TR', executable,
      '/SC', 'ONLOGON',
      '/RL', 'HIGHEST',                   // run with highest privileges
      '/IT',                              // run only when user is logged on
      '/DELAY', '0001:00',                // 1-minute delay after logon
    ], { timeout: 15000, windowsHide: true });
    return true;
  } catch (err) {
    console.warn('[Elevate] Failed to create elevated auto-start task:', (err as Error).message);
    return false;
  }
}

/**
 * Disable the elevated auto-start Task Scheduler task. Safe to call even
 * when the task doesn't exist (schtasks /DELETE /F does not error on
 * missing tasks).
 */
export async function disableElevatedAutoStart(): Promise<void> {
  if (process.platform !== 'win32') return;

  try {
    await execFileAsync('schtasks', [
      '/DELETE', '/F',
      '/TN', ELEVATED_TASK_NAME,
    ], { timeout: 10000, windowsHide: true });
  } catch {
    // task doesn't exist or was already removed
  }
}

/**
 * Check whether the elevated auto-start task exists and is enabled.
 */
export async function isElevatedAutoStartEnabled(): Promise<boolean> {
  if (process.platform !== 'win32') return false;

  try {
    await execFileAsync('schtasks', [
      '/QUERY', '/TN', ELEVATED_TASK_NAME,
    ], { timeout: 10000, windowsHide: true });
    return true;
  } catch {
    return false;
  }
}