// CtrlC Popup Renderer
// Handles the hotkey-triggered clipboard history popup
//
// IMPORTANT: This file is loaded as a classic browser <script>, NOT a module.
// It must NOT use top-level `import`/`export` — doing so makes tsc emit
// CommonJS `Object.defineProperty(exports, ...)` boilerplate that references
// `exports`, which is undefined in the browser and throws immediately,
// silently killing ALL renderer logic (Esc, arrows, search, clip loading).
// Keep ClipData mirrored from src/shared/types.ts (source of truth).
interface ClipData {
  id: string;
  createdAt: number;
  type: 'text' | 'html' | 'image' | 'file' | 'binary';
  content: string;
  contentText?: string; // plain-text flavor captured alongside html clips
  contentHash: string;
  source?: string;
  preview?: string; // base64 PNG for image clips (content is the file path)
}

let clips: ClipData[] = [];
let selectedIndex = -1;
let filteredClips: ClipData[] = [];
// Modifier held during selection to paste as plain text (from config)
let plainPasteModifier = 'ctrl';

function isPlainModifier(e: MouseEvent | KeyboardEvent): boolean {
  switch (plainPasteModifier) {
    case 'shift': return e.shiftKey;
    case 'alt': return e.altKey;
    case 'ctrl':
    default: return e.ctrlKey;
  }
}

async function refreshConfig(): Promise<void> {
  const cfg = await window.ctrlc.getConfig() as { plainPasteModifier?: string };
  if (cfg && typeof cfg.plainPasteModifier === 'string') {
    plainPasteModifier = cfg.plainPasteModifier;
  }
}

// DOM elements (always present after init)
const searchInput = document.getElementById('search-input')! as HTMLInputElement;
const clipList = document.getElementById('clip-list')!;
const clipCount = document.getElementById('clip-count')!;
const contextMenu = document.getElementById('context-menu')!;
const menuEdit = document.getElementById('menu-edit')!;
const menuDelete = document.getElementById('menu-delete')!;
const editView = document.getElementById('edit-view')!;
const editTextarea = document.getElementById('edit-textarea')! as HTMLTextAreaElement;

// Index (into filteredClips) the context menu was opened on
let menuIndex = -1;
// Clip id being edited, or null when the editor is closed
let editingId: string | null = null;

function menuVisible(): boolean {
  return !contextMenu.classList.contains('hidden');
}

function hideContextMenu(): void {
  contextMenu.classList.add('hidden');
  menuIndex = -1;
}

// Initialize on load
async function init(): Promise<void> {
  await refreshConfig();
  void loadClips();
  void setupEventListeners();
  searchInput.focus();
}

// What a clip looks like in the list (and what search matches against).
// HTML clips show their tag-stripped text so entries are distinguishable —
// the stored content is untouched, so pasting keeps the formatting. To show
// raw markup again, just return clip.content unconditionally here.
function displayText(clip: ClipData): string {
  if (clip.type === 'html') {
    return clip.contentText?.trim() || stripHtml(clip.content).trim() || clip.content;
  }
  return clip.content;
}

function applyFilter(): void {
  const query = searchInput.value.toLowerCase().trim();
  filteredClips = query
    ? clips.filter(c => displayText(c).toLowerCase().includes(query))
    : clips;
}

// Load and render clips (respects the active search filter)
async function loadClips(): Promise<void> {
  const rawClips = await window.ctrlc.getRecentClips();
  clips = rawClips;
  applyFilter();
  renderClips();
}

/** Delete the clip at the given filtered index; selection moves to the next
 *  item (same index, clamped to the new end of the list). */
async function deleteClipAt(index: number): Promise<void> {
  const clip = filteredClips[index];
  if (!clip) return;
  await window.ctrlc.deleteClip(clip.id);
  await loadClips();
  selectedIndex = filteredClips.length === 0
    ? -1
    : Math.min(index, filteredClips.length - 1);
  renderClips();
}

function openEditor(clip: ClipData): void {
  if (clip.type === 'image') return; // nothing sensible to edit
  editingId = clip.id;
  editTextarea.value = clip.content;
  editView.classList.remove('hidden');
  editTextarea.focus();
}

function closeEditor(): void {
  editingId = null;
  editView.classList.add('hidden');
  searchInput.focus();
}

