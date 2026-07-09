import { clipboard } from 'electron';
import { ClipType, AppConfig } from '../shared/types';
import { insertClip, clipExistsByHash, cleanExpiredClips } from './db';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn, spawnSync, execFile, ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { getClipsDir } from './config';

const execFileAsync = promisify(execFile);
const MAX_TEXT_BYTES = 16 * 1024 * 1024;
const MAX_IMAGE_BYTES = 64 * 1024 * 1024;

export class ClipboardCapture {
  private config: AppConfig;
  private isCapturing = false;
  private lastClipHash = '';
  private captureTimeout: NodeJS.Timeout | null = null;
  private waylandWatcher: ChildProcess | null = null;

  constructor(config: AppConfig) {
    this.config = config;
  }

  /**
   * Start listening for clipboard changes.
   *
   * On a Wayland session, Electron (under either backend) can only read the
   * clipboard while one of our windows has focus, so polling from a hidden
   * window captures nothing. Instead we watch via `wl-paste --watch`, which
   * uses the wlr-data-control protocol (made for clipboard managers — no
   * focus needed, event-driven). Everywhere else we poll Electron's API.
   */
  start(): void {
    if (this.isCapturing) return;
    this.isCapturing = true;

    if (this.startWaylandWatcher()) return;

    // X11 / Windows / macOS: poll for clipboard changes
    this.startPolling();
  }

  /**
   * Stop clipboard capture.
   */
  stop(): void {
    this.isCapturing = false;
    if (this.captureTimeout) {
      clearTimeout(this.captureTimeout);
      this.captureTimeout = null;
    }
    if (this.waylandWatcher) {
      this.waylandWatcher.kill();
      this.waylandWatcher = null;
    }
  }

  /**
   * Manually trigger a clipboard capture (e.g., from tray menu "Copy Last").
   */
  captureCurrent(): void {
    void this.processClipboard();
  }

  /**
   * Update configuration (called when user changes settings).
   */
  updateConfig(newConfig: AppConfig): void {
    this.config = newConfig;
  }

  /**
   * Watch the Wayland clipboard via `wl-paste --watch`. Returns false when
   * not on Wayland or wl-paste is unavailable (caller falls back to polling).
   */
  private startWaylandWatcher(): boolean {
    const onWayland =
      process.platform === 'linux' &&
      (!!process.env.WAYLAND_DISPLAY || process.env.XDG_SESSION_TYPE === 'wayland');
    if (!onWayland) return false;

    const probe = spawnSync('wl-paste', ['--version'], { timeout: 3000 });
    if (probe.error || probe.status !== 0) {
      console.warn(
        '[ClipboardCapture] wl-paste not found — falling back to polling, ' +
          'which cannot see clipboard changes on Wayland without window focus. ' +
          'Install wl-clipboard for reliable capture.',
      );
      return false;
    }

    // wl-paste pipes the new contents to the command's stdin on every
    // selection change. We use it purely as a change signal (drain stdin,
    // print one line), then re-read typed content with one-shot wl-paste
    // calls so html/image/text priority matches the polling path.
    const watcher = spawn(
      'wl-paste',
      ['--watch', 'sh', '-c', 'cat > /dev/null; echo x'],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    );
    watcher.stdout.on('data', () => {
      void this.processWaylandClipboard();
    });
    watcher.on('error', (err) => {
      console.error('[ClipboardCapture] wl-paste watcher error:', err);
    });
    watcher.on('exit', (code) => {
      this.waylandWatcher = null;
      if (this.isCapturing) {
        console.warn(
          `[ClipboardCapture] wl-paste watcher exited (code ${code}) — falling back to polling.`,
        );
        this.startPolling();
      }
    });

    this.waylandWatcher = watcher;
    console.log('[ClipboardCapture] Watching Wayland clipboard via wl-paste');
    return true;
  }

