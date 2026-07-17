import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';

import { setDbPath, initDB, closeDB, insertClip, getRecentClips, deleteClip, updateClipContent, cleanExpiredClips, clearAllClips, clipExistsByHash, touchClipByHash, pruneOrphanClipFiles } from './index';

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

  describe('updateClipContent', () => {
    it('replaces content, recomputes the hash, and clears content_text', async () => {
      const clip = await insertClip('<b>old</b>', 'html', 'html', 'old');
      const ok = await updateClipContent(clip.id, '<b>new</b>');
      expect(ok).toBe(true);

      const [updated] = await getRecentClips(1);
      expect(updated.content).toBe('<b>new</b>');
      expect(updated.contentText).toBeNull();
      expect(updated.contentHash).not.toBe(clip.contentHash);
      expect(await clipExistsByHash(clip.contentHash)).toBe(false);
    });

    it('returns false for unknown ids', async () => {
      expect(await updateClipContent('nope', 'x')).toBe(false);
    });
  });

  describe('touchClipByHash', () => {
    it('bumps an existing clip to the top and reports true', async () => {
      const first = await insertClip('recopied later', 'text');
      await sleep(10);
      await insertClip('newer clip', 'text');

      const bumped = await touchClipByHash(first.contentHash);
      expect(bumped).toBe(true);

      const recent = await getRecentClips(10);
      expect(recent[0].content).toBe('recopied later');
      expect(recent.length).toBe(2); // no duplicate row
    });

    it('returns false for unknown hashes', async () => {
      expect(await touchClipByHash('no-such-hash')).toBe(false);
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

    it('deletes the backing image file for expired image clips', async () => {
      const filePath = path.join(tmpDir, 'expired.png');
      fs.writeFileSync(filePath, 'png-bytes');
      const clip = await insertClip(filePath, 'image', 'image');
      await backdate(dbFile, clip.id, 100);

      await cleanExpiredClips(30);

      expect(await getRecentClips(10)).toHaveLength(0);
      expect(fs.existsSync(filePath)).toBe(false); // file cleaned, not leaked
    });

    it('keeps the image file for clips still within retention', async () => {
      const filePath = path.join(tmpDir, 'fresh.png');
      fs.writeFileSync(filePath, 'png-bytes');
      await insertClip(filePath, 'image', 'image');

      await cleanExpiredClips(30);

      expect(fs.existsSync(filePath)).toBe(true);
    });
  });

  describe('deleteClip (image files)', () => {
    it('removes the backing image file', async () => {
      const filePath = path.join(tmpDir, 'del.png');
      fs.writeFileSync(filePath, 'png-bytes');
      const clip = await insertClip(filePath, 'image', 'image');

      await deleteClip(clip.id);

      expect(fs.existsSync(filePath)).toBe(false);
    });
  });

  describe('pruneOrphanClipFiles', () => {
    it('removes unreferenced files but keeps referenced ones', async () => {
      const clipsDir = path.join(tmpDir, 'Clips');
      fs.mkdirSync(clipsDir, { recursive: true });

      const referenced = path.join(clipsDir, 'keep.png');
      const orphan = path.join(clipsDir, 'orphan.png');
      fs.writeFileSync(referenced, 'x');
      fs.writeFileSync(orphan, 'x');
      // Backdate both past the 60s grace window so they're eligible.
      const old = new Date(Date.now() - 5 * 60 * 1000);
      fs.utimesSync(referenced, old, old);
      fs.utimesSync(orphan, old, old);

      await insertClip(referenced, 'image', 'image');

      const removed = await pruneOrphanClipFiles(clipsDir);

      expect(removed).toBe(1);
      expect(fs.existsSync(referenced)).toBe(true);
      expect(fs.existsSync(orphan)).toBe(false);
    });

    it('skips recently written files (in-flight capture grace window)', async () => {
      const clipsDir = path.join(tmpDir, 'Clips');
      fs.mkdirSync(clipsDir, { recursive: true });
      const recent = path.join(clipsDir, 'recent.png');
      fs.writeFileSync(recent, 'x'); // mtime = now

      const removed = await pruneOrphanClipFiles(clipsDir);

      expect(removed).toBe(0);
      expect(fs.existsSync(recent)).toBe(true);
    });

    it('returns 0 when the clips dir does not exist', async () => {
      expect(await pruneOrphanClipFiles(path.join(tmpDir, 'missing'))).toBe(0);
    });
  });
});

async function backdate(dbFile: string, id: string, daysAgo: number): Promise<void> {
  const sqlite = await import('sqlite');
  const sqlite3 = (await import('sqlite3')).default as any;
  const testDb = await sqlite.open({ filename: dbFile, driver: sqlite3.Database });
  await testDb.run(
    'UPDATE clips SET created_at = ? WHERE id = ?',
    Date.now() - daysAgo * 24 * 60 * 60 * 1000,
    id,
  );
  await testDb.close();
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}