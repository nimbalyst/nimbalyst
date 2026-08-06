import { beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'path';

// The three default-bound tools guarded here resolve arbitrary sessionIds.
// Without the workspace-binding check, a caller in workspace B could read
// (get_session_summary), schedule mutations against (schedule_wakeup), or
// directly mutate (update_session_board) a session belonging to workspace A.
const getMock = vi.fn();
const updateMetadataMock = vi.fn();

vi.mock('@nimbalyst/runtime', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    AISessionsRepository: {
      get: (...args: unknown[]) => getMock(...args),
      updateMetadata: (...args: unknown[]) => updateMetadataMock(...args),
      getMany: vi.fn(async () => []),
    },
  };
});

import { dispatchSessionContextTool } from '../sessionContextServer';

// Run through path.normalize so equality checks match resolveTargetWorkspaceBinding's
// own normalization on every OS (Windows converts '/' to '\', POSIX is a no-op).
const OWN_WS = path.normalize('/workspaces/own');
const FOREIGN_WS = path.normalize('/workspaces/foreign');

function foreignSession() {
  return {
    id: 'target-1',
    title: 'foreign session',
    workspacePath: FOREIGN_WS,
    metadata: {},
  };
}

beforeEach(() => {
  getMock.mockReset();
  updateMetadataMock.mockReset();
});

describe('sessionContextServer workspace binding', () => {
  it('get_session_summary reports a foreign-workspace session as not found', async () => {
    getMock.mockResolvedValue(foreignSession());

    const result = await dispatchSessionContextTool(
      'get_session_summary',
      { sessionId: 'target-1' },
      'caller-1',
      OWN_WS,
    );

    expect(result.content[0].text).toContain('not found');
  });

  it('schedule_wakeup refuses a foreign-workspace session', async () => {
    getMock.mockResolvedValue(foreignSession());

    const result = await dispatchSessionContextTool(
      'schedule_wakeup',
      { sessionId: 'target-1', delaySeconds: 60, prompt: 'x', reason: 'y' },
      'caller-1',
      OWN_WS,
    );

    expect(result.content[0].text).toContain('not found');
  });

  it('update_session_board refuses to mutate a foreign-workspace session', async () => {
    getMock.mockResolvedValue(foreignSession());

    const result = await dispatchSessionContextTool(
      'update_session_board',
      { sessionId: 'target-1', phase: 'complete' },
      'caller-1',
      OWN_WS,
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('not found');
    expect(updateMetadataMock).not.toHaveBeenCalled();
  });

  it('update_session_board still mutates a same-workspace session', async () => {
    getMock.mockResolvedValue({ ...foreignSession(), workspacePath: OWN_WS });
    updateMetadataMock.mockResolvedValue(undefined);

    const result = await dispatchSessionContextTool(
      'update_session_board',
      { sessionId: 'target-1', phase: 'complete' },
      'caller-1',
      OWN_WS,
    );

    expect(result.isError).toBe(false);
    expect(updateMetadataMock).toHaveBeenCalledTimes(1);
  });
});
