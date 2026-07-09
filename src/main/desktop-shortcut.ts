// Desktop-environment global shortcut registration.
//
// WHY THIS EXISTS: On Wayland, Electron's globalShortcut.register() is owned by
// the compositor and fails silently. The portable workaround is to register a
// shortcut at the DE level that runs `ctrlc --show-popup`, which the running
// instance intercepts via the single-instance hook (see main.ts).
//
// Supports GNOME (gsettings custom keybindings) and KDE Plasma
// (kglobalshortcutsrc + a .desktop launcher). Everything else is a no-op with
// a helpful log so packaging on other DEs degrades gracefully.

import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type DesktopEnv = 'gnome' | 'kde' | 'unknown';

const APP_ID = 'dev.seriousgeese.ctrlc-popup';
const DESKTOP_FILENAME = `${APP_ID}.desktop`;
const GNOME_BINDING_NAME = 'CtrlC Show Popup';

/** Detect the current desktop environment from XDG env vars. */
export function detectDesktopEnv(
  env: NodeJS.ProcessEnv = process.env,
): DesktopEnv {
  const raw = (env.XDG_CURRENT_DESKTOP || env.DESKTOP_SESSION || '').toLowerCase();
  if (raw.includes('gnome')) return 'gnome';
  if (raw.includes('kde') || raw.includes('plasma')) return 'kde';
  return 'unknown';
}

/**
 * Convert an Electron accelerator (e.g. "CommandOrControl+`") to the format the
 * given DE expects. Both GNOME and KDE accept the same human form here
 * ("<Control>grave" for GNOME, "Ctrl+`" for KDE), so we return per-DE strings.
 */
export function toGnomeAccelerator(electronAccel: string): string {
  // GNOME uses GTK accelerator syntax: <Control>, <Shift>, <Alt>, <Super>.
  // Tokenize on '+' so modifier names can't match inside an already-substituted
  // token (e.g. the "Control" inside "<Control>").
  const modMap: Record<string, string> = {
    commandorcontrol: '<Control>',
    cmdorctrl: '<Control>',
    control: '<Control>',
    ctrl: '<Control>',
    command: '<Super>',
    super: '<Super>',
    meta: '<Super>',
    shift: '<Shift>',
    alt: '<Alt>',
    option: '<Alt>',
  };
  const keyMap: Record<string, string> = {
    '`': 'grave',
    backquote: 'grave',
  };
  const parts = electronAccel.split('+');
  return parts
    .map((part) => {
      const key = part.toLowerCase();
      if (modMap[key]) return modMap[key];
      if (keyMap[key]) return keyMap[key];
      return part;
    })
    .join('');
}

/**
 * Convert an Electron accelerator to a Qt key code (modifier bits | key) for
 * kglobalaccel's D-Bus setShortcut call. Returns null for keys we can't map.
 */
export function toQtKeyCode(electronAccel: string): number | null {
  const QT_MOD: Record<string, number> = {
    shift: 0x02000000,
    commandorcontrol: 0x04000000,
    cmdorctrl: 0x04000000,
    control: 0x04000000,
    ctrl: 0x04000000,
    alt: 0x08000000,
    option: 0x08000000,
    command: 0x10000000,
    super: 0x10000000,
    meta: 0x10000000,
  };
  const QT_KEY: Record<string, number> = {
    backquote: 0x60, // Qt::Key_QuoteLeft
    '`': 0x60,
    space: 0x20,
    tab: 0x01000001,
    return: 0x01000004,
    enter: 0x01000004,
    escape: 0x01000000,
    backspace: 0x01000003,
    delete: 0x01000007,
    insert: 0x01000006,
    home: 0x01000010,
    end: 0x01000011,
    pageup: 0x01000016,
    pagedown: 0x01000017,
    up: 0x01000013,
    down: 0x01000015,
    left: 0x01000012,
    right: 0x01000014,
  };

  let code = 0;
  let haveKey = false;
  for (const part of electronAccel.split('+')) {
    const p = part.toLowerCase();
    if (QT_MOD[p] !== undefined) {
      code |= QT_MOD[p];
    } else if (QT_KEY[p] !== undefined) {
      code |= QT_KEY[p];
      haveKey = true;
    } else if (/^f([1-9]|[12][0-9]|3[0-5])$/.test(p)) {
      code |= 0x01000030 + (parseInt(p.slice(1), 10) - 1); // Qt::Key_F1..F35
      haveKey = true;
    } else if (part.length === 1) {
      // Printable single characters map to their uppercase ASCII code in Qt
      code |= part.toUpperCase().charCodeAt(0);
      haveKey = true;
    } else {
      return null;
    }
  }
  return haveKey ? code : null;
}

