import { describe, it, expect } from 'vitest';

// shortenHotkey logic extracted from TrayManager.shortenHotkey()
function shortenHotkey(hotkey: string): string {
  if (!hotkey) return '';
  // Strip modifier prefix for display — tooltip area is small
  return hotkey
    .replace(/^CommandOrControl\+/g, '')
    .replace(/^Command\+/g, '')
    .replace(/^Control\+/g, '')
    .replace(/[Bb]ackquote/g, '`');
}

describe('TrayManager.shortenHotkey', () => {
  it('returns empty string for empty input', () => {
    expect(shortenHotkey('')).toBe('');
  });

  it('strips CommandOrControl+ prefix', () => {
    expect(shortenHotkey('CommandOrControl+`')).toBe('`');
  });

  it('strips Command+ prefix', () => {
    expect(shortenHotkey('Command+`')).toBe('`');
  });

  it('strips Control+ prefix', () => {
    expect(shortenHotkey('Control+V')).toBe('V');
  });

  it('displays backtick for old Backquote config format', () => {
    // Old config may still contain 'Backquote'
    expect(shortenHotkey('CommandOrControl+Backquote')).toBe('`');
    expect(shortenHotkey('Control+Backquote')).toBe('`');
    expect(shortenHotkey('Ctrl+backquote')).toBe('Ctrl+`'); // Ctrl is kept as-is
  });

  it('displays backtick for new config format', () => {
    expect(shortenHotkey('Ctrl+`')).toBe('Ctrl+`'); // Ctrl is kept as-is
    expect(shortenHotkey('CommandOrControl+`')).toBe('`');
  });

  it('preserves multi-modifier combos', () => {
    expect(shortenHotkey('Ctrl+Shift+V')).toBe('Ctrl+Shift+V');
    expect(shortenHotkey('Alt+Shift+`')).toBe('Alt+Shift+`');
  });

  it('preserves plain key without modifier', () => {
    expect(shortenHotkey('F1')).toBe('F1');
  });
});