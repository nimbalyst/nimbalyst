import { Ghostty } from 'ghostty-web';
import ghosttyWasmDataUrl from 'ghostty-web/ghostty-vt.wasm?url&inline';

let compiledModule: Promise<WebAssembly.Module> | null = null;

/**
 * Compile the bundled ghostty-vt.wasm once per renderer. The bytes are
 * inlined at build time and decoded here, with no fetch. Ghostty.load()
 * is not used: its fallbacks are page-relative fetches that always fail in
 * the packaged app, and it throws only the last error, so a real failure
 * showed up as "Failed to fetch" (#1818).
 */
function compileGhosttyModule(): Promise<WebAssembly.Module> {
  if (!compiledModule) {
    const marker = ';base64,';
    const at = ghosttyWasmDataUrl.indexOf(marker);
    if (!ghosttyWasmDataUrl.startsWith('data:') || at < 0) {
      return Promise.reject(new Error('ghostty-vt.wasm was not inlined into the build as base64'));
    }
    const base64 = ghosttyWasmDataUrl.slice(at + marker.length);
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    compiledModule = WebAssembly.compile(bytes);
    // A failed compile is not cached, so the next terminal tries again.
    compiledModule.catch(() => { compiledModule = null; });
  }
  return compiledModule;
}

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
 * memory that is discarded with the terminal that owned it. The compiled
 * module is shared; each terminal gets its own instance and memory.
 *
 * Any compile or instantiate error (for example, no WASM memory left)
 * rejects unchanged, so the terminal panel shows the real cause.
 */
export async function loadTerminalGhostty(): Promise<Ghostty> {
  const module = await compileGhosttyModule();
  // The same imports Ghostty.load() passes: ghostty-vt only logs through env.log.
  let memory: WebAssembly.Memory | undefined;
  const instance = await WebAssembly.instantiate(module, {
    env: {
      log: (ptr: number, len: number) => {
        if (!memory) return;
        console.log('[ghostty-vt]', new TextDecoder().decode(new Uint8Array(memory.buffer, ptr, len)));
      },
    },
  });
  if (!(instance.exports.memory instanceof WebAssembly.Memory)) {
    throw new Error('ghostty-vt.wasm did not export its memory');
  }
  memory = instance.exports.memory;
  return new Ghostty(instance);
}

/**
 * True when `error` is a trap raised inside ghostty-vt.wasm (out-of-bounds
 * access, unreachable, ...). After a trap the instance's heap is in an
 * unknown state and every later call into it tends to trap again, so the
 * owning terminal must be rebuilt on a fresh instance rather than written to.
 */
export function isGhosttyWasmTrap(error: unknown): boolean {
  return error instanceof WebAssembly.RuntimeError;
}

/**
 * Write to a ghostty terminal, reporting a WASM trap instead of throwing it.
 * Returns false (after calling `onTrap`) when the instance trapped; any other
 * error is rethrown unchanged.
 */
export function writeGuardingWasmTrap(
  terminal: { write(data: string): void },
  data: string,
  onTrap: (error: unknown) => void,
): boolean {
  try {
    terminal.write(data);
    return true;
  } catch (error) {
    if (!isGhosttyWasmTrap(error)) throw error;
    onTrap(error);
    return false;
  }
}