export function toKdeAccelerator(electronAccel: string): string {
  // KDE QKeySequence: "Ctrl+`", "Meta+Shift+S", etc.
  return electronAccel
    .replace(/CommandOrControl/gi, 'Ctrl')
    .replace(/CmdOrCtrl/gi, 'Ctrl')
    .replace(/Command/gi, 'Meta')
    .replace(/Super/gi, 'Meta')
    .replace(/Option/gi, 'Alt');
}

/** Build the .desktop launcher contents used by the KDE _launch shortcut. */
export function buildDesktopLauncher(
  execPath: string,
  appPath: string,
  iconPath: string,
): string {
  // %u/%f intentionally omitted — we always pass --show-popup.
  return `[Desktop Entry]
Type=Application
Name=CtrlC: Show Popup
Comment=Open the CtrlC clipboard popup
Exec=${execPath} ${appPath} --show-popup
Icon=${iconPath}
Terminal=false
NoDisplay=true
Categories=Utility;
StartupNotify=false
`;
}

interface RegisterOptions {
  execPath: string;   // electron binary (process.execPath)
  appPath: string;    // app dir / main script (process.argv[1] or app root)
  iconPath: string;
  hotkey: string;     // Electron accelerator, e.g. "CommandOrControl+`"
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
}

export interface RegisterResult {
  ok: boolean;
  env: DesktopEnv;
  message: string;
  conflict?: string; // name of an app already holding the shortcut, if detected
}

/**
 * Register the global shortcut for the detected DE. Idempotent: safe to call on
 * every startup. Returns a result describing what happened (never throws).
 */
export async function registerGlobalShortcut(
  opts: RegisterOptions,
): Promise<RegisterResult> {
  const env = detectDesktopEnv(opts.env);
  try {
    if (env === 'gnome') return await registerGnome(opts);
    if (env === 'kde') return await registerKde(opts);
    return {
      ok: false,
      env,
      message:
        'Unsupported desktop environment for auto-registration. Bind a custom ' +
        'shortcut manually to run: <electron> <app> --show-popup',
    };
  } catch (err) {
    return {
      ok: false,
      env,
      message: `Shortcut registration failed: ${(err as Error).message}`,
    };
  }
}

// ---------------------------------------------------------------------------
// GNOME
// ---------------------------------------------------------------------------

const GNOME_SCHEMA = 'org.gnome.settings-daemon.plugins.media-keys';
const GNOME_CUSTOM_PATH =
  '/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/';
const GNOME_CTRLC_DIR = 'ctrlc-show-popup';

async function gsettings(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('gsettings', args);
  return stdout.trim();
}

/** Parse gsettings array output like "['a', 'b']" into a string[]. */
export function parseGnomeArray(raw: string): string[] {
  const trimmed = raw.trim();
  if (trimmed === '@as []' || trimmed === '[]' || trimmed === '') return [];
  const inner = trimmed.replace(/^@as\s*/, '').replace(/^\[/, '').replace(/\]$/, '');
  if (!inner.trim()) return [];
  return inner
    .split(',')
    .map((s) => s.trim().replace(/^'/, '').replace(/'$/, ''))
    .filter((s) => s.length > 0);
}

/** Serialize a string[] into the gsettings array literal form. */
export function serializeGnomeArray(items: string[]): string {
  if (items.length === 0) return '[]';
  return '[' + items.map((i) => `'${i}'`).join(', ') + ']';
}

async function registerGnome(opts: RegisterOptions): Promise<RegisterResult> {
  const dirPath = `${GNOME_CUSTOM_PATH}${GNOME_CTRLC_DIR}/`;

  // 1. Ensure our custom path is in the list of custom-keybindings.
  const raw = await gsettings(['get', GNOME_SCHEMA, 'custom-keybindings']);
  const list = parseGnomeArray(raw);
  if (!list.includes(dirPath)) {
    list.push(dirPath);
    await gsettings([
      'set',
      GNOME_SCHEMA,
      'custom-keybindings',
      serializeGnomeArray(list),
    ]);
  }

  // 2. Configure the binding's name/command/binding on the relocatable schema.
  const schemaPath = `${GNOME_SCHEMA}.custom-keybinding:${dirPath}`;
  const command = `${opts.execPath} ${opts.appPath} --show-popup`;
  const accel = toGnomeAccelerator(opts.hotkey);

  await gsettings(['set', schemaPath, 'name', GNOME_BINDING_NAME]);
  await gsettings(['set', schemaPath, 'command', command]);
  await gsettings(['set', schemaPath, 'binding', accel]);

  return {
    ok: true,
    env: 'gnome',
    message: `Registered GNOME shortcut "${accel}" → ${command}`,
  };
}