  /**
   * Read the Wayland clipboard with wl-paste and store it, using the same
   * html > image > text priority as the Electron polling path.
   */
  private async processWaylandClipboard(): Promise<void> {
    try {
      const { stdout: typesRaw } = await execFileAsync('wl-paste', ['--list-types'], {
        timeout: 5000,
      });
      const types = typesRaw.split('\n').map((t) => t.trim()).filter(Boolean);
      const hasHtml = types.some((t) => t.startsWith('text/html'));
      const hasPng = types.includes('image/png');
      const hasText = types.some((t) => t.startsWith('text/plain') || t === 'text');

      if (hasHtml && this.config.saveHtml) {
        const { stdout } = await execFileAsync(
          'wl-paste',
          ['--no-newline', '--type', 'text/html'],
          { timeout: 5000, maxBuffer: MAX_TEXT_BYTES },
        );
        if (stdout.length > 0) {
          await this.captureContent(stdout, 'html', 'html');
          return;
        }
      }

      if (hasPng && this.config.saveImages) {
        const { stdout } = await execFileAsync('wl-paste', ['--type', 'image/png'], {
          encoding: 'buffer',
          timeout: 10000,
          maxBuffer: MAX_IMAGE_BYTES,
        });
        if (stdout.length > 0) {
          await this.captureContent(this.saveImageToDisk(stdout), 'image', 'image');
          return;
        }
      }

      if (hasText) {
        // wl-paste's special "text" type matches any text/* offer
        const { stdout } = await execFileAsync(
          'wl-paste',
          ['--no-newline', '--type', 'text'],
          { timeout: 5000, maxBuffer: MAX_TEXT_BYTES },
        );
        if (stdout.length > 0) {
          await this.captureContent(stdout, 'text', 'text');
        }
      }
    } catch (err) {
      console.error('[ClipboardCapture] Error capturing Wayland clipboard:', err);
    }
  }

  /**
   * Poll clipboard at intervals (Wayland fallback).
   */
  private startPolling(): void {
    const pollInterval = this.config.historyDepth > 0 ? 1000 : 5000; // Faster if history enabled

    const poll = () => {
      if (!this.isCapturing) return;
      void this.processClipboard();
      this.captureTimeout = setTimeout(poll, pollInterval);
    };

    poll();
  }

  /**
   * Process the current clipboard content.
   */
  private async processClipboard(): Promise<void> {
    try {
      // Read all available clipboard formats
      const types = clipboard.availableFormats();
      let clipType: ClipType = 'text';
      let content = '';
      let source = '';

      // On Wayland, format names may vary (e.g. 'text/plain;charset=utf-8')
      // so we try reading each format and fall back to readText()
      const hasHtml = types.some(t => t.startsWith('text/html'));
      const hasImage = types.some(t => t.startsWith('image/'));
      const hasText = types.some(t => t.startsWith('text/plain') || t.startsWith('UTF8_STRING') || t.startsWith('STRING'));

      // Priority order: html > image > text
      if (hasHtml && this.config.saveHtml) {
        content = clipboard.readHTML();
        if (content && content.length > 0) {
          clipType = 'html';
          source = 'html';
        }
      }

      if (!content && hasImage && this.config.saveImages) {
        const imageBuffer = clipboard.readImage()?.toPNG();
        if (imageBuffer && imageBuffer.length > 0) {
          content = this.saveImageToDisk(imageBuffer);
          clipType = 'image';
          source = 'image';
        }
      }

      if (!content) {
        // Always try readText() — works reliably even when text/plain
        // isn't listed in availableFormats() on some platforms
        content = clipboard.readText();
        if (content && content.length > 0) {
          clipType = 'text';
          source = 'text';
        }
      }

      if (!content || content.length === 0) return;

      await this.captureContent(content, clipType, source);

    } catch (err) {
      console.error('[ClipboardCapture] Error capturing clipboard:', err);
    }
  }

  /**
   * Deduplicate and persist captured clipboard content.
   */
  private async captureContent(content: string, clipType: ClipType, source: string): Promise<void> {
    // Calculate hash for deduplication
    const hash = this.calculateHash(content);

    // Skip if same as last captured
    if (hash === this.lastClipHash) return;
    this.lastClipHash = hash;

    // Check for duplicate in database
    const exists = await clipExistsByHash(hash);
    if (exists) return;

    // Save to database
    await insertClip(content, clipType, source);
  }

  /**
   * Save image buffer to disk and return file path.
   */
  private saveImageToDisk(imageBuffer: Buffer): string {
    const clipsDir = getClipsDir();
    if (!fs.existsSync(clipsDir)) {
      fs.mkdirSync(clipsDir, { recursive: true, mode: 0o700 });
    }

    const hash = this.calculateHash(imageBuffer.toString('base64'));
    const filename = `${hash}.png`;
    const filepath = path.join(clipsDir, filename);

    // Save if not exists
    if (!fs.existsSync(filepath)) {
      fs.writeFileSync(filepath, imageBuffer);
    }

    return filepath;
  }

  /**
   * Calculate content hash for deduplication.
   */
  private calculateHash(content: string | Buffer): string {
    const crypto = require('node:crypto');
    return crypto.createHash('sha256').update(typeof content === 'string' ? content : content.toString()).digest('hex');
  }

  /**
   * Clean up expired clips based on retention policy.
   */
  async cleanExpired(): Promise<void> {
    if (this.config.retentionDays > 0) {
      await cleanExpiredClips(this.config.retentionDays);
    }
  }
}
