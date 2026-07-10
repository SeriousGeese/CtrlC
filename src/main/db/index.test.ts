import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';

import { setDbPath, initDB, closeDB, insertClip, getRecentClips, deleteClip, cleanExpiredClips, clearAllClips, clipExistsByHash } from './index';

describe('DB module', () => {
  const tmpDir = path.join(os.tmpdir(), `ctrlc-db-test-${Date.now()}`);
  const dbFile = path.join(tmpDir, 'cutc.db');

  beforeEach(async () => {
    fs.mkdirSync(tmpDir, { recursive: true });
    setDbPath(dbFile);
    await initDB();
  });

  afterEach(async () => {
    await closeDB();
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  describe('contentText (plain-text flavor for html clips)', () => {
    it('stores and returns the plain-text flavor', async () => {
      await insertClip('<b>bold</b>', 'html', 'html', 'bold');
      const [clip] = await getRecentClips(1);
      expect(clip.content).toBe('<b>bold</b>');
      expect(clip.contentText).toBe('bold');
    });

    it('is null when not provided', async () => {
      await insertClip('plain', 'text');
      const [clip] = await getRecentClips(1);
      expect(clip.contentText).toBeNull();
    });
  });

  describe('clearAllClips', () => {
    it('removes every clip', async () => {
      await insertClip('one', 'text');
      await insertClip('two', 'text');
      await insertClip('three', 'html');
      expect((await getRecentClips(10)).length).toBe(3);

      await clearAllClips();
      expect((await getRecentClips(10)).length).toBe(0);
    });

    it('is a no-op on an empty table', async () => {
      await expect(clearAllClips()).resolves.toBeUndefined();
      expect((await getRecentClips(10)).length).toBe(0);
    });
  });

  describe('insertClip and getRecentClips', () => {
    it('inserts and retrieves a text clip', async () => {
      const clip = await insertClip('hello world', 'text', 'test-app');
      expect(clip.content).toBe('hello world');
      expect(clip.type).toBe('text');
      expect(clip.source).toBe('test-app');
      expect(clip.id).toBeTruthy();
      expect(clip.createdAt).toBeGreaterThan(0);

      const recent = await getRecentClips(10);
      expect(recent.length).toBe(1);
      expect(recent[0].content).toBe('hello world');
    });

    it('returns clips in reverse chronological order', async () => {
      await insertClip('first', 'text');
      await sleep(10);
      await insertClip('second', 'text');
      await sleep(10);
      await insertClip('third', 'text');

      const recent = await getRecentClips(10);
      expect(recent.length).toBe(3);
      expect(recent[0].content).toBe('third');
      expect(recent[1].content).toBe('second');
      expect(recent[2].content).toBe('first');
    });

    it('respects limit parameter', async () => {
      await insertClip('a', 'text');
      await insertClip('b', 'text');
      await insertClip('c', 'text');

      const limited = await getRecentClips(2);
      expect(limited.length).toBe(2);
    });

    it('stores HTML clips separately from text', async () => {
      await insertClip('<b>bold</b>', 'html', 'test');
      await insertClip('just text', 'text', 'test');

      const recent = await getRecentClips(10);
      expect(recent.length).toBe(2);
      const htmlClip = recent.find(c => c.type === 'html');
      const textClip = recent.find(c => c.type === 'text');
      expect(htmlClip?.content).toBe('<b>bold</b>');
      expect(textClip?.content).toBe('just text');
    });
  });

  describe('deduplication', () => {
    it('does not dedup by content hash at DB level (app-level dedup in clipboard.ts)', async () => {
      // The DB stores both since id (UUID) is the primary key, not content_hash.
      // Dedup happens in ClipboardCapture via clipExistsByHash().
      const clip1 = await insertClip('duplicate content', 'text');
      const clip2 = await insertClip('duplicate content', 'text');

      // Both should have same hash
      expect(clip1.contentHash).toBe(clip2.contentHash);
      expect(clip1.id).not.toBe(clip2.id);

      // Both rows exist (no dedup at DB level)
      const recent = await getRecentClips(10);
      expect(recent.length).toBe(2);
    });
  });

  describe('clipExistsByHash', () => {
    it('returns true when hash exists', async () => {
      await insertClip('exists-test', 'text');
      const hash = require('node:crypto')
        .createHash('sha256').update('exists-test').digest('hex');
      const exists = await clipExistsByHash(hash);
      expect(exists).toBe(true);
    });

    it('returns false when hash does not exist', async () => {
      const hash = require('node:crypto')
        .createHash('sha256').update('nonexistent').digest('hex');
      const exists = await clipExistsByHash(hash);
      expect(exists).toBe(false);
    });
  });

  describe('deleteClip', () => {
    it('removes a clip by id', async () => {
      const clip = await insertClip('to-delete', 'text');
      const before = await getRecentClips(10);
      expect(before.length).toBe(1);

      await deleteClip(clip.id);
      const after = await getRecentClips(10);
      expect(after.length).toBe(0);
    });

    it('does not error when deleting non-existent id', async () => {
      await expect(deleteClip('non-existent-id')).resolves.not.toThrow();
    });
  });

  describe('cleanExpiredClips', () => {
    it('removes clips older than retention period', async () => {
      // Insert a clip that's way in the past
      const clip = await insertClip('old clip', 'text');
      // Manually backdate it
      const db = (await import('sqlite')).default as any;
      const cutcDb = (await import('sqlite3')).default as any;
      const testDb = await (await import('sqlite')).open({
        filename: dbFile,
        driver: cutcDb.Database,
      });
      await testDb.run(
        'UPDATE clips SET created_at = ? WHERE id = ?',
        Date.now() - 100 * 24 * 60 * 60 * 1000, // 100 days ago
        clip.id
      );
      await testDb.close();

      // Now clean with 30-day retention — should delete old clip
      await cleanExpiredClips(30);

      const recent = await getRecentClips(10);
      expect(recent.length).toBe(0);
    });
  });
});

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}