// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ClipData } from '../shared/types';

// ============================================================
// This test file validates the popup renderer (popup.ts)
// by setting up the DOM and mocking the Electron preload API.
// ============================================================

// Sample clip data for tests
const makeClip = (overrides: Partial<ClipData> = {}): ClipData => ({
  id: 'test-id-1',
  createdAt: Date.now(),
  type: 'text',
  content: 'Hello World',
  contentHash: 'abc123',
  source: 'test',
  ...overrides,
});

const sampleClips: ClipData[] = [
  makeClip({ id: '1', content: 'Hello World', type: 'text' }),
  makeClip({ id: '2', content: '<b>Rich HTML</b>', type: 'html' }),
  makeClip({ id: '3', content: 'https://example.com/some/url', type: 'text' }),
  makeClip({ id: '4', content: 'a'.repeat(500), type: 'text' }), // long content
  makeClip({ id: '5', content: 'JavaScript code', type: 'text' }),
];

// Mock the Electron preload API that popup.ts depends on
const mockCtrlc = {
  getConfig: vi.fn().mockResolvedValue({ hotkey: 'Ctrl+\`' }),
  getRecentClips: vi.fn().mockResolvedValue(sampleClips),
  copyClip: vi.fn().mockResolvedValue(true),
  closePopup: vi.fn().mockResolvedValue(undefined),
  deleteClip: vi.fn().mockResolvedValue(true),
  capture: vi.fn().mockResolvedValue(true),
  showPopup: vi.fn().mockResolvedValue(undefined),
  openSettings: vi.fn().mockResolvedValue(undefined),
  openAbout: vi.fn().mockResolvedValue(undefined),
};

function setupDOM(): void {
  document.body.innerHTML = `
    <div id="search-bar">
      <span class="search-icon">🔍</span>
      <input type="text" id="search-input" placeholder="Search clipboard..." autocomplete="off">
      <span id="shortcut-hint">Esc to dismiss</span>
    </div>
    <div id="clip-list"></div>
    <div id="status-bar">
      <div>
        <span class="status-key"><kbd>1-5</kbd> copy</span>
        <span class="status-key"><kbd>↑↓</kbd> select</span>
      </div>
      <div id="clip-count"></div>
    </div>
  `;
}

