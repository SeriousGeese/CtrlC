import { describe, it, expect } from 'vitest';
import { ClipData, ClipType, DEFAULT_CONFIG } from '../shared/types';

describe('ClipData types', () => {
  it('should accept valid clip data', () => {
    const clip: ClipData = {
      id: 'test-123',
      createdAt: Date.now(),
      type: 'text',
      content: 'Hello World',
      contentHash: 'abc123',
      source: 'test-app',
    };
    expect(clip.type).toBe('text');
    expect(clip.content).toBe('Hello World');
  });

  it('should accept all valid clip types', () => {
    const types: ClipType[] = ['text', 'html', 'image', 'file', 'binary'];
    types.forEach(type => {
      expect(['text', 'html', 'image', 'file', 'binary']).toContain(type);
    });
  });

  it('should allow optional source field', () => {
    const clipWithoutSource: ClipData = {
      id: 'test-456',
      createdAt: Date.now(),
      type: 'image',
      content: 'data:image/png;base64,...',
      contentHash: 'def456',
    };
    expect(clipWithoutSource.source).toBeUndefined();
  });
});

describe('DEFAULT_CONFIG', () => {
  it('should have correct default values', () => {
    expect(DEFAULT_CONFIG.historyDepth).toBe(100);
    expect(DEFAULT_CONFIG.retentionDays).toBe(30);
    expect(DEFAULT_CONFIG.saveImages).toBe(true);
    expect(DEFAULT_CONFIG.saveHtml).toBe(true);
    expect(DEFAULT_CONFIG.saveBinary).toBe(true);
    expect(DEFAULT_CONFIG.autoStart).toBe(false);
    expect(DEFAULT_CONFIG.hotkey).toBe('CommandOrControl+Backquote');
  });

  it('should have empty dataDir (resolved at runtime)', () => {
    expect(DEFAULT_CONFIG.dataDir).toBe('');
  });
});
