import { Ghostty } from 'ghostty-web';

/**
 * Load a dedicated ghostty WASM instance for a single terminal.
 *
 * Deliberately NOT a shared singleton: ghostty-web shares one WASM memory
 * across all terminals created from the same Ghostty instance, and freeing a
 * terminal that rendered a multi-codepoint grapheme (even a VS16 sequence
 * like U+2714 U+FE0F, which Claude Code CLI prints constantly) corrupts that
 * shared heap — upstream coder/ghostty-web#141. The next write() on any
 * other terminal then OOB-traps or infinite-loops inside ghostty-vt.wasm; on
 * 2026-06-10 such a loop froze the entire renderer, and WASM loops cannot be
 * interrupted by V8. One instance per terminal confines the corruption to
 * memory that is discarded with the terminal that owned it. The per-mount
 * load costs one WASM decode+compile (~tens of ms), which is negligible
 * against opening a PTY.
 *
 * @param wasmPath Explicit path to ghostty-vt.wasm (tests only; the renderer
 *   resolves the module's bundled WASM automatically).
 */
export function loadTerminalGhostty(wasmPath?: string): Promise<Ghostty> {
  return Ghostty.load(wasmPath);
}
