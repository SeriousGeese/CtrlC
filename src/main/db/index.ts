import sqlite3 from 'sqlite3';
import { open, Database } from 'sqlite';
import { ClipData } from '../../shared/types';
import crypto from 'node:crypto';
import * as path from 'node:path';
import * as fs from 'node:fs';

let db: Database | null = null;
let dbPath: string = '';

export function setDbPath(p: string): void {
  dbPath = p;
}

function hashContent(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

export async function initDB(): Promise<void> {
  // Ensure the .config subdirectory exists
  const dataDir = path.dirname(dbPath || './.config/cutc.db');
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  }

  db = await open({
    filename: dbPath || './.config/cutc.db',
    driver: sqlite3.Database,
  });

  await db.exec(`
    CREATE TABLE IF NOT EXISTS clips (
      id TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      content_text TEXT,
      content_hash TEXT NOT NULL,
      clip_type TEXT NOT NULL DEFAULT 'text',
      source TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_clips_hash ON clips(content_hash);
    CREATE INDEX IF NOT EXISTS idx_clips_created ON clips(created_at DESC);
  `);

  // Migration for databases created before content_text existed (the
  // plain-text flavor stored alongside html clips).
  const cols = await db.all(`PRAGMA table_info(clips)`);
  if (!cols.some((c: { name: string }) => c.name === 'content_text')) {
    await db.exec('ALTER TABLE clips ADD COLUMN content_text TEXT');
  }
}

export async function insertClip(content: string, type: string, source?: string, contentText?: string): Promise<ClipData> {
  const id = crypto.randomUUID();
  const hash = hashContent(content);
  const now = Date.now();

  await db!.run(
    'INSERT OR REPLACE INTO clips (id, content, content_text, content_hash, clip_type, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    id, content, contentText || null, hash, type, source || null, now
  );

  return { id, createdAt: now, type: type as ClipData['type'], content, contentText, contentHash: hash, source };
}

export function getRecentClips(limit: number): Promise<ClipData[]> {
  return db!.all(
    'SELECT id, content, content_text AS contentText, content_hash AS contentHash, clip_type AS type, source, created_at AS createdAt FROM clips ORDER BY created_at DESC LIMIT ?',
    limit
  ) as Promise<ClipData[]>;
}

/** Best-effort delete of the on-disk files backing the given image clip rows. */
function removeClipFiles(rows: { content: string }[]): void {
  for (const { content } of rows) {
    if (!content) continue;
    try {
      fs.rmSync(content, { force: true });
    } catch {
      // best-effort — a missing/locked file must not block the row deletion
    }
  }
}

export async function deleteClip(id: string): Promise<void> {
  // Drop the backing PNG too, or deleting an image clip leaks its file.
  const row = await db!.get(
    "SELECT content FROM clips WHERE id = ? AND clip_type = 'image'",
    id,
  ) as { content: string } | undefined;
  if (row) removeClipFiles([row]);
  await db!.run('DELETE FROM clips WHERE id = ?', id);
}

/**
 * Replace a clip's content (user edit). Recomputes the dedup hash and drops
 * the stored plain-text flavor — for html clips it no longer matches the
 * edited markup, and the paste path derives it on demand.
 */
export async function updateClipContent(id: string, content: string): Promise<boolean> {
  const result = await db!.run(
    'UPDATE clips SET content = ?, content_hash = ?, content_text = NULL WHERE id = ?',
    content, hashContent(content), id
  );
  return (result.changes ?? 0) > 0;
}

export function clipExistsByHash(hash: string): Promise<boolean> {
  return db!.get('SELECT 1 FROM clips WHERE content_hash = ? LIMIT 1', hash)
    .then((row: { '1': number | undefined } | undefined) => row !== undefined);
}

/**
 * Re-copied content moves to the top of the history (Ditto behavior)
 * instead of keeping its original position. Returns true when a clip with
 * this hash existed and was bumped.
 */
export async function touchClipByHash(hash: string): Promise<boolean> {
  const result = await db!.run(
    'UPDATE clips SET created_at = ? WHERE content_hash = ?',
    Date.now(), hash
  );
  return (result.changes ?? 0) > 0;
}

export function getClipCount(): Promise<number> {
  return db!.get('SELECT COUNT(*) as count FROM clips')
    .then((row: { count: number }) => row.count);
}

export async function closeDB(): Promise<void> {
  if (db) {
    await db.close();
    db = null;
  }
}

export function clearAllClips(): Promise<void> {
  return db!.run('DELETE FROM clips').then(() => {});
}

export async function cleanExpiredClips(days: number): Promise<void> {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  // Delete the on-disk image files for expired clips before dropping the rows.
  // Cleaning only the DB left the PNGs in Clips/ to pile up forever, so the
  // retention policy never actually reclaimed their disk space.
  const expired = await db!.all(
    "SELECT content FROM clips WHERE created_at < ? AND clip_type = 'image'",
    cutoff,
  ) as { content: string }[];
  removeClipFiles(expired);
  await db!.run('DELETE FROM clips WHERE created_at < ?', cutoff);
}

/**
 * Delete image files in `clipsDir` that no clip row references — screenshots
 * orphaned by older builds (which deleted rows but never their PNGs) plus any
 * other strays. Skips files written in the last minute to avoid racing an
 * in-flight capture that saved its PNG just before inserting the row. Returns
 * the number of files removed.
 */
export async function pruneOrphanClipFiles(clipsDir: string): Promise<number> {
  if (!fs.existsSync(clipsDir)) return 0;
  const rows = await db!.all(
    "SELECT content FROM clips WHERE clip_type = 'image'",
  ) as { content: string }[];
  const referenced = new Set(rows.map(r => path.basename(r.content)));
  const graceMs = 60_000;
  const now = Date.now();
  let removed = 0;
  for (const name of fs.readdirSync(clipsDir)) {
    if (referenced.has(name)) continue;
    const full = path.join(clipsDir, name);
    try {
      if (now - fs.statSync(full).mtimeMs < graceMs) continue;
      fs.rmSync(full, { force: true });
      removed++;
    } catch {
      // best-effort — skip files we can't stat or remove
    }
  }
  return removed;
}
