import { describe, expect, it, vi } from 'vitest';
import { waitForEditorRegistration } from '../waitForEditorRegistration';

// The hidden capture window receives offscreen mount requests as soon as the
// main process's fixed post-load delay elapses, which can be before the
// extension system has registered its custom editors (observed live on the
// React 19 boot: first .excalidraw mount threw "No custom editor registered",
// a ~5s retry then passed, blowing the 3s perf baseline). The mount path must
// wait, bounded, for registration instead of failing on first lookup.
describe('waitForEditorRegistration', () => {
  it('resolves immediately when the editor is already registered', async () => {
    const info = { extensionId: 'x', editor: {} };
    const lookup = vi.fn().mockReturnValue(info);
    await expect(waitForEditorRegistration(lookup, { timeoutMs: 1000, pollMs: 10 })).resolves.toBe(info);
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it('resolves when the editor registers after a few polls', async () => {
    const info = { extensionId: 'x', editor: {} };
    let calls = 0;
    const lookup = vi.fn().mockImplementation(() => (++calls >= 3 ? info : null));
    await expect(waitForEditorRegistration(lookup, { timeoutMs: 2000, pollMs: 5 })).resolves.toBe(info);
    expect(calls).toBeGreaterThanOrEqual(3);
  });

  it('rejects with the lookup failure after the timeout', async () => {
    const lookup = vi.fn().mockReturnValue(null);
    await expect(
      waitForEditorRegistration(lookup, { timeoutMs: 40, pollMs: 10 })
    ).rejects.toThrow(/not registered within/);
  });
});
