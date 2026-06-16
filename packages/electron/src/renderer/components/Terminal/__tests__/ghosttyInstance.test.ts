import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { loadTerminalGhostty } from '../ghosttyInstance';

/**
 * ghostty-web shares one WASM memory across every terminal created from the
 * same Ghostty instance. Upstream bug coder/ghostty-web#141: freeing a
 * terminal that rendered any multi-codepoint grapheme (even a plain VS16
 * sequence like the U+2714 U+FE0F checkmark that Claude Code CLI prints)
 * corrupts that shared heap, and the next write() on ANY terminal then
 * OOB-traps or infinite-loops inside ghostty-vt.wasm. On 2026-06-10 this
 * froze the whole renderer (WASM loops are uninterruptible).
 *
 * loadTerminalGhostty must therefore hand each terminal its own isolated
 * WASM instance so a free-after-grapheme only poisons memory that is
 * discarded along with the terminal that owned it.
 */

const requireFn = createRequire(import.meta.url);
const WASM_PATH = requireFn.resolve('ghostty-web/ghostty-vt.wasm');

beforeAll(() => {
  // ghostty-web's loadFromPath only reads local files via Bun.file (its
  // fetch() fallback rejects plain paths under Node); shim the Bun API so
  // Ghostty.load(path) works in vitest's node environment.
  (globalThis as Record<string, unknown>).Bun = {
    file: (p: string) => ({
      exists: async () => true,
      arrayBuffer: async () => {
        const b = readFileSync(p);
        return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
      },
    }),
  };
});

describe('loadTerminalGhostty', () => {
  it('isolates terminals so a freed grapheme-rendering terminal cannot corrupt later ones', async () => {
    const g1 = await loadTerminalGhostty(WASM_PATH);
    const t1 = g1.createTerminal(80, 24);
    t1.write('✔️ done'); // VS16 checkmark, as printed by Claude Code CLI
    t1.free();

    const g2 = await loadTerminalGhostty(WASM_PATH);
    const t2 = g2.createTerminal(80, 24);
    expect(() => {
      for (let i = 0; i < 50; i++) {
        t2.write(`line ${i}: ordinary output written after another terminal closed\r\n`);
      }
    }).not.toThrow();
    t2.free();
  });
});
