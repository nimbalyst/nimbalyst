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

  it('rotates generation when a new prompt is observed before the next CLI running poll', async () => {
    const listener = vi.fn<(event: SessionStateEvent) => void>();
    manager.subscribe(listener);
    await manager.startSession({
      sessionId: 'session-cli-prompt-race',
      workspacePath: '/workspace/project',
      attentionGeneration: 'turn-a',
    });
    await manager.updateActivity({
      sessionId: 'session-cli-prompt-race',
      status: 'idle',
      isStreaming: false,
      attentionGeneration: 'turn-a',
    });
    listener.mockClear();

    await manager.updateActivity({
      sessionId: 'session-cli-prompt-race',
      status: 'waiting_for_input',
      isStreaming: false,
    });

    const turnB = manager.getSessionState('session-cli-prompt-race')?.attentionGeneration;
    expect(turnB).toMatch(/^session-cli-prompt-race:/);
    expect(turnB).not.toBe('turn-a');
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({
      type: 'session:waiting',
      attentionGeneration: turnB,
    }));

    await manager.endSession('session-cli-prompt-race', { attentionGeneration: 'turn-a' });
    expect(manager.getSessionState('session-cli-prompt-race')).toMatchObject({
      status: 'waiting_for_input',
      attentionGeneration: turnB,
    });
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

  it('carries the turn generation into terminal events', async () => {
    const listener = vi.fn<(event: SessionStateEvent) => void>();
    manager.subscribe(listener);
    await manager.startSession({
      sessionId: 'session-generated',
      workspacePath: '/workspace/project',
      attentionGeneration: 'turn-a',
    } as any);
    listener.mockClear();

    await manager.endSession('session-generated', { attentionGeneration: 'turn-a' } as any);

    expect(listener).toHaveBeenCalledWith(expect.objectContaining({
      type: 'session:completed',
      attentionGeneration: 'turn-a',
    }));
  });

  it('returns the exact generation created for the authoritative turn start', async () => {
    const generated = await manager.startSession({
      sessionId: 'session-returned-generation',
      workspacePath: '/workspace/project',
    });

    expect(generated).toBe(
      manager.getSessionState('session-returned-generation')?.attentionGeneration,
    );
    expect(generated).toMatch(/^session-returned-generation:/);
  });

  it('ignores a stale terminal generation after a newer turn starts', async () => {
    const listener = vi.fn<(event: SessionStateEvent) => void>();
    manager.subscribe(listener);
    await manager.startSession({
      sessionId: 'session-race',
      workspacePath: '/workspace/project',
      attentionGeneration: 'turn-b',
    } as any);
    listener.mockClear();

    await manager.endSession('session-race', { attentionGeneration: 'turn-a' } as any);

    expect(manager.getSessionState('session-race')).toMatchObject({
      attentionGeneration: 'turn-b',
      status: 'running',
    });
    expect(listener).not.toHaveBeenCalledWith(expect.objectContaining({
      type: 'session:completed',
    }));
  });

  it('ignores a stale error generation after a newer turn starts', async () => {
    const listener = vi.fn<(event: SessionStateEvent) => void>();
    manager.subscribe(listener);
    await manager.startSession({
      sessionId: 'session-error-race',
      workspacePath: '/workspace/project',
      attentionGeneration: 'turn-b',
    });
    listener.mockClear();

    await manager.updateActivity({
      sessionId: 'session-error-race',
      status: 'error',
      attentionGeneration: 'turn-a',
    });

    expect(manager.getSessionState('session-error-race')).toMatchObject({
      attentionGeneration: 'turn-b',
      status: 'running',
    });
    expect(listener).not.toHaveBeenCalledWith(expect.objectContaining({
      type: 'session:error',
    }));
  });
});
