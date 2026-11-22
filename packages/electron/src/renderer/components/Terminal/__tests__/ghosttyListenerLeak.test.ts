// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Terminal } from 'ghostty-web';
import { loadTerminalGhostty } from '../ghosttyInstance';

/**
 * #1818: after about 122 terminals were opened in one window, the next one
 * failed with "Out of memory: Cannot allocate Wasm memory". Every terminal
 * owns its own WASM engine. The engine should be freed once its terminal is
 * closed. It was not, because ghostty-web added a listener to the whole page
 * ("mousedown") that it never removed. That listener points back at the
 * terminal, and the terminal points at its engine, so the engine stayed in
 * memory for as long as the window lived.
 *
 * These tests open a real terminal, close it, and check that nothing it put
 * on the page is still there. The fix is the pnpm patch for ghostty-web in
 * patches/ghostty-web@0.4.0-next.20.g1858a59.patch.
 */

/** A drawing surface that does nothing. jsdom has no real canvas, and the terminal needs one to open. */
function makeFakeCanvasContext(): CanvasRenderingContext2D {
  const noop = vi.fn();
  const context = {
    canvas: undefined as unknown,
    measureText: vi.fn(() => ({
      width: 8,
      actualBoundingBoxAscent: 10,
      actualBoundingBoxDescent: 3,
      fontBoundingBoxAscent: 11,
      fontBoundingBoxDescent: 3,
    })),
    createLinearGradient: vi.fn(() => ({ addColorStop: noop })),
    getImageData: vi.fn(() => ({ data: new Uint8ClampedArray(4), width: 1, height: 1 })),
  } as Record<string, unknown>;
  // Any other drawing call (fillRect, scale, and so on) is a harmless no-op.
  return new Proxy(context, {
    get: (target, key) => (key in target ? target[key as string] : noop),
    set: (target, key, value) => {
      target[key as string] = value;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
}

type ListenerRecord = { type: string; listener: EventListenerOrEventListenerObject };

describe('ghostty-web terminal cleanup', () => {
  let added: ListenerRecord[];
  let removed: ListenerRecord[];
  let host: HTMLDivElement;

  beforeEach(() => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
      (() => makeFakeCanvasContext()) as never,
    );

    // Watch the page-level listeners. The real behaviour still runs.
    added = [];
    removed = [];
    const realAdd = document.addEventListener.bind(document);
    const realRemove = document.removeEventListener.bind(document);
    vi.spyOn(document, 'addEventListener').mockImplementation(((
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | AddEventListenerOptions,
    ) => {
      added.push({ type, listener });
      realAdd(type, listener, options);
    }) as never);
    vi.spyOn(document, 'removeEventListener').mockImplementation(((
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | EventListenerOptions,
    ) => {
      removed.push({ type, listener });
      realRemove(type, listener, options);
    }) as never);

    host = document.createElement('div');
    document.body.appendChild(host);
  });

  afterEach(() => {
    host.remove();
    vi.restoreAllMocks();
  });

  async function openTerminal(): Promise<Terminal> {
    const ghostty = await loadTerminalGhostty();
    const terminal = new Terminal({ ghostty, cols: 80, rows: 24 });
    terminal.open(host);
    return terminal;
  }

  it('removes every page-level listener when the terminal is closed', async () => {
    const terminal = await openTerminal();
    // Sanity check: the terminal really did put listeners on the page.
    expect(added.length).toBeGreaterThan(0);

    terminal.dispose();

    const leftBehind = added
      .filter((a) => !removed.some((r) => r.type === a.type && r.listener === a.listener))
      .map((a) => a.type);
    expect(leftBehind).toEqual([]);
  });

  it('lets go of the terminal engine when the terminal is closed', async () => {
    const terminal = await openTerminal();
    // The selection helper is where the engine reference is kept. Property
    // names (not minified method names) are stable in ghostty-web.
    const selectionHelper = (terminal as unknown as { selectionManager?: Record<string, unknown> })
      .selectionManager;
    expect(selectionHelper?.wasmTerm).toBeDefined();

    terminal.dispose();

    expect(selectionHelper?.wasmTerm).toBeUndefined();
    expect(selectionHelper?.renderer).toBeUndefined();
    expect(selectionHelper?.terminal).toBeUndefined();
  });
});
