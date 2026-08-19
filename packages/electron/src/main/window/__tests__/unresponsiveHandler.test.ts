import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';

const showMessageBox = vi.fn();
const showMessageBoxSync = vi.fn();
vi.mock('electron', () => ({
  dialog: {
    showMessageBox: (...args: unknown[]) => showMessageBox(...args),
    showMessageBoxSync: (...args: unknown[]) => showMessageBoxSync(...args),
  },
}));

import { createUnresponsiveHandler } from '../unresponsiveHandler';

type FakeWindow = { isDestroyed: () => boolean; reload: ReturnType<typeof vi.fn> };

function makeWindow(): FakeWindow {
  return { isDestroyed: () => false, reload: vi.fn() };
}

function makeHandler(window: FakeWindow | null) {
  return createUnresponsiveHandler({
    message: 'The window is not responding',
    logLabel: '[Test]',
    getWindow: () => window as unknown as BrowserWindow | null,
  });
}

describe('createUnresponsiveHandler', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    showMessageBox.mockReset();
    showMessageBoxSync.mockReset();
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('uses the async showMessageBox, never the blocking sync variant', async () => {
    const window = makeWindow();
    showMessageBox.mockResolvedValue({ response: 1 });

    await makeHandler(window)();

    // The whole point of the fix: showMessageBoxSync blocks the main process.
    expect(showMessageBox).toHaveBeenCalledTimes(1);
    expect(showMessageBoxSync).not.toHaveBeenCalled();
  });

  it('reloads when the user chooses Reload (response 0)', async () => {
    const window = makeWindow();
    showMessageBox.mockResolvedValue({ response: 0 });

    await makeHandler(window)();

    expect(window.reload).toHaveBeenCalledTimes(1);
  });

  it('does not reload when the user chooses Keep Waiting (response 1)', async () => {
    const window = makeWindow();
    showMessageBox.mockResolvedValue({ response: 1 });

    await makeHandler(window)();

    expect(window.reload).not.toHaveBeenCalled();
  });

  it('does not open a second dialog while one is already open', async () => {
    const window = makeWindow();
    let resolveDialog: (value: { response: number }) => void = () => {};
    showMessageBox.mockImplementation(
      () => new Promise((resolve) => { resolveDialog = resolve; })
    );

    const handle = makeHandler(window);
    const first = handle(); // opens the dialog and stays pending
    await handle(); // second `unresponsive` while the dialog is open -> ignored

    expect(showMessageBox).toHaveBeenCalledTimes(1);

    resolveDialog({ response: 1 });
    await first;
  });

  it('opens again on a later event once the previous dialog has closed', async () => {
    const window = makeWindow();
    showMessageBox.mockResolvedValue({ response: 1 });

    const handle = makeHandler(window);
    await handle();
    await handle();

    expect(showMessageBox).toHaveBeenCalledTimes(2);
  });

  it('does nothing if the window is already gone', async () => {
    showMessageBox.mockResolvedValue({ response: 0 });

    await makeHandler(null)();

    expect(showMessageBox).not.toHaveBeenCalled();
  });
});
