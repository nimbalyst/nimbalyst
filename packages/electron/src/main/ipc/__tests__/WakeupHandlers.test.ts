// @vitest-environment node
/**
 * wakeup:create is the user-facing "Run later" creation path (#1497) — the only
 * handler in this file that accepts caller-supplied input, so it's the one
 * worth guarding: a missing field or a past fireAt must fail fast rather than
 * silently scheduling something that fires immediately or never.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const handlers = new Map<string, (event: unknown, ...args: any[]) => any>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, ...args: any[]) => any) => {
      handlers.set(channel, handler);
    },
  },
  BrowserWindow: { getAllWindows: () => [] },
}));

vi.mock('electron-log/main', () => ({
  default: { scope: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));

const createSpy = vi.fn(async (input: unknown) => ({ id: 'wakeup-1', ...(input as object) }));
vi.mock('../../services/sessionWakeupScheduling', () => ({
  scheduleSessionWakeup: createSpy,
}));
vi.mock('../../services/RepositoryManager', () => ({ getSessionWakeupsStore: vi.fn() }));
vi.mock('../../services/SessionWakeupScheduler', () => ({
  SessionWakeupScheduler: { getInstance: vi.fn() },
}));

const getSessionSpy = vi.fn(async (sessionId: string): Promise<{ id: string } | null> => ({ id: sessionId }));
vi.mock('@nimbalyst/runtime/storage/repositories/AISessionsRepository', () => ({
  AISessionsRepository: { get: getSessionSpy },
}));

describe('wakeup:create', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    handlers.clear();
    const { registerWakeupHandlers } = await import('../WakeupHandlers');
    registerWakeupHandlers();
  });

  const call = (args: Record<string, unknown>) => handlers.get('wakeup:create')!(null, args);

  it('rejects a missing sessionId', async () => {
    await expect(call({ workspacePath: '/w', prompt: 'hi', fireAt: Date.now() + 3_600_000 }))
      .rejects.toThrow(/sessionId/);
  });

  it('rejects a missing workspacePath', async () => {
    await expect(call({ sessionId: 's1', prompt: 'hi', fireAt: Date.now() + 3_600_000 }))
      .rejects.toThrow(/workspacePath/);
  });

  it('rejects an empty prompt', async () => {
    await expect(call({ sessionId: 's1', workspacePath: '/w', prompt: '  ', fireAt: Date.now() + 3_600_000 }))
      .rejects.toThrow(/prompt/);
  });

  it('rejects a fireAt less than 30s in the future', async () => {
    await expect(call({ sessionId: 's1', workspacePath: '/w', prompt: 'hi', fireAt: Date.now() + 1_000 }))
      .rejects.toThrow(/30s in the future/);
  });

  it('rejects a sessionId that does not resolve to a real session', async () => {
    getSessionSpy.mockResolvedValueOnce(null);
    await expect(call({ sessionId: 'gone', workspacePath: '/w', prompt: 'hi', fireAt: Date.now() + 3_600_000 }))
      .rejects.toThrow(/not found/);
    expect(createSpy).not.toHaveBeenCalled();
  });

  it('forwards attachments so a scheduled prompt keeps its images', async () => {
    const attachments = [{ id: 'a1', filename: 'shot.png', type: 'image' }];
    await call({ sessionId: 's1', workspacePath: '/w', prompt: 'hi', fireAt: Date.now() + 3_600_000, attachments });

    expect(createSpy).toHaveBeenCalledWith(expect.objectContaining({ attachments }));
  });

  it('omits attachments when the caller sends a non-array', async () => {
    await call({ sessionId: 's1', workspacePath: '/w', prompt: 'hi', fireAt: Date.now() + 3_600_000, attachments: 'nope' });

    expect(createSpy).toHaveBeenCalledWith(expect.objectContaining({ attachments: undefined }));
  });

  it('schedules valid input as a user wakeup, which never replaces another', async () => {
    const fireAt = Date.now() + 3_600_000;
    await call({ sessionId: 's1', workspacePath: '/w', prompt: 'hi', fireAt });

    expect(createSpy).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 's1',
      workspaceId: '/w',
      prompt: 'hi',
      fireAt,
      origin: 'user',
    }));
  });
});
