// @vitest-environment node
import { describe, expect, it, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => any>(),
  send: vi.fn(),
  service: { validateMove: vi.fn(), moveProject: vi.fn() },
}));

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [{ isDestroyed: () => false, webContents: { send: mocks.send } }] },
}));
vi.mock('../../utils/ipcRegistry', () => ({
  safeHandle: (channel: string, handler: (...args: any[]) => any) => mocks.handlers.set(channel, handler),
}));
vi.mock('../../utils/logger', () => ({ logger: { main: { info: vi.fn(), error: vi.fn() } } }));
vi.mock('../../services/ProjectMigrationService', () => ({ getProjectMigrationService: () => mocks.service }));

import { registerProjectMigrationHandlers } from '../ProjectMigrationHandlers';

describe('project:move runs in the background', () => {
  beforeEach(() => {
    mocks.handlers.clear();
    mocks.send.mockReset();
    registerProjectMigrationHandlers();
  });

  it('returns once started, then broadcasts progress and the result', async () => {
    mocks.service.validateMove.mockResolvedValue({ canMove: true });
    let finish!: (result: unknown) => void;
    mocks.service.moveProject.mockImplementation((_old: string, _new: string, onProgress: (phase: string) => void) => {
      onProgress('moving');
      return new Promise((resolve) => { finish = resolve; });
    });

    const started = await mocks.handlers.get('project:move')!({}, '/a/proj', '/b/proj');
    expect(started).toEqual({ started: true });
    expect(mocks.send).toHaveBeenLastCalledWith('project:move-progress', expect.objectContaining({ status: 'running', phase: 'moving' }));

    finish({ success: true, newPath: '/b/proj', warnings: ['relink failed'] });
    await vi.waitFor(() =>
      expect(mocks.send).toHaveBeenLastCalledWith('project:move-progress', expect.objectContaining({ status: 'succeeded', warnings: ['relink failed'] })),
    );
    expect(await mocks.handlers.get('project:move-jobs')!({})).toEqual([
      expect.objectContaining({ oldPath: '/a/proj', newPath: '/b/proj', status: 'succeeded' }),
    ]);
  });

  it('reports a precondition failure without starting a move', async () => {
    mocks.service.validateMove.mockResolvedValue({ canMove: false, reason: 'Destination already exists' });
    mocks.service.moveProject.mockClear();

    expect(await mocks.handlers.get('project:move')!({}, '/a/proj', '/b/proj')).toEqual({ started: false, error: 'Destination already exists' });
    expect(mocks.service.moveProject).not.toHaveBeenCalled();
  });
});