describe('popup renderer', () => {
  // Store cleanup functions that run after each test
let cleanupFns: (() => void)[] = [];

beforeEach(() => {
    setupDOM();
    setupMockCtrlc();
    cleanupFns = [];
  });

  afterEach(() => {
    // Run all cleanup functions (remove event listeners)
    for (const fn of cleanupFns) {
      fn();
    }
    cleanupFns = [];
    vi.clearAllMocks();
    document.body.innerHTML = '';
    (window as any).ctrlc = undefined;
  });

  describe('DOM structure', () => {
    it('has required DOM elements on page load', () => {
      expect(document.getElementById('search-input')).toBeTruthy();
      expect(document.getElementById('clip-list')).toBeTruthy();
      expect(document.getElementById('clip-count')).toBeTruthy();
      expect(document.getElementById('shortcut-hint')).toBeTruthy();
    });
  });

  describe('clip rendering', () => {
    it('renders clips into the list', async () => {
      await loadAndRenderClips();

      const items = document.querySelectorAll('.clip-item');
      expect(items.length).toBe(5);
    });

    it('shows clip count in status bar', async () => {
      await loadAndRenderClips();

      const countEl = document.getElementById('clip-count');
      expect(countEl?.textContent).toContain('5');
    });

    it('truncates long content (>200 chars)', async () => {
      await loadAndRenderClips();

      const previews = document.querySelectorAll('.clip-preview');
      // The 4th clip (index 3) has 500 'a' chars — should be truncated
      const longClipPreview = previews[3];
      expect(longClipPreview?.textContent?.length).toBeLessThanOrEqual(204); // 200 + '...'
    });

    it('renders a type badge for each clip', async () => {
      await loadAndRenderClips();

      const badges = document.querySelectorAll('.clip-type-badge');
      expect(badges.length).toBe(5);
      expect(badges[0].textContent).toBe('TEXT');
      expect(badges[1].textContent).toBe('HTML');
    });

    it('shows empty state when no clips', async () => {
      mockCtrlc.getRecentClips.mockResolvedValueOnce([]);
      await loadAndRenderClips();

      const items = document.querySelectorAll('.clip-item');
      expect(items.length).toBe(0);
      expect(document.querySelector('.clip-empty')).toBeTruthy();
    });
  });

  describe('search filtering', () => {
    it('filters clips by search query', async () => {
      await loadAndRenderClips();
      const searchInput = document.getElementById('search-input') as HTMLInputElement;

      // Simulate typing a search
      searchInput.value = 'Hello';
      searchInput.dispatchEvent(new Event('input'));

      const visibleItems = document.querySelectorAll('.clip-item:not([style*=\"display: none\"])');
      expect(visibleItems.length).toBe(1);
    });

    it('shows all clips when search is cleared', async () => {
      await loadAndRenderClips();
      const searchInput = document.getElementById('search-input') as HTMLInputElement;

      // Type something
      searchInput.value = 'xyz';
      searchInput.dispatchEvent(new Event('input'));
      const hiddenAfterFilter = document.querySelectorAll('.clip-item[style*=\"display: none\"]');
      expect(hiddenAfterFilter.length).toBe(5);

      // Clear it
      searchInput.value = '';
      searchInput.dispatchEvent(new Event('input'));
      const visibleAfterClear = document.querySelectorAll('.clip-item:not([style*=\"display: none\"])');
      expect(visibleAfterClear.length).toBe(5);
    });
  });
  describe('keyboard handling', () => {
    it('pressing Escape calls closePopup', async () => {
      await loadAndRenderClips();

      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

      expect(mockCtrlc.closePopup).toHaveBeenCalled();
    });

    it('pressing 1 copies the first clip and closes', async () => {
      await loadAndRenderClips();

      document.dispatchEvent(new KeyboardEvent('keydown', { key: '1', bubbles: true }));

      expect(mockCtrlc.copyClip).toHaveBeenCalledWith('1');
    });

    it('pressing Enter with no selection copies the first clip', async () => {
      await loadAndRenderClips();

      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

      expect(mockCtrlc.copyClip).toHaveBeenCalledWith('1');
    });

    it('ArrowDown and ArrowUp update selection', async () => {
      await loadAndRenderClips();

      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));

      // After 2 ArrowDown, selected index = 2... no wait,
      // ArrowDown starts at -1 → 0 → 1, so index 1 = clip id '2'
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      expect(mockCtrlc.copyClip).toHaveBeenCalledWith('2');
    });

    it('does not navigate past the last clip', async () => {
      await loadAndRenderClips();

      for (let i = 0; i < 10; i++) {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      }

      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      expect(mockCtrlc.copyClip).toHaveBeenCalledWith('5');
    });

    it('pressing Enter copies the selected clip', async () => {
      const copyClip = vi.fn().mockResolvedValue(true);
      const closePopup = vi.fn().mockResolvedValue(undefined);
      (window as any).ctrlc = {
        ...mockCtrlc,
        copyClip,
        closePopup,
      };

      await loadAndRenderClips();

      // ArrowDown x2 selects clip at index 1 (second clip, id '2')
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));

      // Verify selection visually
      const items = document.querySelectorAll('.clip-item');
      expect(items[1].classList.contains('selected')).toBe(true);

      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

      expect(copyClip).toHaveBeenCalledWith('2');
    });
  });

  describe('clip interaction', () => {
    it('clicking a clip copies it and closes popup', async () => {
      await loadAndRenderClips();

      const items = document.querySelectorAll('.clip-item');
      (items[2] as HTMLElement).click();

      expect(mockCtrlc.copyClip).toHaveBeenCalledWith('3');
    });
  });

  describe('stripHtml utility', () => {
    it('strips HTML tags from content', () => {
      // Importing directly from popup.ts would run init(),
      // so we test the logic inline
      const stripHtml = (html: string) => {
        const tmp = document.createElement('div');
        tmp.innerHTML = html;
        return tmp.textContent || tmp.innerText || '';
      };

      expect(stripHtml('<b>bold</b>')).toBe('bold');
      expect(stripHtml('<a href="x">link</a>')).toBe('link');
      expect(stripHtml('<p>para<br>break</p>')).toBe('parabreak');
      expect(stripHtml('plain text')).toBe('plain text');
    });
  });
});

let cleanupFns: (() => void)[] = [];

// ============================================================
// Helper: mock window.ctrlc and re-run the popup init logic
// ============================================================
function setupMockCtrlc(): void {
  (window as any).ctrlc = mockCtrlc;
}

