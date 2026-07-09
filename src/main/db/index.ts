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
      content_hash TEXT NOT NULL,
      clip_type TEXT NOT NULL DEFAULT 'text',
      source TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_clips_hash ON clips(content_hash);
    CREATE INDEX IF NOT EXISTS idx_clips_created ON clips(created_at DESC);
  `);
}

export async function insertClip(content: string, type: string, source?: string): Promise<ClipData> {
  const id = crypto.randomUUID();
  const hash = hashContent(content);
  const now = Date.now();

  await db!.run(
    'INSERT OR REPLACE INTO clips (id, content, content_hash, clip_type, source, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    id, content, hash, type, source || null, now
  );

  return { id, createdAt: now, type: type as ClipData['type'], content, contentHash: hash, source };
}

export function getRecentClips(limit: number): Promise<ClipData[]> {
  return db!.all(
    'SELECT id, content, content_hash AS contentHash, clip_type AS type, source, created_at AS createdAt FROM clips ORDER BY created_at DESC LIMIT ?',
    limit
  ) as Promise<ClipData[]>;
}

export function deleteClip(id: string): Promise<void> {
  return db!.run('DELETE FROM clips WHERE id = ?', id).then(() => {});
}

export function clipExistsByHash(hash: string): Promise<boolean> {
  return db!.get('SELECT 1 FROM clips WHERE content_hash = ? LIMIT 1', hash)
    .then((row: { '1': number | undefined } | undefined) => row !== undefined);
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

export function cleanExpiredClips(days: number): Promise<void> {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  return db!.run('DELETE FROM clips WHERE created_at < ?', cutoff).then(() => {});
}
