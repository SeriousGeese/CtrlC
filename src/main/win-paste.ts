// Windows paste-on-select support.
//
// Two Windows realities make the naive approach (hide popup, SendKeys ^v)
// fail: hiding the focused always-on-top popup does NOT reliably hand focus
// back to the previous window, and a one-shot powershell.exe has 1-3s cold
// start, so the keystroke lands late and in whatever happens to be
// foreground — often nothing. This is why Ditto tracks the target HWND.
//
// We do the same without native modules: a persistent PowerShell helper
// (spawned once, driven over stdin) uses P/Invoke to
//   - capture GetForegroundWindow() right before the popup is shown
//   - on paste: SetForegroundWindow(captured) — with the documented Alt-tap
//     workaround if the foreground lock rejects us — then inject Ctrl+V via
//     keybd_event.
// Being persistent also removes the PowerShell startup latency from the
// paste path.

import { spawn, ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

// Written to the data dir at startup: PowerShell cannot execute a script
// from inside app.asar.
const HELPER_SCRIPT = `
$ErrorActionPreference = "Continue"
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class CtrlCNative {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
}
"@

function Send-CtrlV {
  [CtrlCNative]::keybd_event(0x11, 0, 0, [UIntPtr]::Zero)  # Ctrl down
  [CtrlCNative]::keybd_event(0x56, 0, 0, [UIntPtr]::Zero)  # V down
  [CtrlCNative]::keybd_event(0x56, 0, 2, [UIntPtr]::Zero)  # V up
  [CtrlCNative]::keybd_event(0x11, 0, 2, [UIntPtr]::Zero)  # Ctrl up
}

$target = [IntPtr]::Zero
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  switch ($line.Trim()) {
    "capture" {
      $target = [CtrlCNative]::GetForegroundWindow()
      [Console]::Out.WriteLine("captured " + $target)
    }
    "paste" {
      Start-Sleep -Milliseconds 120   # let the popup finish hiding
      if ($target -ne [IntPtr]::Zero) {
        if (-not [CtrlCNative]::SetForegroundWindow($target)) {
          # Foreground-lock workaround: a synthetic Alt tap makes this
          # process "keyboard-active" so SetForegroundWindow is allowed.
          [CtrlCNative]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)
          [CtrlCNative]::SetForegroundWindow($target) | Out-Null
          [CtrlCNative]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
        }
        Start-Sleep -Milliseconds 80
      }
      Send-CtrlV
      [Console]::Out.WriteLine("pasted")
    }
    "quit" { exit }
  }
}
`;

let helper: ChildProcess | null = null;
let helperScriptPath = '';

function helperAlive(): boolean {
  return helper !== null && helper.exitCode === null && !helper.killed;
}

/** Spawn the persistent helper (win32 only; safe to call repeatedly). */
export function ensureWinPasteHelper(dataDir: string): void {
  if (process.platform !== 'win32' || helperAlive()) return;
  try {
    helperScriptPath = path.join(dataDir, 'win-paste-helper.ps1');
    fs.writeFileSync(helperScriptPath, HELPER_SCRIPT, 'utf-8');

    helper = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helperScriptPath],
      { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
    );
    helper.stderr?.on('data', (d: Buffer) => {
      console.warn('[WinPaste] helper stderr:', d.toString().trim());
    });
    helper.on('exit', (code) => {
      console.warn(`[WinPaste] helper exited (code ${code})`);
      helper = null;
    });
    helper.on('error', (err) => {
      console.warn('[WinPaste] helper failed to start:', err.message);
      helper = null;
    });
    console.log('[WinPaste] persistent paste helper started');
  } catch (err) {
    console.warn('[WinPaste] could not start helper:', (err as Error).message);
    helper = null;
  }
}

/** Remember the currently focused window. Call right before showing the popup. */
export function captureForegroundWindow(): void {
  if (!helperAlive()) return;
  helper!.stdin?.write('capture\n');
}

/**
 * Re-activate the captured window and inject Ctrl+V. Resolves true when the
 * helper confirms, false when the helper is unavailable (caller falls back
 * to the one-shot SendKeys path).
 */
export function pasteToCapturedWindow(timeoutMs = 4000): Promise<boolean> {
  if (process.env.CTRLC_NO_PASTE_INJECT) return Promise.resolve(true);
  if (!helperAlive()) return Promise.resolve(false);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      helper?.stdout?.removeListener('data', onData);
      resolve(false);
    }, timeoutMs);
    const onData = (d: Buffer): void => {
      if (d.toString().includes('pasted')) {
        clearTimeout(timer);
        helper?.stdout?.removeListener('data', onData);
        resolve(true);
      }
    };
    helper!.stdout?.on('data', onData);
    helper!.stdin?.write('paste\n');
  });
}

export function stopWinPasteHelper(): void {
  if (helperAlive()) {
    try {
      helper!.stdin?.write('quit\n');
    } catch { /* already gone */ }
    helper!.kill();
  }
  helper = null;
}