async function saveEditor(): Promise<void> {
  if (editingId === null) return;
  const content = editTextarea.value;
  if (content.length > 0) {
    await window.ctrlc.updateClip(editingId, content);
  }
  closeEditor();
  await loadClips();
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
      // content holds the PNG's file path; main attaches base64 as preview
      if (clip.preview) {
        img.src = `data:image/png;base64,${clip.preview}`;
      }
      img.alt = '[image]';
      preview.appendChild(img);
    } else {
      // Truncate long text
      const full = displayText(clip);
      const text = full.length > 200 ? full.substring(0, 200) + '...' : full;
      preview.textContent = text;
    }

    item.appendChild(preview);

    // Type badge
    const badge = document.createElement('span');
    badge.className = 'clip-type-badge';
    badge.textContent = clip.type.toUpperCase();
    item.appendChild(badge);

    // Click to paste (main copies, hides the popup, and injects Ctrl+V).
    // Holding the configured modifier pastes as plain text.
    item.addEventListener('click', (e: MouseEvent) => {
      const idx = parseInt(item.dataset.index || '0');
      const clip = filteredClips[idx];
      void window.ctrlc.pasteClip(clip.id, isPlainModifier(e));
    });

    // Right-click: Edit / Delete menu
    item.addEventListener('contextmenu', (e: MouseEvent) => {
      e.preventDefault();
      menuIndex = parseInt(item.dataset.index || '0');
      const isImage = filteredClips[menuIndex]?.type === 'image';
      menuEdit.classList.toggle('disabled', isImage);
      contextMenu.classList.remove('hidden');
      // Clamp so the menu stays inside the popup
      const mw = contextMenu.offsetWidth;
      const mh = contextMenu.offsetHeight;
      contextMenu.style.left = `${Math.min(e.clientX, window.innerWidth - mw - 4)}px`;
      contextMenu.style.top = `${Math.min(e.clientY, window.innerHeight - mh - 4)}px`;
    });

    clipList.appendChild(item);
  });

  clipCount.textContent = `${clips.length} clip${clips.length !== 1 ? 's' : ''}`;
}

function setupEventListeners(): void {
  // The popup window is created once at startup and then hidden/shown, so
  // reload the clip list every time it becomes visible — otherwise the user
  // only ever sees the clips that existed when the app started.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      searchInput.value = '';
      selectedIndex = -1;
      hideContextMenu();
      closeEditor();
      void refreshConfig(); // settings may have changed while hidden
      void loadClips();
      searchInput.focus();
    }
  });

  // Search filtering
  searchInput.addEventListener('input', () => {
    applyFilter();
    selectedIndex = -1;
    renderClips();
  });

  // Context menu actions
  menuDelete.addEventListener('click', () => {
    const idx = menuIndex;
    hideContextMenu();
    void deleteClipAt(idx);
  });
  menuEdit.addEventListener('click', () => {
    if (menuEdit.classList.contains('disabled')) return;
    const clip = filteredClips[menuIndex];
    hideContextMenu();
    if (clip) openEditor(clip);
  });

  // Menu dismissal: click anywhere else, or the window losing visibility
  document.addEventListener('click', (e: MouseEvent) => {
    if (menuVisible() && !contextMenu.contains(e.target as Node)) {
      hideContextMenu();
    }
  });
  window.addEventListener('blur', hideContextMenu);

  // Editor controls
  document.getElementById('edit-save')!.addEventListener('click', () => void saveEditor());
  document.getElementById('edit-cancel')!.addEventListener('click', closeEditor);
  editTextarea.addEventListener('keydown', (e: KeyboardEvent) => {
    e.stopPropagation(); // keep list hotkeys (1-5, Enter, Del) out of the editor
    if (e.key === 'Escape') {
      e.preventDefault();
      closeEditor();
    } else if (e.key === 'Enter' && e.ctrlKey) {
      e.preventDefault();
      void saveEditor();
    }
  });

  // Keyboard navigation
  document.addEventListener('keydown', (e: KeyboardEvent) => {
    if (editingId !== null) return; // editor handles its own keys
    handleHotkeys(e);
  });

  // Also listen on window for focus issues
  window.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (editingId !== null) {
        closeEditor();
        return;
      }
      if (menuVisible()) {
        hideContextMenu();
        return;
      }
      void window.ctrlc.closePopup();
    }
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

  // Number keys 1-5 — paste one of the first 5 clips
  if (e.key >= '1' && e.key <= '5') {
    e.preventDefault();
    const index = parseInt(e.key) - 1;
    if (index < filteredClips.length) {
      const clip = filteredClips[index];
      void window.ctrlc.pasteClip(clip.id, isPlainModifier(e));
    }
    return;
  }

  // Ctrl+Shift+V — paste as plain text (same path as the modifier)
  if (e.key === 'v' && e.ctrlKey && e.shiftKey) {
    e.preventDefault();
    const idx = selectedIndex >= 0 ? selectedIndex : 0;
    if (idx < filteredClips.length) {
      const clip = filteredClips[idx];
      void window.ctrlc.pasteClip(clip.id, true);
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

  // Delete — remove the selected clip; selection moves to the next item.
  // When the search box has text, Del keeps its text-editing meaning.
  if (e.key === 'Delete') {
    if (e.target === searchInput && searchInput.value.length > 0) return;
    if (selectedIndex >= 0) {
      e.preventDefault();
      void deleteClipAt(selectedIndex);
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

  // Enter — paste selected (modifier held = plain text)
  if (e.key === 'Enter') {
    e.preventDefault();
    const idx = selectedIndex >= 0 ? selectedIndex : 0;
    if (idx < filteredClips.length) {
      const clip = filteredClips[idx];
      void window.ctrlc.pasteClip(clip.id, isPlainModifier(e));
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
  // DOMParser documents are inert: no script execution and no resource
  // fetches (clipboard HTML can contain tracking pixels).
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return doc.body.textContent || '';
}

// Start
init().catch(console.error);
