import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DEFAULT_CONFIG, AppConfig, PopupPositionMode, POPUP_POSITION_MODES, PlainPasteModifier, PLAIN_PASTE_MODIFIERS } from '../shared/types';

const CONFIG_FILENAME = 'config.toml';
const DATA_DIR_NAME = '.CtrlC';

/**
 * Resolve the application data directory.
 * On Linux: ~/.CtrlC
 * On Windows: %USERPROFILE%/.CtrlC
 * On macOS: ~/Library/Application Support/CtrlC
 */
function resolveDataDir(): string {
  if (process.env.CTRLC_DATA_DIR) {
    return process.env.CTRLC_DATA_DIR;
  }

  // Git Bash, MSYS, and some installers set HOME even on Windows. That value
  // can point to a POSIX-style or service-account directory, while USERPROFILE
  // identifies the actual signed-in Windows account. Keep the historical
  // %USERPROFILE%/.CtrlC location stable across normal and elevated launches.
  if (process.platform === 'win32') {
    const canonicalDir = path.join(process.env.USERPROFILE || os.homedir(), DATA_DIR_NAME);
    const legacyHome = process.env.HOME;
    const legacyDir = legacyHome ? path.join(legacyHome, DATA_DIR_NAME) : '';

    // Older builds used HOME before USERPROFILE. If Git Bash/MSYS assigned a
    // different HOME, preserve the full config/history directory instead of
    // making an update appear to reset CtrlC. Rename is atomic on one volume;
    // falling back to the legacy directory avoids data loss if it cannot move.
    if (!fs.existsSync(canonicalDir) && legacyDir && legacyDir !== canonicalDir && fs.existsSync(legacyDir)) {
      try {
        fs.renameSync(legacyDir, canonicalDir);
      } catch {
        return legacyDir;
      }
    }
    return canonicalDir;
  }

  const home = process.env.HOME || process.env.USERPROFILE || os.homedir();
  return path.join(home, DATA_DIR_NAME);
}

function resolveConfigPath(): string {
  return path.join(resolveDataDir(), CONFIG_FILENAME);
}

function parseToml(content: string): ParsedConfig {
  // Simple TOML parser — handles the flat key-value pairs we need.
  // If we need nested tables later, we'll add a full parser.
  const result: ParsedConfig = {
    hotkey: undefined,
    historyDepth: undefined,
    retentionDays: undefined,
    saveImages: undefined,
    saveHtml: undefined,
    saveBinary: undefined,
    autoStart: undefined,
    dataDir: undefined,
    popupPosition: undefined,
    plainPasteModifier: undefined,
  };
  const lines = content.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;

    const key = trimmed.substring(0, eqIdx).trim();
    let rawValue = trimmed.substring(eqIdx + 1).trim();

    // Remove quotes
    if ((rawValue.startsWith('"') && rawValue.endsWith('"')) ||
        (rawValue.startsWith("'") && rawValue.endsWith("'"))) {
      rawValue = rawValue.slice(1, -1);
    }

    // Type coercion
    let value: unknown = rawValue;
    if (rawValue === 'true') value = true;
    else if (rawValue === 'false') value = false;
    else if (!isNaN(Number(rawValue)) && rawValue !== '') value = Number(rawValue);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (result as any)[key] = value;
  }

  return result;
}

interface ParsedConfig {
  hotkey?: string;
  historyDepth?: number;
  retentionDays?: number;
  saveImages?: boolean;
  saveHtml?: boolean;
  saveBinary?: boolean;
  autoStart?: boolean;
  runElevated?: boolean;
  dataDir?: string;
  popupPosition?: string;
  plainPasteModifier?: string;
}

function serializeToml(config: Partial<AppConfig>): string {
  const lines: string[] = [
    '# CtrlC configuration',
    '# Generated automatically — edit at your own risk',
    '',
  ];

  const pairs: string[] = [];

  if (config.hotkey !== undefined) {
    pairs.push(`hotkey = "${config.hotkey}"`);
  }
  if (config.historyDepth !== undefined) {
    pairs.push(`historyDepth = ${config.historyDepth}`);
  }
  if (config.retentionDays !== undefined) {
    pairs.push(`retentionDays = ${config.retentionDays}`);
  }
  if (config.saveImages !== undefined) {
    pairs.push(`saveImages = ${config.saveImages}`);
  }
  if (config.saveHtml !== undefined) {
    pairs.push(`saveHtml = ${config.saveHtml}`);
  }
  if (config.saveBinary !== undefined) {
    pairs.push(`saveBinary = ${config.saveBinary}`);
  }
  if (config.autoStart !== undefined) {
    pairs.push(`autoStart = ${config.autoStart}`);
  }
  if (config.runElevated !== undefined) {
    pairs.push(`runElevated = ${config.runElevated}`);
  }
  if (config.dataDir !== undefined) {
    pairs.push(`dataDir = "${config.dataDir}"`);
  }
  if (config.popupPosition !== undefined) {
    pairs.push(`popupPosition = "${config.popupPosition}"`);
  }
  if (config.plainPasteModifier !== undefined) {
    pairs.push(`plainPasteModifier = "${config.plainPasteModifier}"`);
  }

  return [...lines, ...pairs].join('\n') + '\n';
}

/**
 * Load configuration from disk.
 * Merges file values on top of defaults.
 */
export function loadConfig(): AppConfig {
  const configPath = resolveConfigPath();
  let fileConfig: Partial<AppConfig> = {};

  if (fs.existsSync(configPath)) {
    const content = fs.readFileSync(configPath, 'utf-8');
    const parsed = parseToml(content);

    fileConfig = {};
    if (parsed.hotkey !== undefined) { fileConfig.hotkey = parsed.hotkey; }
    if (parsed.historyDepth !== undefined) { fileConfig.historyDepth = parsed.historyDepth; }
    if (parsed.retentionDays !== undefined) { fileConfig.retentionDays = parsed.retentionDays; }
    if (parsed.saveImages !== undefined) { fileConfig.saveImages = parsed.saveImages; }
    if (parsed.saveHtml !== undefined) { fileConfig.saveHtml = parsed.saveHtml; }
    if (parsed.saveBinary !== undefined) { fileConfig.saveBinary = parsed.saveBinary; }
    if (parsed.autoStart !== undefined) { fileConfig.autoStart = parsed.autoStart; }
    if (parsed.runElevated !== undefined) { fileConfig.runElevated = parsed.runElevated; }
    if (parsed.dataDir !== undefined) { fileConfig.dataDir = parsed.dataDir; }
    if (parsed.popupPosition !== undefined &&
        POPUP_POSITION_MODES.includes(parsed.popupPosition as PopupPositionMode)) {
      fileConfig.popupPosition = parsed.popupPosition as PopupPositionMode;
    }
    if (parsed.plainPasteModifier !== undefined &&
        PLAIN_PASTE_MODIFIERS.includes(parsed.plainPasteModifier as PlainPasteModifier)) {
      fileConfig.plainPasteModifier = parsed.plainPasteModifier as PlainPasteModifier;
    }
  }

  return {
    ...DEFAULT_CONFIG,
    ...fileConfig,
  };
}

/**
 * Save configuration to disk.
 */
export function saveConfig(config: Partial<AppConfig>): void {
  const dataDir = resolveDataDir();
  const configPath = resolveConfigPath();

  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  }

  fs.writeFileSync(configPath, serializeToml(config), 'utf-8');
}

export function getDataDir(): string {
  return resolveDataDir();
}

export function getClipsDir(): string {
  return path.join(resolveDataDir(), 'Clips');
}
