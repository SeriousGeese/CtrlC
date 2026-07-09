// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {
  detectDesktopEnv,
  toGnomeAccelerator,
  toKdeAccelerator,
  parseGnomeArray,
  serializeGnomeArray,
  findKdeConflict,
  buildDesktopLauncher,
} from './desktop-shortcut';

describe('detectDesktopEnv', () => {
  it('detects GNOME', () => {
    expect(detectDesktopEnv({ XDG_CURRENT_DESKTOP: 'GNOME' })).toBe('gnome');
    expect(detectDesktopEnv({ XDG_CURRENT_DESKTOP: 'ubuntu:GNOME' })).toBe('gnome');
    expect(detectDesktopEnv({ DESKTOP_SESSION: 'gnome-wayland' })).toBe('gnome');
  });

  it('detects KDE / Plasma', () => {
    expect(detectDesktopEnv({ XDG_CURRENT_DESKTOP: 'KDE' })).toBe('kde');
    expect(
      detectDesktopEnv({ DESKTOP_SESSION: '/usr/share/wayland-sessions/plasma.desktop' }),
    ).toBe('kde');
  });

  it('returns unknown for unrecognized DEs', () => {
    expect(detectDesktopEnv({ XDG_CURRENT_DESKTOP: 'XFCE' })).toBe('unknown');
    expect(detectDesktopEnv({})).toBe('unknown');
  });
});

describe('toGnomeAccelerator', () => {
  it('converts CommandOrControl+` to GTK syntax', () => {
    expect(toGnomeAccelerator('CommandOrControl+`')).toBe('<Control>grave');
  });

  it('handles Ctrl and Shift combos', () => {
    expect(toGnomeAccelerator('Ctrl+Shift+V')).toBe('<Control><Shift>V');
  });

  it('maps Super/Meta', () => {
    expect(toGnomeAccelerator('Super+Space')).toBe('<Super>Space');
    expect(toGnomeAccelerator('Meta+1')).toBe('<Super>1');
  });
});

describe('toKdeAccelerator', () => {
  it('converts CommandOrControl to Ctrl', () => {
    expect(toKdeAccelerator('CommandOrControl+`')).toBe('Ctrl+`');
  });

  it('maps Super/Command to Meta', () => {
    expect(toKdeAccelerator('Super+Shift+S')).toBe('Meta+Shift+S');
    expect(toKdeAccelerator('Command+V')).toBe('Meta+V');
  });

  it('leaves plain Ctrl combos intact', () => {
    expect(toKdeAccelerator('Ctrl+Alt+Delete')).toBe('Ctrl+Alt+Delete');
  });
});

describe('parseGnomeArray', () => {
  it('parses a populated array', () => {
    expect(parseGnomeArray("['/a/', '/b/']")).toEqual(['/a/', '/b/']);
  });

  it('parses empty forms', () => {
    expect(parseGnomeArray('@as []')).toEqual([]);
    expect(parseGnomeArray('[]')).toEqual([]);
    expect(parseGnomeArray('')).toEqual([]);
  });

  it('handles a single element', () => {
    expect(parseGnomeArray("['/only/']")).toEqual(['/only/']);
  });

  it('round-trips with serializeGnomeArray', () => {
    const items = ['/x/', '/y/', '/z/'];
    expect(parseGnomeArray(serializeGnomeArray(items))).toEqual(items);
  });
});

describe('serializeGnomeArray', () => {
  it('serializes empty', () => {
    expect(serializeGnomeArray([])).toBe('[]');
  });

  it('serializes multiple', () => {
    expect(serializeGnomeArray(['/a/', '/b/'])).toBe("['/a/', '/b/']");
  });
});

describe('findKdeConflict', () => {
  const sample = `[com.github.hluk.copyq]
CTRL+\`||Show main window under mouse cursor=,none,CopyQ
_k_friendly_name=CopyQ

[services][org.kde.spectacle.desktop]
RectangularRegionScreenShot=Meta+Shift+Print\\tMeta+Shift+S,default,Region
_launch=Print\\t
`;

  it('detects a conflicting accelerator and returns the group', () => {
    // Spectacle's region shot uses Meta+Shift+S as an alt accel.
    expect(findKdeConflict(sample, 'Meta+Shift+S')).toBe(
      'services][org.kde.spectacle.desktop',
    );
  });

  it('detects the primary accel', () => {
    expect(findKdeConflict(sample, 'Meta+Shift+Print')).toBe(
      'services][org.kde.spectacle.desktop',
    );
  });

  it('returns undefined when no conflict', () => {
    expect(findKdeConflict(sample, 'Ctrl+Alt+Q')).toBeUndefined();
  });

  it('is case-insensitive', () => {
    expect(findKdeConflict(sample, 'meta+shift+s')).toBe(
      'services][org.kde.spectacle.desktop',
    );
  });
});

describe('buildDesktopLauncher', () => {
  it('embeds exec path, app path and --show-popup', () => {
    const out = buildDesktopLauncher('/usr/bin/electron', '/opt/ctrlc', '/i.png');
    expect(out).toContain('Exec=/usr/bin/electron /opt/ctrlc --show-popup');
    expect(out).toContain('Icon=/i.png');
    expect(out).toContain('NoDisplay=true');
    expect(out).toContain('Type=Application');
  });
});
