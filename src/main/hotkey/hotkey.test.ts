import { describe, it, expect } from 'vitest';

// Normalization logic extracted from HotkeyManager.registerHotkey()
// This tests the exact same logic used at runtime.
function normalizeHotkey(hotkey: string, platform: string): string {
  let normalized = hotkey;
  if (platform === 'linux') {
    normalized = normalized
      .replace('CommandOrControl', 'Ctrl')
      .replace('Command', 'Super');
  }
  // Backquote → backtick: Electron 42 rejects the key name 'Backquote'
  normalized = normalized.replace(/[Bb]ackquote/g, '`');
  return normalized;
}

describe('hotkey normalization', () => {
  describe('on Linux', () => {
    const platform = 'linux';

    it('replaces CommandOrControl with Ctrl', () => {
      expect(normalizeHotkey('CommandOrControl+`', platform)).toBe('Ctrl+`');
    });

    it('replaces Command with Super', () => {
      expect(normalizeHotkey('Command+V', platform)).toBe('Super+V');
    });

    it('replaces Backquote with backtick character', () => {
      // Old config format: CommandOrControl+Backquote
      expect(normalizeHotkey('CommandOrControl+Backquote', platform)).toBe('Ctrl+`');
    });

    it('replaces lowercase backquote too', () => {
      expect(normalizeHotkey('Ctrl+backquote', platform)).toBe('Ctrl+`');
    });

    it('handles new config format (already uses backtick)', () => {
      expect(normalizeHotkey('Ctrl+`', platform)).toBe('Ctrl+`');
    });

    it('handles plain key combos without Backquote', () => {
      expect(normalizeHotkey('Ctrl+Shift+V', platform)).toBe('Ctrl+Shift+V');
    });
  });

  describe('on macOS', () => {
    const platform = 'darwin';

    it('keeps CommandOrControl as-is', () => {
      expect(normalizeHotkey('CommandOrControl+`', platform)).toBe('CommandOrControl+`');
    });

    it('still replaces Backquote with backtick', () => {
      expect(normalizeHotkey('Command+Backquote', platform)).toBe('Command+`');
    });
  });

  describe('on Windows', () => {
    const platform = 'win32';

    it('keeps Ctrl as-is', () => {
      expect(normalizeHotkey('Ctrl+`', platform)).toBe('Ctrl+`');
    });
  });

  describe('resulting format is valid for Electron 42', () => {
    for (const platform of ['linux', 'darwin', 'win32']) {
      it(`produces backtick character (not Backquote) on ${platform}`, () => {
        const result = normalizeHotkey('CommandOrControl+Backquote', platform);
        expect(result).not.toContain('Backquote');
        expect(result).toContain('`');
      });
    }
  });
});