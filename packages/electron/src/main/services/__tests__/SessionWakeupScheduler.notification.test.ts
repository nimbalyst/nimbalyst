// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  notifications: [] as Array<{ handlers: Map<string, () => void> }>,
  findWindowByWorkspace: vi.fn(),
}));

vi.mock('electron-log/main', () => ({
  default: { scope: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));
vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  Notification: class {
    static isSupported() { return true; }
    handlers = new Map<string, () => void>();
    constructor() { mocks.notifications.push(this); }
    on(event: string, handler: () => void) { this.handlers.set(event, handler); }
    show() {}
  },
}));
vi.mock('../../window/WindowManager', () => ({ findWindowByWorkspace: mocks.findWindowByWorkspace }));
vi.mock('../notificationIcons', () => ({ resolveNotificationIcon: () => undefined }));

import { notifyWakeupFired } from '../SessionWakeupScheduler';

describe('wakeup notification click', () => {
  // The window holding the project may be showing another rail project. The
  // click has to name the project so the renderer switches to it before it
  // selects the session; a bare session id selected it under the active one.
  it('routes the click through notification navigation with the session\'s project', () => {
    const send = vi.fn();
    mocks.findWindowByWorkspace.mockReturnValue({
      isDestroyed: () => false, isMinimized: () => false, restore: vi.fn(), show: vi.fn(), focus: vi.fn(),
      webContents: { send },
    });

    notifyWakeupFired({ id: 'w1', sessionId: 'session-b', workspaceId: '/projects/b', reason: 'Check CI' } as never);
    mocks.notifications.at(-1)!.handlers.get('click')!();

    expect(mocks.findWindowByWorkspace).toHaveBeenCalledWith('/projects/b');
    expect(send).toHaveBeenCalledWith('notification-clicked', {
      sessionId: 'session-b',
      workspacePath: '/projects/b',
      sourceLabel: expect.any(String),
    });
  });
});
