import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as config from './config';

describe('Config module', () => {
  let tempDir: string;

  beforeEach(() => {
    // Create a temporary data directory for tests
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctrlc-test-'));
    process.env.CTRLC_DATA_DIR = tempDir;
  });

  afterEach(() => {
    // Clean up temp directory
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
    delete process.env.CTRLC_DATA_DIR;
  });

  it('should return defaults when no config file exists', () => {
    const cfg = config.loadConfig();
    expect(cfg.historyDepth).toBe(100);
    expect(cfg.retentionDays).toBe(30);
    expect(cfg.saveImages).toBe(true);
    expect(cfg.autoStart).toBe(false);
  });

  it('should merge config file values with defaults', () => {
    // Write a partial config file
    const configPath = path.join(tempDir, 'config.toml');
    fs.writeFileSync(configPath, 'historyDepth = 50\nsaveImages = false\n');

    const cfg = config.loadConfig();
    expect(cfg.historyDepth).toBe(50);
    expect(cfg.saveImages).toBe(false);
    expect(cfg.retentionDays).toBe(30); // default still applies
  });

  it('should save and reload config', () => {
    const partialConfig = {
      hotkey: 'Ctrl+Alt+C',
      historyDepth: 50,
      saveImages: false,
    };

    config.saveConfig(partialConfig);

    const reloaded = config.loadConfig();
    expect(reloaded.hotkey).toBe('Ctrl+Alt+C');
    expect(reloaded.historyDepth).toBe(50);
    expect(reloaded.saveImages).toBe(false);
  });

  it('should return correct data directory path', () => {
    expect(config.getDataDir()).toBe(tempDir);
  });

  it('should return correct clips directory path', () => {
    const clipsDir = config.getClipsDir();
    expect(clipsDir).toBe(path.join(tempDir, 'Clips'));
  });
});
