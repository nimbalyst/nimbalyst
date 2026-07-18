import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  updateMetadata: vi.fn(),
}));

vi.mock('@nimbalyst/runtime', () => ({
  AISessionsRepository: {
    get: mocks.get,
    updateMetadata: mocks.updateMetadata,
  },
}));

import {
  ATTENTION_SUPERVISOR_METADATA_KEY,
  assertBoundWindowCanMutateAttentionSupervisors,
  isAuthorizedAttentionSupervisor,
  setAttentionSupervisorAuthorization,
} from '../AttentionSupervisorAuthorization';
import * as attentionSupervisorAuthorization from '../AttentionSupervisorAuthorization';

const WORKSPACE = '/workspace';

describe('AttentionSupervisorAuthorization', () => {
  let sessions: Map<string, any>;

  beforeEach(() => {
    vi.clearAllMocks();
    sessions = new Map([
      ['target', { id: 'target', workspacePath: WORKSPACE, metadata: {} }],
      ['watcher', { id: 'watcher', workspacePath: WORKSPACE, metadata: {} }],
      ['sibling', { id: 'sibling', workspacePath: WORKSPACE, metadata: {} }],
      ['elsewhere', { id: 'elsewhere', workspacePath: '/other', metadata: {} }],
    ]);
    mocks.get.mockImplementation(async (sessionId: string) => sessions.get(sessionId) ?? null);
    mocks.updateMetadata.mockImplementation(async (sessionId: string, update: any) => {
      const session = sessions.get(sessionId);
      session.metadata = { ...session.metadata, ...update.metadata };
    });
  });

  it('durably grants and revokes one explicit target-to-supervisor relationship', async () => {
    await setAttentionSupervisorAuthorization({
      workspacePath: WORKSPACE,
      targetSessionId: 'target',
      supervisorSessionId: 'watcher',
      authorized: true,
    });
    expect(sessions.get('target').metadata[ATTENTION_SUPERVISOR_METADATA_KEY]).toEqual(['watcher']);
    expect(isAuthorizedAttentionSupervisor(sessions.get('target').metadata, 'watcher')).toBe(true);
    expect(isAuthorizedAttentionSupervisor(sessions.get('target').metadata, 'sibling')).toBe(false);

    await setAttentionSupervisorAuthorization({
      workspacePath: WORKSPACE,
      targetSessionId: 'target',
      supervisorSessionId: 'watcher',
      authorized: false,
    });
    expect(sessions.get('target').metadata[ATTENTION_SUPERVISOR_METADATA_KEY]).toEqual([]);
    expect(isAuthorizedAttentionSupervisor(sessions.get('target').metadata, 'watcher')).toBe(false);
  });

  it('rejects invalid, self, and cross-workspace grants', async () => {
    await expect(setAttentionSupervisorAuthorization({
      workspacePath: WORKSPACE,
      targetSessionId: 'target',
      supervisorSessionId: 'missing',
      authorized: true,
    })).rejects.toThrow('not found');
    await expect(setAttentionSupervisorAuthorization({
      workspacePath: WORKSPACE,
      targetSessionId: 'target',
      supervisorSessionId: 'target',
      authorized: true,
    })).rejects.toThrow('cannot supervise itself');
    await expect(setAttentionSupervisorAuthorization({
      workspacePath: WORKSPACE,
      targetSessionId: 'target',
      supervisorSessionId: 'elsewhere',
      authorized: true,
    })).rejects.toThrow('not found');
    expect(mocks.updateMetadata).not.toHaveBeenCalled();
  });

  it('allows only a renderer window already bound to the explicit workspace', () => {
    expect(() => assertBoundWindowCanMutateAttentionSupervisors({
      workspacePath: WORKSPACE,
      mode: 'agentic-coding',
    } as any, WORKSPACE)).not.toThrow();
    expect(() => assertBoundWindowCanMutateAttentionSupervisors({
      workspacePath: '/other',
      mode: 'agentic-coding',
    } as any, WORKSPACE)).toThrow('not authorized');
    expect(() => assertBoundWindowCanMutateAttentionSupervisors(undefined, WORKSPACE))
      .toThrow('not authorized');
  });

  it('requires an affirmative user decision before the renderer route may mutate authority', async () => {
    const guardedMutation = (
      attentionSupervisorAuthorization as typeof attentionSupervisorAuthorization & {
        setAttentionSupervisorAuthorizationWithUserConfirmation?: (
          args: {
            workspacePath: string;
            targetSessionId: string;
            supervisorSessionId: string;
            authorized: boolean;
          },
          confirm: (request: unknown) => Promise<boolean>,
        ) => Promise<unknown>;
      }
    ).setAttentionSupervisorAuthorizationWithUserConfirmation;
    expect(typeof guardedMutation).toBe('function');

    const rejectedConfirmation = vi.fn(async () => false);
    await expect(guardedMutation?.({
      workspacePath: WORKSPACE,
      targetSessionId: 'target',
      supervisorSessionId: 'watcher',
      authorized: true,
    }, rejectedConfirmation)).rejects.toThrow('not confirmed by the user');
    expect(mocks.updateMetadata).not.toHaveBeenCalled();

    const acceptedConfirmation = vi.fn(async () => true);
    await expect(guardedMutation?.({
      workspacePath: WORKSPACE,
      targetSessionId: 'target',
      supervisorSessionId: 'watcher',
      authorized: true,
    }, acceptedConfirmation)).resolves.toMatchObject({ authorized: true });
    expect(acceptedConfirmation).toHaveBeenCalledWith({
      action: 'authorize',
      targetSessionId: 'target',
      supervisorSessionId: 'watcher',
    });
    expect(sessions.get('target').metadata[ATTENTION_SUPERVISOR_METADATA_KEY]).toEqual(['watcher']);
  });
});
