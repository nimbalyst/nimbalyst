// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { authorizeVoiceIpc, isSessionInWorkspace } from '../voiceIpcAuthorization';

/**
 * The cases here are the exploits, not the shapes. Every one of them was
 * accepted when the handlers checked only that *a* voice session existed and
 * then trusted the ids in the payload.
 */
const conversation = { generation: 3, ownerWebContentsId: 11, workspacePath: '/ws' };
const owner = { webContentsId: 11, resolvedWorkspacePath: '/ws' };

const authorize = (
  caller: { webContentsId: number; resolvedWorkspacePath: string | null },
  claim: Record<string, unknown>,
  require?: { sessionId?: boolean; promptId?: boolean; revision?: boolean },
) => authorizeVoiceIpc({ caller, conversation, claim, require });

describe('authorizeVoiceIpc', () => {
  it('accepts the owning window naming this conversation and its workspace', () => {
    const verdict = authorize(owner, {
      generation: 3,
      workspacePath: '/ws',
      sessionId: 'session-a',
      revision: 2,
    });
    expect(verdict).toEqual({
      allowed: true,
      workspacePath: '/ws',
      sessionId: 'session-a',
      promptId: null,
      taskId: null,
      revision: 2,
    });
  });

  it('rejects a window that does not own the conversation', () => {
    // A second Nimbalyst window announcing a completion into someone else's
    // voice conversation.
    const verdict = authorize({ webContentsId: 99, resolvedWorkspacePath: '/ws' }, {
      generation: 3,
      workspacePath: '/ws',
      sessionId: 'session-a',
    });
    expect(verdict.allowed).toBe(false);
  });

  it('rejects a claim on a conversation that has already ended', () => {
    expect(authorize(owner, { generation: 2, workspacePath: '/ws' }).allowed).toBe(false);
    // And one that never learned a generation at all: "no generation" must not
    // mean "whichever conversation is current".
    expect(authorize(owner, { workspacePath: '/ws' }).allowed).toBe(false);
  });

  it('requires the workspace to be named, and to be the sender\'s own', () => {
    expect(authorize(owner, { generation: 3 }).allowed).toBe(false);
    // The caller names a workspace its own window is not looking at, which is
    // precisely what ambient substitution used to paper over.
    expect(
      authorize({ webContentsId: 11, resolvedWorkspacePath: '/other' }, {
        generation: 3,
        workspacePath: '/ws',
      }).allowed,
    ).toBe(false);
  });

  it('rejects a revision that is not an ordering', () => {
    // Infinity supersedes every task that will ever exist; NaN compares false
    // against all of them. Neither orders submissions.
    for (const revision of [Number.POSITIVE_INFINITY, Number.NaN, -1, 1.5, '2']) {
      expect(
        authorize(owner, { generation: 3, workspacePath: '/ws', sessionId: 's', revision }).allowed,
      ).toBe(false);
    }
  });

  it('rejects a missing session or prompt id when the channel needs one', () => {
    expect(authorize(owner, { generation: 3, workspacePath: '/ws' }, { sessionId: true }).allowed)
      .toBe(false);
    expect(
      authorize(owner, { generation: 3, workspacePath: '/ws', sessionId: 's' }, { promptId: true })
        .allowed,
    ).toBe(false);
  });
});

describe('isSessionInWorkspace', () => {
  it('accepts the workspace\'s own sessions and its worktree sessions', () => {
    expect(isSessionInWorkspace({ workspacePath: '/ws' }, '/ws')).toBe(true);
    // A worktree session records the worktree as its workspace; voice speaks
    // for it because the user cut it from this project.
    expect(
      isSessionInWorkspace({ workspacePath: '/ws/.worktrees/a', worktreeProjectPath: '/ws' }, '/ws'),
    ).toBe(true);
  });

  it('rejects another project\'s session, and an unknown one', () => {
    expect(isSessionInWorkspace({ workspacePath: '/other' }, '/ws')).toBe(false);
    expect(isSessionInWorkspace(null, '/ws')).toBe(false);
  });
});
