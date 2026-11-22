// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import { loadTerminalGhostty, writeGuardingWasmTrap } from '../ghosttyInstance';

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

describe('loadTerminalGhostty', () => {
  it('isolates terminals so a freed grapheme-rendering terminal cannot corrupt later ones', async () => {
    const g1 = await loadTerminalGhostty();
    const t1 = g1.createTerminal(80, 24);
    t1.write('✔️ done'); // VS16 checkmark, as printed by Claude Code CLI
    t1.free();

    const g2 = await loadTerminalGhostty();
    const t2 = g2.createTerminal(80, 24);
    expect(() => {
      for (let i = 0; i < 50; i++) {
        t2.write(`line ${i}: ordinary output written after another terminal closed\r\n`);
      }
    }).not.toThrow();
    t2.free();
  });

  it('does not trap when rows holding graphemes are recycled by scrolling', async () => {
    // Upstream coder/ghostty-web#138 (fixed in 0.4.0-next.18 by #180): a row
    // recycled by scrolling kept its stale cells, including grapheme cells
    // whose storage was gone, so a later write OOB-trapped and every write
    // after that trapped too. A user's persisted scrollback hit this on every
    // restore and the terminal showed no further output. The trap depends on
    // exact page layout, so sweep a few shapes; 0.4.0 traps on 9 of 12.
    const ESC = '\x1b';
    const payload = (sections: number): string => {
      const graphemes = `${ESC}[1m${'⛅️'.repeat(36)}${ESC}[0m`;
      const lines = [graphemes];
      for (let s = 0; s < sections; s++) {
        for (let row = 0; row < 8; row++) {
          let line = '';
          for (let i = 0; i < 70; i++) line += `${ESC}[38;5;${(s * 64 + row * 8 + i) % 256}m*${ESC}[0m`;
          lines.push(line);
        }
        lines.push('');
      }
      lines.push(graphemes);
      return lines.join('\r\n') + '\r\n';
    };

    const trapped: string[] = [];
    for (const sections of [1, 2, 3, 4]) {
      for (const [cols, rows] of [[80, 24], [120, 40], [160, 39]]) {
        const ghostty = await loadTerminalGhostty();
        const term = ghostty.createTerminal(cols, rows, { scrollbackLimit: 10_000_000 });
        const data = payload(sections);
        try {
          for (let rep = 0; rep < 30; rep++) term.write(data);
          term.write('still alive\r\n');
        } catch {
          trapped.push(`${sections} sections at ${cols}x${rows}`);
        }
      }
    }
    expect(trapped).toEqual([]);
  });

  it('reports the real load error instead of a fallback "Failed to fetch"', async () => {
    // #1818: Ghostty.load() falls back to page-relative fetches that always
    // fail in the packaged app and throws only the last error, so a terminal
    // that could not get WASM memory showed "Failed to fetch".
    const spy = vi.spyOn(WebAssembly, 'instantiate').mockRejectedValueOnce(
      new RangeError('WebAssembly.instantiate(): Out of memory: Cannot allocate Wasm memory'),
    );
    try {
      await expect(loadTerminalGhostty()).rejects.toThrow(/Out of memory/);
    } finally {
      spy.mockRestore();
    }
  });

  it('rejects with a clear message when the engine exports no memory', async () => {
    // The terminal engine must hand back its working memory. If it does not,
    // the load must stop with a plain message instead of failing later in a
    // confusing way. Here the fake engine has no exports at all.
    const engineWithoutMemory = { exports: {} } as unknown as WebAssembly.Instance;
    const spy = vi.spyOn(WebAssembly, 'instantiate').mockResolvedValueOnce(
      engineWithoutMemory as never,
    );
    try {
      await expect(loadTerminalGhostty()).rejects.toThrow(/did not export its memory/);
    } finally {
      spy.mockRestore();
    }
  });

  it('retries the compile on the next load after a compile failure', async () => {
    vi.resetModules();
    const { loadTerminalGhostty: freshLoad } = await import('../ghosttyInstance');
    const spy = vi.spyOn(WebAssembly, 'compile').mockRejectedValueOnce(
      new RangeError('WebAssembly.compile(): Out of memory'),
    );
    try {
      await expect(freshLoad()).rejects.toThrow(/Out of memory/);
      // A cached failure would reject here forever; every new terminal would fail.
      await expect(freshLoad()).resolves.toBeDefined();
      expect(spy).toHaveBeenCalledTimes(2);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('writeGuardingWasmTrap', () => {
  it('reports a WASM trap to onTrap and rethrows anything else', () => {
    // (module (func (export "f") unreachable))
    const trapModule = new WebAssembly.Instance(new WebAssembly.Module(new Uint8Array([
      0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x01, 0x04, 0x01, 0x60, 0x00, 0x00,
      0x03, 0x02, 0x01, 0x00, 0x07, 0x05, 0x01, 0x01, 0x66, 0x00, 0x00, 0x0a, 0x05, 0x01,
      0x03, 0x00, 0x00, 0x0b,
    ])));
    const trapping = { write: () => (trapModule.exports.f as () => void)() };
    const onTrap = vi.fn();

    expect(writeGuardingWasmTrap(trapping, 'x', onTrap)).toBe(false);
    expect(onTrap.mock.calls[0][0]).toBeInstanceOf(WebAssembly.RuntimeError);
    expect(writeGuardingWasmTrap({ write: () => {} }, 'x', onTrap)).toBe(true);

    const notATrap = { write: () => { throw new TypeError('terminal is not open'); } };
    expect(() => writeGuardingWasmTrap(notATrap, 'x', onTrap)).toThrow(TypeError);
    expect(onTrap).toHaveBeenCalledTimes(1);
  });
});
