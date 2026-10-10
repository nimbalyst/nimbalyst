// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

const handlers = new Map<string, (...args: any[]) => any>();
const listeners = new Map<string, (...args: any[]) => any>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: any[]) => any) => {
      handlers.set(channel, handler);
    }),
    on: vi.fn((channel: string, listener: (...args: any[]) => any) => {
      listeners.set(channel, listener);
    }),
    once: vi.fn((channel: string, listener: (...args: any[]) => any) => {
      listeners.set(channel, listener);
    }),
  },
}));

import { safeHandle, safeOn, safeOnce, getIpcStatsSnapshot } from '../ipcRegistry';

function statsFor(channel: string) {
  return getIpcStatsSnapshot().find((row) => row.channel === channel);
}

describe('ipcRegistry invocation stats', () => {
  beforeEach(() => {
    handlers.clear();
  });

  it('times ordinary channels but leaves agent-turn channels out of the stats', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Well above IPC_SLOW_THRESHOLD_MS so a timed channel would log [IpcSlow].
    const slowHandler = () =>
      new Promise((resolve) => setTimeout(() => resolve('done'), 1100));

    safeHandle('workspace:list', slowHandler);
    safeHandle('ai:sendMessage', slowHandler);

    await expect(handlers.get('workspace:list')!({} as any)).resolves.toBe('done');
    await expect(handlers.get('ai:sendMessage')!({} as any)).resolves.toBe('done');

    expect(statsFor('workspace:list')?.callCount).toBe(1);
    expect(statsFor('ai:sendMessage')).toBeUndefined();
    expect(warn.mock.calls.flat().join(' ')).not.toContain('ai:sendMessage');
    warn.mockRestore();
  }, 10_000);
});

describe('ipcRegistry listener errors', () => {
  // A throw escaping an ipcMain.on listener raises Electron's native
  // "JavaScript error in the main process" dialog.
  it('logs and contains sync throws and async rejections from safeOn/safeOnce listeners', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    safeOn('test:sync-throw', () => { throw new Error('sync boom'); });
    safeOn('test:async-throw', async () => { throw new Error('async boom'); });
    safeOnce('test:once-throw', () => { throw new Error('once boom'); });

    expect(() => listeners.get('test:sync-throw')!({} as any)).not.toThrow();
    expect(() => listeners.get('test:once-throw')!({} as any)).not.toThrow();
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    await listeners.get('test:async-throw')!({} as any);
    await new Promise((resolve) => setTimeout(resolve, 0));
    process.off('unhandledRejection', unhandled);

    expect(unhandled).not.toHaveBeenCalled();
    const logged = error.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(logged).toContain('test:sync-throw');
    expect(logged).toContain('test:async-throw');
    expect(logged).toContain('test:once-throw');
    error.mockRestore();
  });

  it('still rejects invoke errors from safeHandle to the renderer', async () => {
    safeHandle('test:handle-throw', () => { throw new Error('handle boom'); });
    await expect(handlers.get('test:handle-throw')!({} as any)).rejects.toThrow('handle boom');
  });
});
