import { clipboard } from 'electron';
import { ClipType, AppConfig } from '../shared/types';
import { insertClip, clipExistsByHash, cleanExpiredClips } from './db';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { getClipsDir } from './config';

export class ClipboardCapture {
  private config: AppConfig;
  private isCapturing = false;
  private lastClipHash = '';
  private captureTimeout: NodeJS.Timeout | null = null;

  constructor(config: AppConfig) {
    this.config = config;
  }

  /**
   * Start listening for clipboard changes.
   * On Wayland, we use a polling approach since global clipboard events
   * may not fire reliably.
   */
  start(): void {
    if (this.isCapturing) return;
    this.isCapturing = true;

    // Start polling for clipboard changes
    this.startPolling();

    // Also try native clipboard change events (works on X11/Windows/macOS)
    this.startNativeListener();
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
   * Start native clipboard listener (X11/Windows/macOS).
   */
  private startNativeListener(): void {
    // Electron's clipboard API doesn't have a change event,
    // so we rely on polling. This method is a placeholder
    // if we want to add platform-specific listeners later.
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

      // Priority order: html > image > text
      if (types.includes('text/html') && this.config.saveHtml) {
        content = clipboard.readHTML();
        clipType = 'html';
        source = 'html';
      } else if (types.includes('image/png') && this.config.saveImages) {
        const imageBuffer = clipboard.readImage()?.toPNG();
        if (imageBuffer) {
          content = this.saveImageToDisk(imageBuffer);
          clipType = 'image';
          source = 'image';
        }
      } else if (types.includes('text/plain')) {
        content = clipboard.readText();
        clipType = 'text';
        source = 'text';
      }

      if (!content || content.length === 0) return;

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

    } catch (err) {
      console.error('[ClipboardCapture] Error capturing clipboard:', err);
    }
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