// ---------------------------------------------------------------------------
// KDE Plasma
// ---------------------------------------------------------------------------

async function kwriteconfig(args: string[], env?: NodeJS.ProcessEnv): Promise<void> {
  // Prefer the Plasma 6 tool; fall back to the Qt5 one.
  const tool = (await which('kwriteconfig6')) ? 'kwriteconfig6' : 'kwriteconfig5';
  await execFileAsync(tool, args, env ? { env } : undefined);
}

async function which(cmd: string): Promise<boolean> {
  try {
    await execFileAsync('command', ['-v', cmd]);
    return true;
  } catch {
    try {
      await execFileAsync('which', [cmd]);
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Detect whether another app already holds the given KDE shortcut in
 * kglobalshortcutsrc. Returns the friendly group name if found.
 */
export function findKdeConflict(
  kglobalContents: string,
  kdeAccel: string,
): string | undefined {
  // Match the accelerator appearing as an assigned key (very rough but useful
  // for warning the user). We look for the accel followed by \t or end.
  const lines = kglobalContents.split('\n');
  let currentGroup = '';
  const needle = kdeAccel.toLowerCase();
  for (const line of lines) {
    // Group headers may be nested: "[services][org.kde.spectacle.desktop]".
    // Capture the entire bracketed header (minus the outer brackets) as the
    // group identity so nested groups are reported in full.
    const groupMatch = line.match(/^\[(.+)\]\s*$/);
    if (groupMatch) {
      currentGroup = groupMatch[1];
      continue;
    }
    // Entries look like:  Name=Accel\tAltAccel,default,friendly
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const value = line.slice(eq + 1);
    const assigned = value.split(',')[0]; // first field is the active accel(s)
    const accels = assigned.split('\\t').map((a) => a.trim().toLowerCase());
    if (accels.includes(needle)) {
      return currentGroup;
    }
  }
  return undefined;
}

async function registerKde(opts: RegisterOptions): Promise<RegisterResult> {
  const home = opts.homeDir || os.homedir();
  const accel = toKdeAccelerator(opts.hotkey);

  // 1. Check for an existing conflict (e.g. CopyQ on Ctrl+`).
  let conflict: string | undefined;
  const kglobalPath = path.join(home, '.config', 'kglobalshortcutsrc');
  if (fs.existsSync(kglobalPath)) {
    const contents = fs.readFileSync(kglobalPath, 'utf-8');
    conflict = findKdeConflict(contents, accel);
    // Our own entry from a previous run is not a conflict.
    if (conflict?.includes(DESKTOP_FILENAME)) {
      conflict = undefined;
    }
  }

  // 2. Install the .desktop launcher.
  const appsDir = path.join(home, '.local', 'share', 'applications');
  if (!fs.existsSync(appsDir)) {
    fs.mkdirSync(appsDir, { recursive: true });
  }
  const desktopPath = path.join(appsDir, DESKTOP_FILENAME);
  fs.writeFileSync(
    desktopPath,
    buildDesktopLauncher(opts.execPath, opts.appPath, opts.iconPath),
    'utf-8',
  );

  // 3. Register the _launch shortcut in kglobalshortcutsrc.
  // Group: [services][<appid>.desktop], key: _launch
  // kwriteconfig writes to $XDG_CONFIG_HOME (or $HOME/.config), so when a
  // homeDir override is supplied (tests / sandboxing), point those env vars
  // at it so we never clobber the user's real config unexpectedly.
  const childEnv: NodeJS.ProcessEnv | undefined = opts.homeDir
    ? {
        ...(opts.env || process.env),
        HOME: opts.homeDir,
        XDG_CONFIG_HOME: path.join(opts.homeDir, '.config'),
      }
    : undefined;
  if (childEnv && !fs.existsSync(childEnv.XDG_CONFIG_HOME as string)) {
    fs.mkdirSync(childEnv.XDG_CONFIG_HOME as string, { recursive: true });
  }
  await kwriteconfig(
    [
      '--file',
      'kglobalshortcutsrc',
      '--group',
      'services',
      '--group',
      DESKTOP_FILENAME,
      '--key',
      '_launch',
      `${accel}\t`,
    ],
    childEnv,
  );

  // 4. Activate the shortcut in the running kglobalaccel via D-Bus. Without
  // this, the kglobalshortcutsrc entry only takes effect on next login. This
  // is the same doRegister + setShortcut sequence KDE System Settings uses.
  const activated = await activateKdeShortcut(opts.hotkey);
  if (!activated) {
    // Fall back to nudging the daemon to reload its config.
    await reloadKglobalaccel();
  }

  const base = `Registered KDE shortcut "${accel}" → ${desktopPath}`;
  return {
    ok: true,
    env: 'kde',
    message: conflict
      ? `${base}. WARNING: "${accel}" appears already bound by "${conflict}".`
      : base,
    conflict,
  };
}

/**
 * Register the _launch shortcut with the live kglobalaccel daemon over D-Bus
 * (busctl ships with systemd, so it's present on any modern KDE host).
 * Returns true when the daemon accepted the shortcut.
 */
async function activateKdeShortcut(hotkey: string): Promise<boolean> {
  const qtCode = toQtKeyCode(hotkey);
  if (qtCode === null) return false;

  const actionId = [DESKTOP_FILENAME, '_launch', 'CtrlC: Show Popup', 'CtrlC: Show Popup'];
  const dest = ['org.kde.kglobalaccel', '/kglobalaccel', 'org.kde.KGlobalAccel'];
  try {
    await execFileAsync('busctl', [
      '--user', 'call', ...dest, 'doRegister', 'as', '4', ...actionId,
    ]);
    // flags=2 (SetPresent): make the shortcut active immediately
    const { stdout } = await execFileAsync('busctl', [
      '--user', 'call', ...dest, 'setShortcut', 'asaiu',
      '4', ...actionId, '1', String(qtCode), '2',
    ]);
    // Reply is the accepted key list, e.g. "ai 1 67108960"; "ai 0" means
    // the daemon rejected it (typically a conflict).
    return stdout.includes(String(qtCode));
  } catch {
    return false;
  }
}

async function reloadKglobalaccel(): Promise<void> {
  // Try to ask kglobalaccel to reread its config. This is best-effort: the
  // daemon reliably picks up new _launch services on next login regardless.
  const attempts: Array<[string, string[]]> = [
    ['qdbus6', ['org.kde.kglobalaccel', '/kglobalaccel', 'org.kde.KGlobalAccel.reloadConfig']],
    ['qdbus-qt6', ['org.kde.kglobalaccel', '/kglobalaccel', 'org.kde.KGlobalAccel.reloadConfig']],
    ['qdbus', ['org.kde.kglobalaccel', '/kglobalaccel', 'org.kde.KGlobalAccel.reloadConfig']],
    // Fedora/Bazzite hosts often ship dbus-send but no qdbus variant.
    ['dbus-send', [
      '--session', '--type=method_call',
      '--dest=org.kde.kglobalaccel', '/kglobalaccel',
      'org.kde.KGlobalAccel.reloadConfig',
    ]],
  ];
  for (const [tool, args] of attempts) {
    try {
      await execFileAsync(tool, args);
      return;
    } catch {
      // try next
    }
  }
  // Last resort: restart the daemon itself (Plasma 6 runs it as a user unit).
  // try-restart is a no-op if the service isn't running.
  try {
    await execFileAsync('systemctl', ['--user', 'try-restart', 'plasma-kglobalaccel.service']);
  } catch {
    // best-effort; kglobalaccel picks up new _launch services on next login
  }
}

/** Remove the registered shortcut (used on uninstall / disable). */
export async function unregisterGlobalShortcut(
  opts: Pick<RegisterOptions, 'env' | 'homeDir'> = {},
): Promise<void> {
  const env = detectDesktopEnv(opts.env);
  const home = opts.homeDir || os.homedir();
  if (env === 'kde') {
    const desktopPath = path.join(
      home,
      '.local',
      'share',
      'applications',
      DESKTOP_FILENAME,
    );
    if (fs.existsSync(desktopPath)) fs.unlinkSync(desktopPath);
    // Leave the kglobalshortcutsrc entry; KDE prunes dead service shortcuts.
  } else if (env === 'gnome') {
    try {
      const dirPath = `${GNOME_CUSTOM_PATH}${GNOME_CTRLC_DIR}/`;
      const raw = await gsettings(['get', GNOME_SCHEMA, 'custom-keybindings']);
      const list = parseGnomeArray(raw).filter((p) => p !== dirPath);
      await gsettings([
        'set',
        GNOME_SCHEMA,
        'custom-keybindings',
        serializeGnomeArray(list),
      ]);
    } catch {
      // best-effort
    }
  }
}
