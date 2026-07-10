// @vitest-environment node
//
// REGRESSION TEST for the "exports is not defined" renderer crash.
//
// The popup renderer (src/renderer/popup.ts) is loaded by popup.html as a
// CLASSIC <script>, not a module. If the compiled dist/renderer/popup.js
// contains CommonJS boilerplate (`Object.defineProperty(exports, ...)`), it
// throws "exports is not defined" at load time in the browser and silently
// kills the ENTIRE renderer — no Esc, no arrow keys, no clip rendering.
//
// The jsdom-based popup.test.ts could NOT catch this because it re-implements
// the logic inline and never loads the actual compiled artifact. This test
// loads the real dist/renderer/popup.js in a no-module global scope (exactly
// like a browser <script>) and asserts it runs clean and wires up the Esc
// handler.
//
// If this test fails, someone reintroduced a top-level import/export in
// popup.ts. Fix: keep popup.ts free of top-level import/export so tsc emits a
// plain script. See the comment block at the top of src/renderer/popup.ts.

import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';
import { execSync } from 'node:child_process';

const projectRoot = process.cwd();
const compiledPopup = path.join(projectRoot, 'dist', 'renderer', 'popup.js');

beforeAll(() => {
  // Ensure the artifact exists and is current.
  if (!fs.existsSync(compiledPopup)) {
    execSync('npm run build', { cwd: projectRoot, stdio: 'ignore' });
  }
});

/** A throwaway DOM element stub good enough for top-level execution + init(). */
function makeEl(): Record<string, unknown> {
  const el: Record<string, unknown> = {
    focus() {},
    addEventListener() {},
    querySelectorAll() {
      return [] as unknown[];
    },
    appendChild() {},
    dataset: {},
    classList: { toggle() {}, add() {}, remove() {}, contains: () => false },
    style: {},
    value: '', // popup.ts reads searchInput.value at load (applyFilter)
    contains: () => false,
  };
  // innerHTML / textContent as no-op accessors
  Object.defineProperty(el, 'innerHTML', { get: () => '', set: () => {} });
  Object.defineProperty(el, 'textContent', { get: () => '', set: () => {} });
  return el;
}

interface Listeners {
  document: Record<string, (e: unknown) => void>;
  window: Record<string, (e: unknown) => void>;
}

function runCompiledPopup(): {
  threw: Error | null;
  listeners: Listeners;
  closePopupCalls: number;
  setClosePopup: (fn: () => Promise<void>) => void;
} {
  const code = fs.readFileSync(compiledPopup, 'utf-8');
  const listeners: Listeners = { document: {}, window: {} };
  let closePopupCalls = 0;

  const ctrlc = {
    getConfig: () => Promise.resolve({ hotkey: 'Ctrl+`' }),
    getRecentClips: () => Promise.resolve([] as unknown[]),
    copyClip: () => Promise.resolve(true),
    closePopup: () => {
      closePopupCalls++;
      return Promise.resolve();
    },
  };

  const sandbox: Record<string, unknown> = {
    console,
    navigator: { clipboard: { writeText: () => Promise.resolve() } },
    document: {
      getElementById: () => makeEl(),
      createElement: () => makeEl(),
      addEventListener: (ev: string, fn: (e: unknown) => void) => {
        listeners.document[ev] = fn;
      },
    },
    window: {
      ctrlc,
      addEventListener: (ev: string, fn: (e: unknown) => void) => {
        listeners.window[ev] = fn;
      },
    },
  };
  (sandbox.window as Record<string, unknown>).window = sandbox.window;
  // CRITICAL: do NOT define module / exports / require — replicate the browser
  // classic-script global scope where those are absent.

  let threw: Error | null = null;
  try {
    vm.runInNewContext(code, sandbox, { filename: 'popup.js' });
  } catch (e) {
    threw = e as Error;
  }

  return {
    threw,
    listeners,
    get closePopupCalls() {
      return closePopupCalls;
    },
    setClosePopup: (fn: () => Promise<void>) => {
      ctrlc.closePopup = () => {
        closePopupCalls++;
        return fn();
      };
    },
  };
}

/** Run the compiled popup and wait for async init() to attach listeners. */
async function runCompiledPopupAsync(): Promise<ReturnType<typeof runCompiledPopup>> {
  const ctx = runCompiledPopup();
  // init() is async (awaits getConfig); listeners attach on a later microtask.
  await new Promise((r) => setTimeout(r, 30));
  return ctx;
}

describe('compiled popup.js (browser script-scope regression)', () => {
  it('does NOT contain CommonJS exports boilerplate', () => {
    const code = fs.readFileSync(compiledPopup, 'utf-8');
    // The exact line that broke the renderer in production.
    expect(code).not.toContain('Object.defineProperty(exports');
    expect(code).not.toMatch(/\bexports\b/);
    expect(code).not.toMatch(/\brequire\(/);
  });

  it('executes without throwing in a no-module global scope', () => {
    const { threw } = runCompiledPopup();
    if (threw) {
      throw new Error(
        `Renderer script threw at load time (the production bug): ${threw.message}`,
      );
    }
    expect(threw).toBeNull();
  });

  it('attaches a keydown listener (document or window)', async () => {
    const { listeners } = await runCompiledPopupAsync();
    const hasListener =
      typeof listeners.document.keydown === 'function' ||
      typeof listeners.window.keydown === 'function';
    expect(hasListener).toBe(true);
  });

  it('fires closePopup when Escape is dispatched', async () => {
    const ctx = await runCompiledPopupAsync();
    const escEvent = {
      key: 'Escape',
      preventDefault() {},
      stopPropagation() {},
      target: null,
    };
    if (ctx.listeners.document.keydown) ctx.listeners.document.keydown(escEvent);
    if (ctx.closePopupCalls === 0 && ctx.listeners.window.keydown) {
      ctx.listeners.window.keydown(escEvent);
    }
    expect(ctx.closePopupCalls).toBeGreaterThan(0);
  });
});
