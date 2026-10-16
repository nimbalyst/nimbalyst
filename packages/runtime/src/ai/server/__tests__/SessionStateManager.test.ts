// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionStateManager } from '../SessionStateManager';
import type { SessionStateEvent } from '../types/SessionState';

class FakeDatabaseWorker {
  public queries: Array<{ sql: string; params?: any[] }> = [];
  private workspaceIds = new Map<string, string>();

  setWorkspace(sessionId: string, workspaceId: string): void {
    this.workspaceIds.set(sessionId, workspaceId);
  }

  async query<T = any>(sql: string, params?: any[]): Promise<{ rows: T[] }> {
    this.queries.push({ sql, params });

    if (sql.includes('SELECT workspace_id')) {
      const sessionId = params?.[0];
      const workspaceId = typeof sessionId === 'string' ? this.workspaceIds.get(sessionId) ?? null : null;
      return { rows: workspaceId ? [{ workspace_id: workspaceId } as T] : [] };
    }

    return { rows: [] };
  }
}

describe('SessionStateManager', () => {
  let manager: SessionStateManager;
  let database: FakeDatabaseWorker;

  beforeEach(() => {
    manager = new SessionStateManager();
    database = new FakeDatabaseWorker();
    manager.setDatabase(database);
  });

  it.each(['idle', 'error'] as const)('clears stale streaming on %s without losing the next turn', async (status) => {
    await manager.startSession({ sessionId: 's', workspacePath: '/workspace' });
    await manager.updateActivity({ sessionId: 's', status: 'running', isStreaming: true });
    await manager.updateActivity({ sessionId: 's', status });
    expect(manager.getRunningSessionIds()).not.toContain('s');
    expect(manager.getSessionState('s')?.isStreaming).toBe(false);
    await manager.updateActivity({ sessionId: 's', status: 'running', isStreaming: true });
    expect(manager.getRunningSessionIds()).toContain('s');
  });

  it.each(['idle', 'error'] as const)('does not let a delayed %s write stop a resumed turn', async (status) => {
    await manager.startSession({ sessionId: 's', workspacePath: '/workspace' });
    await manager.updateActivity({ sessionId: 's', status: 'running', isStreaming: true });
    let release!: () => void;
    vi.spyOn(database, 'query').mockImplementationOnce(() => new Promise(resolve => {
      release = () => resolve({ rows: [] });
    }));
    const listener = vi.fn();
    manager.subscribe(listener);
    const ending = manager.updateActivity({ sessionId: 's', status });
    await manager.updateActivity({ sessionId: 's', status: 'running', isStreaming: true });
    release();
    await ending;
    expect(manager.getRunningSessionIds()).toEqual(['s']);
    expect(listener).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'session:completed' }));
    expect(listener).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'session:error' }));
  });

  it('emits session:completed when ending an active session', async () => {
    const listener = vi.fn<(event: SessionStateEvent) => void>();
    manager.subscribe(listener);

    await manager.startSession({
      sessionId: 'session-active',
      workspacePath: '/workspace/project',
    });

    listener.mockClear();

    await manager.endSession('session-active');

    expect(listener).toHaveBeenCalledWith(expect.objectContaining({
      type: 'session:completed',
      sessionId: 'session-active',
      workspacePath: '/workspace/project',
    }));
  });

  it('emits session:completed when an active session goes idle (CLI turn boundary)', async () => {
    // NIM-806: the claude-code-cli PID watcher reports turn end via
    // updateActivity({status:'idle'}). The renderer only clears the running
    // indicator on session:completed/error/interrupted — a 'session:activity'
    // event leaves the session spinning forever. So idle must emit completed.
    const listener = vi.fn<(event: SessionStateEvent) => void>();
    manager.subscribe(listener);

    await manager.startSession({
      sessionId: 'session-cli',
      workspacePath: '/workspace/project',
      initialStatus: 'running',
    });

    listener.mockClear();

    await manager.updateActivity({ sessionId: 'session-cli', status: 'idle', isStreaming: false });

    expect(listener).toHaveBeenCalledWith(expect.objectContaining({
      type: 'session:completed',
      sessionId: 'session-cli',
    }));
    expect(listener).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'session:activity' }));

    // The session must stay active so the NEXT turn's running is still detected.
    expect(manager.isSessionActive('session-cli')).toBe(true);

    // A subsequent running->idle cycle still produces started then completed.
    listener.mockClear();
    await manager.updateActivity({ sessionId: 'session-cli', status: 'running', isStreaming: true });
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ type: 'session:streaming' }));
    listener.mockClear();
    await manager.updateActivity({ sessionId: 'session-cli', status: 'idle', isStreaming: false });
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ type: 'session:completed' }));
  });

  it('emits session:completed for sessions missing from active state', async () => {
    const listener = vi.fn<(event: SessionStateEvent) => void>();
    manager.subscribe(listener);
    database.setWorkspace('session-missing', '/workspace/project');

    await manager.endSession('session-missing');

    expect(listener).toHaveBeenCalledWith(expect.objectContaining({
      type: 'session:completed',
      sessionId: 'session-missing',
      workspacePath: '/workspace/project',
    }));
    expect(database.queries.some(({ sql }) => sql.includes('SELECT workspace_id'))).toBe(true);
    expect(database.queries.some(({ sql, params }) =>
      sql.includes('UPDATE ai_sessions SET status = $1') && params?.[0] === 'idle' && params?.[1] === 'session-missing'
    )).toBe(true);
  });
});
