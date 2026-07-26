import { beforeEach, describe, expect, it, vi } from 'vitest';

const optIn = vi.fn(async () => {});
const optOut = vi.fn(async () => {});
const windows: Array<{ isDestroyed: () => boolean; webContents: { send: ReturnType<typeof vi.fn> } }> = [];

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => windows },
}));

vi.mock('../AnalyticsService', () => ({
  AnalyticsService: { getInstance: () => ({ optIn, optOut }) },
}));

import { applyAnalyticsEnabled } from '../applyAnalyticsEnabled';

function addWindow(destroyed = false) {
  const win = { isDestroyed: () => destroyed, webContents: { send: vi.fn() } };
  windows.push(win);
  return win;
}

describe('applyAnalyticsEnabled', () => {
  beforeEach(() => {
    windows.length = 0;
    optIn.mockClear();
    optOut.mockClear();
  });

  it('opts the main-process client out and tells every window', async () => {
    const a = addWindow();
    const b = addWindow();

    await applyAnalyticsEnabled(false);

    expect(optOut).toHaveBeenCalledTimes(1);
    expect(optIn).not.toHaveBeenCalled();
    expect(a.webContents.send).toHaveBeenCalledWith('analytics:enabled-changed', false);
    expect(b.webContents.send).toHaveBeenCalledWith('analytics:enabled-changed', false);
  });

  it('opts back in and tells every window', async () => {
    const a = addWindow();

    await applyAnalyticsEnabled(true);

    expect(optIn).toHaveBeenCalledTimes(1);
    expect(optOut).not.toHaveBeenCalled();
    expect(a.webContents.send).toHaveBeenCalledWith('analytics:enabled-changed', true);
  });

  it('skips destroyed windows', async () => {
    const dead = addWindow(true);
    const live = addWindow();

    await applyAnalyticsEnabled(false);

    expect(dead.webContents.send).not.toHaveBeenCalled();
    expect(live.webContents.send).toHaveBeenCalled();
  });

  it('still notifies the remaining windows when one send throws', async () => {
    const broken = addWindow();
    broken.webContents.send.mockImplementation(() => { throw new Error('window gone'); });
    const healthy = addWindow();

    await expect(applyAnalyticsEnabled(false)).resolves.toBeUndefined();

    expect(healthy.webContents.send).toHaveBeenCalledWith('analytics:enabled-changed', false);
  });

  it('notifies windows only after the client has opted out', async () => {
    const order: string[] = [];
    optOut.mockImplementation(async () => { order.push('optOut'); });
    const win = addWindow();
    win.webContents.send.mockImplementation(() => { order.push('broadcast'); });

    await applyAnalyticsEnabled(false);

    expect(order).toEqual(['optOut', 'broadcast']);
  });
});
