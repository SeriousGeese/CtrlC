// CtrlC Popup Renderer
// Handles the hotkey-triggered clipboard history popup

import { ClipData } from '../shared/types';

let clips: ClipData[] = [];
let selectedIndex = -1;
let filteredClips: ClipData[] = [];

// DOM elements (always present after init)
const searchInput = document.getElementById('search-input')! as HTMLInputElement;
const clipList = document.getElementById('clip-list')!;
const clipCount = document.getElementById('clip-count')!;

// Initialize on load
async function init(): Promise<void> {
  await window.ctrlc.getConfig();
  void loadClips();
  void setupEventListeners();
  searchInput.focus();
}

// Load and render clips
async function loadClips(): Promise<void> {
  const rawClips = await window.ctrlc.getRecentClips();
  clips = rawClips;
  filteredClips = clips;
  renderClips();
}

function renderClips(): void {
  clipList.innerHTML = '';

  if (filteredClips.length === 0) {
    clipList.innerHTML = '<div class="clip-empty">No clips found</div>';
    clipCount.textContent = '0 clips';
    return;
  }

  filteredClips.forEach((clip, index) => {
    const item = document.createElement('div');
    item.className = 'clip-item' + (index === selectedIndex ? ' selected' : '');
    item.dataset.index = index.toString();
    item.dataset.id = clip.id;

    // Index key (1-5 visible)
    const idx = document.createElement('span');
    idx.className = 'clip-index';
    idx.textContent = index < 5 ? (index + 1).toString() : '';
    item.appendChild(idx);

    // Preview
    const preview = document.createElement('span');
    preview.className = 'clip-preview';

    if (clip.type === 'image') {
      const img = document.createElement('img');
      img.src = `data:image/png;base64,${clip.content}`;
      img.alt = '[image]';
      preview.appendChild(img);
    } else {
      // Truncate long text
      const text = clip.content.length > 200
        ? clip.content.substring(0, 200) + '...'
        : clip.content;
      preview.textContent = text;
    }

    item.appendChild(preview);

    // Type badge
    const badge = document.createElement('span');
    badge.className = 'clip-type-badge';
    badge.textContent = clip.type.toUpperCase();
    item.appendChild(badge);

    // Click to copy
    item.addEventListener('click', () => {
      const idx = parseInt(item.dataset.index || '0');
      const clip = filteredClips[idx];
      void window.ctrlc.copyClip(clip.id).then(() => {
        void window.ctrlc.closePopup();
      });
    });

    clipList.appendChild(item);
  });

  clipCount.textContent = `${clips.length} clip${clips.length !== 1 ? 's' : ''}`;
}

function setupEventListeners(): void {
  // Search filtering
  searchInput.addEventListener('input', () => {
    const query = searchInput.value.toLowerCase().trim();
    if (!query) {
      filteredClips = clips;
    } else {
      filteredClips = clips.filter(c =>
        c.content.toLowerCase().includes(query)
      );
    }
    selectedIndex = -1;
    renderClips();
  });

  // Keyboard navigation
  document.addEventListener('keydown', (e: KeyboardEvent) => {
    handleHotkeys(e);
  });

  // Hide on blur (window loses focus)
  void (window as { electron?: { remote?: { getCurrentWindow?: () => unknown } } }).electron?.remote?.getCurrentWindow?.();
}

// Handle keyboard shortcuts in the popup
function handleHotkeys(e: KeyboardEvent): void {
  // Escape — close without pasting
  if (e.key === 'Escape') {
    e.preventDefault();
    void window.ctrlc.closePopup();
    return;
  }

  // Number keys 1-5 — copy first 5 clips
  if (e.key >= '1' && e.key <= '5') {
    e.preventDefault();
    const index = parseInt(e.key) - 1;
    if (index < filteredClips.length) {
      const clip = filteredClips[index];
      void window.ctrlc.copyClip(clip.id).then(() => {
        void window.ctrlc.closePopup();
      });
    }
    return;
  }

  // Ctrl+Shift+V — paste as plain text
  if (e.key === 'v' && e.ctrlKey && e.shiftKey) {
    e.preventDefault();
    const idx = selectedIndex >= 0 ? selectedIndex : 0;
    if (idx < filteredClips.length) {
      const clip = filteredClips[idx];
      // Copy as plain text (strips HTML)
      const textOnly = stripHtml(clip.content);
      void navigator.clipboard.writeText(textOnly).then(() => {
        void window.ctrlc.closePopup();
      });
    }
    return;
  }

  // Ctrl+V — copy as-is (preserves formatting)
  if (e.key === 'v' && e.ctrlKey) {
    e.preventDefault();
    const idx = selectedIndex >= 0 ? selectedIndex : 0;
    if (idx < filteredClips.length) {
      const clip = filteredClips[idx];
      void window.ctrlc.copyClip(clip.id).then(() => {
        void window.ctrlc.closePopup();
      });
    }
    return;
  }

  // Arrow keys — navigation
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    selectedIndex = Math.min(selectedIndex + 1, filteredClips.length - 1);
    updateSelection();
    return;
  }

  if (e.key === 'ArrowUp') {
    e.preventDefault();
    selectedIndex = Math.max(selectedIndex - 1, 0);
    updateSelection();
    return;
  }

  // Enter — copy selected
  if (e.key === 'Enter') {
    e.preventDefault();
    const idx = selectedIndex >= 0 ? selectedIndex : 0;
    if (idx < filteredClips.length) {
      const clip = filteredClips[idx];
      void window.ctrlc.copyClip(clip.id).then(() => {
        void window.ctrlc.closePopup();
      });
    }
  }
}

function updateSelection(): void {
  const items = clipList.querySelectorAll('.clip-item');
  items.forEach((item, i) => {
    item.classList.toggle('selected', i === selectedIndex);
  });

  // Scroll selected into view
  if (selectedIndex >= 0 && items[selectedIndex]) {
    (items[selectedIndex] as HTMLElement).scrollIntoView({ block: 'nearest' });
  }
}

function stripHtml(html: string): string {
  const tmp = document.createElement('div');
  tmp.innerHTML = html;
  return tmp.textContent || tmp.innerText || '';
}

// Start
init().catch(console.error);