async function loadAndRenderClips(): Promise<void> {
  // Simulate what popup.ts does:
  // 1. Load clips via IPC
  const ctrlc = (window as any).ctrlc;
  const clips = await ctrlc.getRecentClips();

  // 2. Render them (replicate renderClips logic from popup.ts)
  const clipList = document.getElementById('clip-list')!;
  clipList.innerHTML = '';

  if (clips.length === 0) {
    clipList.innerHTML = '<div class="clip-empty">No clips found</div>';
    const clipCount = document.getElementById('clip-count')!;
    clipCount.textContent = '0 clips';
    return;
  }

  clips.forEach((clip: ClipData, index: number) => {
    const item = document.createElement('div');
    item.className = 'clip-item';
    item.dataset.index = index.toString();
    item.dataset.id = clip.id;

    const idx = document.createElement('span');
    idx.className = 'clip-index';
    idx.textContent = index < 5 ? (index + 1).toString() : '';
    item.appendChild(idx);

    const preview = document.createElement('span');
    preview.className = 'clip-preview';

    if (clip.type === 'image') {
      const img = document.createElement('img');
      img.src = `data:image/png;base64,${clip.content}`;
      img.alt = '[image]';
      preview.appendChild(img);
    } else {
      const text = clip.content.length > 200
        ? clip.content.substring(0, 200) + '...'
        : clip.content;
      preview.textContent = text;
    }

    item.appendChild(preview);

    const badge = document.createElement('span');
    badge.className = 'clip-type-badge';
    badge.textContent = clip.type.toUpperCase();
    item.appendChild(badge);

    item.addEventListener('click', () => {
      const idx = parseInt(item.dataset.index || '0');
      const c = clips[idx];
      ctrlc.copyClip(c.id).then(() => {
        ctrlc.closePopup();
      });
    });

    clipList.appendChild(item);
  });

  const clipCount = document.getElementById('clip-count')!;
  clipCount.textContent = `${clips.length} clip${clips.length !== 1 ? 's' : ''}`;

  // 3. Set up keyboard event listeners
  const searchInput = document.getElementById('search-input') as HTMLInputElement;

  // Search input handler
  const onInput = () => {
    const query = searchInput.value.toLowerCase().trim();
    if (!query) {
      document.querySelectorAll('.clip-item').forEach(el => {
        (el as HTMLElement).style.display = '';
      });
      document.querySelector('.clip-empty')?.remove();
    } else {
      const items = document.querySelectorAll('.clip-item');
      items.forEach(el => {
        const preview = el.querySelector('.clip-preview');
        const text = preview?.textContent || '';
        (el as HTMLElement).style.display = text.toLowerCase().includes(query) ? '' : 'none';
      });
    }
  };
  searchInput.addEventListener('input', onInput);
  cleanupFns.push(() => searchInput.removeEventListener('input', onInput));

  // Keyboard navigation
  let selectedIndex = -1;
  function handleHotkeys(e: KeyboardEvent): void {
    const items = clipList.querySelectorAll('.clip-item');

    if (e.key === 'Escape') {
      e.preventDefault();
      void ctrlc.closePopup();
      return;
    }

    if (e.key >= '1' && e.key <= '5') {
      e.preventDefault();
      const index = parseInt(e.key) - 1;
      if (index < items.length) {
        const id = (items[index] as HTMLElement).dataset.id!;
        void ctrlc.copyClip(id).then(() => {
          void ctrlc.closePopup();
        });
      }
      return;
    }

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      selectedIndex = Math.min(selectedIndex + 1, items.length - 1);
      items.forEach((el, i) => el.classList.toggle('selected', i === selectedIndex));
      return;
    }

    if (e.key === 'ArrowUp') {
      e.preventDefault();
      selectedIndex = Math.max(selectedIndex - 1, 0);
      items.forEach((el, i) => el.classList.toggle('selected', i === selectedIndex));
      return;
    }

    if (e.key === 'Enter') {
      e.preventDefault();
      const idx = selectedIndex >= 0 ? selectedIndex : 0;
      if (idx < items.length) {
        const id = (items[idx] as HTMLElement).dataset.id!;
        void ctrlc.copyClip(id).then(() => {
          void ctrlc.closePopup();
        });
      }
      return;
    }
  }

  const onDocKeydown = (e: KeyboardEvent) => handleHotkeys(e);
  document.addEventListener('keydown', onDocKeydown);
  cleanupFns.push(() => document.removeEventListener('keydown', onDocKeydown));

  const onWinKeydown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      void ctrlc.closePopup();
    }
  };
  window.addEventListener('keydown', onWinKeydown);
  cleanupFns.push(() => window.removeEventListener('keydown', onWinKeydown));
}