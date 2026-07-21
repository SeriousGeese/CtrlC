import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// The config module uses module-level state (dataDir resolution via env vars).
// We import the functions we need after setting up a temp environment.
import { loadConfig, saveConfig, getDataDir, getClipsDir } from './config';
import { DEFAULT_CONFIG, AppConfig } from '../shared/types';

describe('config module', () => {
  const tmpDir = path.join(os.tmpdir(), `ctrlc-test-${Date.now()}`);
  const origHome = process.env.HOME;
  const origDataDir = process.env.CTRLC_DATA_DIR;

  beforeEach(() => {
    // Point data dir to temp so tests don't touch ~/.CtrlC
    process.env.CTRLC_DATA_DIR = tmpDir;
    if (!fs.existsSync(tmpDir)) {
      fs.mkdirSync(tmpDir, { recursive: true });
    }
  });

  afterEach(() => {
    // Restore env
    if (origHome) process.env.HOME = origHome;
    if (origDataDir) {
      process.env.CTRLC_DATA_DIR = origDataDir;
    } else {
      delete process.env.CTRLC_DATA_DIR;
    }
    // Clean up temp dir
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  describe('getDataDir / getClipsDir', () => {
    it('respects CTRLC_DATA_DIR env var', () => {
      const d = getDataDir();
      expect(d).toBe(tmpDir);
    });

    it('returns clips dir under data dir', () => {
      const d = getClipsDir();
      expect(d).toBe(path.join(tmpDir, 'Clips'));
    });

    it('uses USERPROFILE rather than HOME on Windows', () => {
      const originalPlatform = process.platform;
      const originalUserProfile = process.env.USERPROFILE;
      const originalHome = process.env.HOME;
      delete process.env.CTRLC_DATA_DIR;
      Object.defineProperty(process, 'platform', { value: 'win32' });
      process.env.USERPROFILE = 'C:\\Users\\ctrlc-test';
      process.env.HOME = 'C:\\unexpected-home';

      expect(getDataDir()).toBe(path.join('C:\\Users\\ctrlc-test', '.CtrlC'));

      Object.defineProperty(process, 'platform', { value: originalPlatform });
      if (originalUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = originalUserProfile;
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      process.env.CTRLC_DATA_DIR = tmpDir;
    });
  });

  describe('loadConfig (defaults)', () => {
    it('returns DEFAULT_CONFIG when no config file exists', () => {
      const cfg = loadConfig();
      expect(cfg.hotkey).toBe(DEFAULT_CONFIG.hotkey);
      expect(cfg.historyDepth).toBe(DEFAULT_CONFIG.historyDepth);
      expect(cfg.retentionDays).toBe(DEFAULT_CONFIG.retentionDays);
      expect(cfg.saveImages).toBe(DEFAULT_CONFIG.saveImages);
      expect(cfg.saveHtml).toBe(DEFAULT_CONFIG.saveHtml);
      expect(cfg.saveBinary).toBe(DEFAULT_CONFIG.saveBinary);
      expect(cfg.autoStart).toBe(DEFAULT_CONFIG.autoStart);
    });

    it('default hotkey uses backtick character, not Backquote string', () => {
      const cfg = loadConfig();
      // The default must use the actual backtick character for Electron 42 compat
      expect(cfg.hotkey.includes('Backquote')).toBe(false);
      expect(cfg.hotkey).toContain('`');
    });

    it('hotkey is a valid Electron accelerator format', () => {
      const cfg = loadConfig();
      // Should be CommandOrControl+` — the backtick character, not Backquote
      expect(cfg.hotkey).toMatch(/^CommandOrControl\+`$/);
    });
  });

  describe('loadConfig with existing config file', () => {
    it('merges file values on top of defaults', () => {
      const configPath = path.join(tmpDir, 'config.toml');
      fs.writeFileSync(configPath, [
        '# CtrlC config',
        'hotkey = "Ctrl+Shift+V"',
        'historyDepth = 50',
      ].join('\n'), 'utf-8');

      const cfg = loadConfig();
      expect(cfg.hotkey).toBe('Ctrl+Shift+V');
      expect(cfg.historyDepth).toBe(50);
      // Defaults preserved for unspecified keys
      expect(cfg.retentionDays).toBe(DEFAULT_CONFIG.retentionDays);
      expect(cfg.saveImages).toBe(true);
    });
  });

  describe('saveConfig', () => {
    it('writes a valid TOML file that can be read back', () => {
      const updates: Partial<AppConfig> = {
        hotkey: 'Ctrl+Shift+H',
        historyDepth: 200,
        saveImages: false,
      };

      saveConfig(updates);

      // Read it back via loadConfig
      const cfg = loadConfig();
      expect(cfg.hotkey).toBe('Ctrl+Shift+H');
      expect(cfg.historyDepth).toBe(200);
      expect(cfg.saveImages).toBe(false);
    });
  });
});