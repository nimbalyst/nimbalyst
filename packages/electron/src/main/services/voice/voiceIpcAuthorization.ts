/**
 * Who may drive the active voice conversation.
 *
 * Every `voice-mode:*` message that speaks, wakes, supersedes work, or answers
 * a question used to be accepted from any renderer on the strength of its
 * payload alone. `ipcMain.on` handlers looked only at whether *a* voice session
 * existed, then trusted the session id in the message and substituted the voice
 * owner's own workspace for whatever the caller left out. A stale or
 * compromised renderer could therefore announce a session it has no
 * relationship to, name a victim session id with a task id belonging to another
 * one, supersede running work with a non-finite revision, or wake the singleton
 * conversation with text of its choosing. None of those are payload-shape
 * problems, so validating shapes would not have closed any of them.
 *
 * The fix is to bind the five identities that must agree, and reject when they
 * do not:
 *
 *  1. **Caller.** Only the window that owns the conversation may drive it. The
 *     renderer already worked this way by convention -- `VoiceModeButton` keys
 *     its sends off a module-local voice session id that is only set in the
 *     window voice started in -- so this enforces an existing invariant rather
 *     than removing a capability.
 *  2. **Generation.** A conversation gets a fresh generation on every
 *     activation, and callers quote the one they were told. A message written
 *     against the previous conversation cannot land in the next one.
 *  3. **Workspace.** Named explicitly by the caller, per the workspace-scoped
 *     IPC rule, and checked against both the workspace the sender's own window
 *     is actually looking at and the workspace the conversation belongs to.
 *     Ambient substitution is what let a foreign workspace's content through.
 *  4. **Session.** The coding session must actually live in that workspace.
 *  5. **Task and revision.** A task id must belong to the claimed session, and
 *     a revision must be a finite, non-negative integer -- `Infinity` would
 *     supersede every task forever, and `NaN` compares false against
 *     everything.
 *
 * Pure on purpose. The decision is separated from the Electron event so it can
 * be tested directly; the caller resolves the facts and passes them in.
 */

/** Facts about the sender, resolved from the Electron event in main. */
export interface VoiceIpcCaller {
  webContentsId: number;
  /**
   * The workspace the sender's own window is looking at, resolved from window
   * state -- not from anything the renderer said.
   */
  resolvedWorkspacePath: string | null;
}

/** The conversation an authorized message may address. */
export interface VoiceConversationIdentity {
  /** Fresh per activation; quoted back by authorized callers. */
  generation: number;
  ownerWebContentsId: number;
  workspacePath: string | null;
}

/** What the caller says about itself. */
export interface VoiceIpcClaim {
  generation?: unknown;
  workspacePath?: unknown;
  sessionId?: unknown;
  taskId?: unknown;
  revision?: unknown;
  promptId?: unknown;
}

/** Which of the optional identities this channel requires. */
export interface VoiceIpcRequirements {
  sessionId?: boolean;
  promptId?: boolean;
  revision?: boolean;
}

export type VoiceIpcVerdict =
  | {
      allowed: true;
      workspacePath: string;
      sessionId: string | null;
      promptId: string | null;
      taskId: string | null;
      revision: number | null;
    }
  | { allowed: false; reason: string };

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0;

/**
 * A revision orders submissions, so it has to be comparable. `Infinity`
 * supersedes every task that will ever exist and `NaN` compares false against
 * all of them; neither is an ordering.
 */
export function isValidTaskRevision(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/**
 * Does this coding session belong to the workspace the conversation owns?
 *
 * A worktree session records the worktree as its workspace and the project it
 * was cut from separately, and voice legitimately speaks for those: the user
 * started them from this project. Anything else is another project's session.
 */
export function isSessionInWorkspace(
  session: { workspacePath?: string; worktreeProjectPath?: string } | null | undefined,
  workspacePath: string,
): boolean {
  if (!session) return false;
  return session.workspacePath === workspacePath || session.worktreeProjectPath === workspacePath;
}

/**
 * Everything decidable without touching the database. Session *membership* is
 * an async lookup, so it is checked separately by the caller against
 * `isSessionInWorkspace`; this establishes that there is an authorized caller
 * and a well-formed claim worth looking a session up for.
 */
export function authorizeVoiceIpc(input: {
  caller: VoiceIpcCaller;
  conversation: VoiceConversationIdentity | null;
  claim: VoiceIpcClaim;
  require?: VoiceIpcRequirements;
}): VoiceIpcVerdict {
  const { caller, conversation, claim } = input;
  const require = input.require ?? {};

  if (!conversation) return { allowed: false, reason: 'no active voice conversation' };

  if (caller.webContentsId !== conversation.ownerWebContentsId) {
    return {
      allowed: false,
      reason: `sender ${caller.webContentsId} does not own the voice conversation`,
    };
  }

  // A caller that cannot name the conversation it is addressing is either stale
  // or was never told, and both must fail closed rather than default to "the
  // current one".
  if (claim.generation !== conversation.generation) {
    return {
      allowed: false,
      reason: `generation ${String(claim.generation)} is not the active conversation (${conversation.generation})`,
    };
  }

  if (!isNonEmptyString(claim.workspacePath)) {
    return { allowed: false, reason: 'workspacePath is required' };
  }
  if (claim.workspacePath !== caller.resolvedWorkspacePath) {
    return { allowed: false, reason: "claimed workspace is not the sender's own workspace" };
  }
  if (claim.workspacePath !== conversation.workspacePath) {
    return { allowed: false, reason: "claimed workspace is not the voice conversation's workspace" };
  }

  let sessionId: string | null = null;
  if (require.sessionId || claim.sessionId !== undefined) {
    if (!isNonEmptyString(claim.sessionId)) return { allowed: false, reason: 'sessionId is required' };
    sessionId = claim.sessionId;
  }

  let promptId: string | null = null;
  if (require.promptId || claim.promptId !== undefined) {
    if (!isNonEmptyString(claim.promptId)) return { allowed: false, reason: 'promptId is required' };
    promptId = claim.promptId;
  }

  let revision: number | null = null;
  if (require.revision || claim.revision !== undefined) {
    if (!isValidTaskRevision(claim.revision)) {
      return { allowed: false, reason: `revision ${String(claim.revision)} is not an ordering` };
    }
    revision = claim.revision;
  }

  let taskId: string | null = null;
  if (claim.taskId !== undefined && claim.taskId !== null) {
    if (!isNonEmptyString(claim.taskId)) return { allowed: false, reason: 'taskId must be a string' };
    taskId = claim.taskId;
  }

  return { allowed: true, workspacePath: claim.workspacePath, sessionId, promptId, taskId, revision };
}
