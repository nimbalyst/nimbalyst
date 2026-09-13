/**
 * The `serve` decision layer: what to do when a request, an index broadcast or
 * a control message arrives.
 *
 * Everything it touches is injected -- the sync provider, git, the session
 * factory, the turn runner, the clock. That is not test decoration: the desktop
 * responder this replaces (`MobileSyncHandler`) is welded to BrowserWindow
 * lookups and could only ever be exercised against a live Electron app, which
 * is why its request-routing bugs were only ever found by hand. This one runs
 * end to end in a unit test with no socket, no git and no `claude` binary.
 *
 * Two rules that are easy to get backwards:
 *
 *  - The session's published `projectId` is the REQUESTER's workspace path, not
 *    this node's checkout directory. The desktop groups sessions by that value;
 *    publishing `/workspace/repo` would file every remote session under a
 *    project the user does not have. The checkout directory is the agent's cwd
 *    and nothing else.
 *  - git only runs when the session is created. A queued follow-up turn reuses
 *    the tree as the previous turn left it -- `checkout -B <branch> FETCH_HEAD`
 *    before every turn would silently discard the agent's uncommitted work.
 */

import type {
  EncryptedAttachment,
  CreateSessionRequest,
  CreateSessionResponse,
  SessionChange,
  SessionControlMessage,
  SyncedQueuedPrompt,
} from '@nimbalyst/runtime/sync/types';
import type { Logger } from './log.js';
import type { QueuedPromptStore } from './queuedPrompts.js';
import { findWorkspace, type WorkspaceMapping } from './workspaces.js';
import type { CheckoutOutcome } from './repoCheckout.js';

/** The slice of `SyncProvider` this runtime actually uses. */
export interface ServeSyncProvider {
  sendSessionControlMessage?(message: SessionControlMessage): Promise<void>;
  pushChange(sessionId: string, change: SessionChange): void | Promise<unknown>;
  sendCreateSessionResponse?(response: CreateSessionResponse): Promise<void>;
}

export interface CreateSessionInput {
  /** The REQUESTER's workspace path. Becomes the session's `workspaceId`. */
  projectId: string;
  provider: string;
  model?: string;
  sessionType?: string;
  agentRole?: string;
  parentSessionId?: string;
  hostDeviceId: string;
}

export interface CreatedSession {
  id: string;
}

/** A handle on the turn currently streaming, so a `cancel` can reach it. */
export interface TurnControl {
  cancel(): Promise<void>;
}

export interface RunTurnInput {
  sessionId: string;
  /** The agent's cwd: this node's checkout, NOT the requester's project path. */
  workspacePath: string;
  prompt: string;
  attachments?: EncryptedAttachment[];
  options?: import("@nimbalyst/runtime/sync/types").RemoteTurnOptions;
  onTurnStarted(control: TurnControl): void;
}

export interface ServeRuntimeDeps {
  /** This node's announced device id; targeted requests carry it. */
  deviceId: string;
  sync: ServeSyncProvider;
  /** Re-read per request so the desktop can map a new project without a restart. */
  loadWorkspaces(): WorkspaceMapping[];
  ensureCheckout(mapping: WorkspaceMapping): Promise<CheckoutOutcome>;
  /**
   * The canonical checkout directory for a mapping, or a throw if it is not
   * confined to the configured root.
   *
   * Applied on EVERY path that produces a working directory, including queued
   * follow-up turns, which run no git at all. The workspaces file is re-read
   * from disk on every request, so a mapping that was safe when the session was
   * created is not necessarily the mapping in force when its next prompt runs.
   */
  confineCheckout(mapping: WorkspaceMapping): string;
  createSession(input: CreateSessionInput): Promise<CreatedSession>;
  /** The session's `workspaceId`, or null when this node does not host it. */
  getSessionProjectId(sessionId: string): Promise<string | null>;
  workspaceContext?(workspacePath: string): Promise<Record<string, unknown>>;
  runTurn(input: RunTurnInput): Promise<{ error?: string }>;
  queue: QueuedPromptStore;
  log: Logger;
  now?: () => number;

  /**
   * Monotonic counter that changes whenever the index socket is replaced.
   *
   * The server binds a create-session claim to the SOCKET that received the
   * broadcast. A reconnect between claiming and answering (the twelve-minute
   * credential rotation is the common one) means our response goes out on a
   * socket the server does not associate with the claim: it rejects the
   * response and tells the requester the host vanished -- while we happily run
   * the prompt anyway, producing a turn nobody is listening to.
   */
  connectionGeneration(): number;

  /**
   * Wait for transcript rows to reach the session room. Returns the number
   * still unpublished when the bound expired.
   */
  flushTranscripts?(timeoutMs?: number): Promise<number>;

  /** Preparation failures must be visible even when no provider was started. */
  noteFailed?(sessionId: string, prompt: string, error: string): Promise<void>;

  /** Record that an interrupted turn was abandoned, in the session's own transcript. */
  noteInterrupted?(sessionId: string, prompt: string): Promise<void>;
}

/** The `queuedPrompts` shape as it arrives on an index entry. */
export interface IndexEntryQueue {
  queuedPrompts?: SyncedQueuedPrompt[];
}

export interface ServeRuntime {
  handleCreateSessionRequest(request: CreateSessionRequest): Promise<void>;
  handleIndexChange(sessionId: string, entry: IndexEntryQueue): Promise<void>;
  handleSessionControlMessage(message: SessionControlMessage): Promise<void>;
  /**
   * Resolve work the previous process left behind: pending rows are driven,
   * rows interrupted mid-execution are failed rather than replayed.
   */
  recoverPersistedQueue(): Promise<void>;
  /** Refuse new work. Already-running turns keep going. */
  stopIntake(): void;
  /** Interrupt every streaming turn. */
  cancelAll(): Promise<void>;
  /** Resolves once every in-flight drain has settled and transcripts are flushed. */
  idle(): Promise<void>;
}

const DEFAULT_PROVIDER = 'claude-code';

/**
 * The queue id an initial prompt is recorded under.
 *
 * De-duplication is by IDENTITY and nothing else. An earlier version matched a
 * queued prompt against the request's text within sixty seconds, which is wrong
 * in both directions: a copy that arrives late runs a second time, and a user
 * who deliberately sends the same prompt twice in a minute gets silently
 * ignored. Text is not identity and a clock is not a fact about the submission.
 *
 * The initial prompt is written here as `completed` when the session is created,
 * so a queued row carrying this id is skipped forever, and every other id runs.
 */
function initialSubmissionId(requestId: string): string {
  return `request:${requestId}`;
}

export function createServeRuntime(deps: ServeRuntimeDeps): ServeRuntime {
  const now = deps.now ?? Date.now;

  /**
   * Requests are re-delivered: a reconnect replays the broadcast, and the phone
   * retries a request whose response it missed. Creating a second session and a
   * second checkout for one requestId is the visible failure.
   */
  const handledRequests = new Set<string>();
  const activeTurns = new Map<string, TurnControl>();
  const drains = new Map<string, Promise<void>>();
  let intakeStopped = false;

  async function respond(response: CreateSessionResponse): Promise<void> {
    if (!deps.sync.sendCreateSessionResponse) return;
    try {
      // Only the socket that received the broadcast may answer it, which is why
      // this goes back through the same provider rather than any other lane.
      await deps.sync.sendCreateSessionResponse(response);
    } catch (error) {
      deps.log('response-send-failed', {
        requestId: response.requestId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async function refuse(requestId: string, reason: string): Promise<void> {
    deps.log('request-refused', { requestId, reason });
    await respond({ requestId, success: false, error: reason });
  }

  function publishQueue(sessionId: string): void {
    const pending: SyncedQueuedPrompt[] = deps.queue.listPending(sessionId).map((row) => ({
      id: row.id,
      prompt: row.prompt,
      timestamp: row.createdAt,
      ...(row.attachments?.length ? { attachments: row.attachments } : {}),
      ...(row.options ? {options: row.options} : {}),
    }));

    // No `updatedAt`: draining a queue is not new content and must not resort
    // the session list on every other device.
    try {
      deps.sync.pushChange(sessionId, {
        type: 'metadata_updated',
        metadata: { queuedPrompts: pending },
      });
    } catch (error) {
      deps.log('queue-publish-failed', {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async function publishExecution(sessionId: string, isExecuting: boolean): Promise<void> {
    try {
      const outcome = await deps.sync.pushChange(sessionId, { type: 'metadata_updated', metadata: { isExecuting } });
      if (outcome && typeof outcome === 'object' && 'published' in outcome && !outcome.published) {
        deps.log('execution-state-not-published', { sessionId, isExecuting });
      }
    } catch {
      deps.log('execution-state-not-published', { sessionId, isExecuting });
    }
  }

  async function runOne(
    sessionId: string,
    row: { id: string; prompt: string; attachments?: EncryptedAttachment[]; options?: import("@nimbalyst/runtime/sync/types").RemoteTurnOptions },
    workspacePath: string,
    /** False for the initial prompt, which has no queue row to transition. */
    queued = true,
  ): Promise<void> {
    deps.log('turn-started', { sessionId, promptId: row.id });
    await publishExecution(sessionId, true);
    try {
      const result = await deps.runTurn({
        sessionId,
        workspacePath,
        prompt: row.prompt,
        attachments: row.attachments,
        options: row.options,
        onTurnStarted: (control) => activeTurns.set(sessionId, control),
      });
      if (result.error) {
        if (queued) deps.queue.fail(row.id, result.error);
        deps.log('turn-finished', { sessionId, promptId: row.id, error: result.error });
      } else {
        if (queued) deps.queue.complete(row.id);
        deps.log('turn-finished', { sessionId, promptId: row.id });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (queued) deps.queue.fail(row.id, message);
      deps.log('turn-failed', { sessionId, promptId: row.id, error: message });
      await deps.noteFailed?.(sessionId, row.prompt, message);
    } finally {
      activeTurns.delete(sessionId);
      await publishExecution(sessionId, false);
    }
  }

  /**
   * The checkout directory for a session this node hosts, or null.
   *
   * Resolved per drain, never re-fetched: the checkout was cloned (and last
   * fetched) when the session was created, and re-running git between queued
   * turns would throw away work the agent has not committed yet.
   */
  async function resolveWorkspacePath(sessionId: string): Promise<string | null> {
    const projectId = await deps.getSessionProjectId(sessionId);
    if (!projectId) {
      deps.log('drain-skipped', { sessionId, reason: 'session not hosted here' });
      return null;
    }

    try {
      const mapping = findWorkspace(deps.loadWorkspaces(), projectId);
      if (!mapping) {
        deps.log('drain-skipped', { sessionId, reason: `no workspace mapping for ${projectId}` });
        return null;
      }
      // Re-confined here, not trusted from the create path. This mapping was
      // read from disk just now and may not be the one the session was created
      // against; an unvalidated `checkoutDir` becomes the agent's cwd, and the
      // agent runs with the OS user's permissions.
      return deps.confineCheckout(mapping);
    } catch (error) {
      deps.log('drain-skipped', {
        sessionId,
        reason: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  async function drainSession(sessionId: string): Promise<void> {
    const workspacePath = await resolveWorkspacePath(sessionId);
    if (!workspacePath) return;

    for (;;) {
      if (intakeStopped) {
        deps.log('drain-stopped', { sessionId, reason: 'shutting down' });
        return;
      }
      const pending = deps.queue.listPending(sessionId);
      if (pending.length === 0) break;

      const row = pending[0];
      // A lost claim means someone else owns the row. Continuing would spin on
      // the same head of the queue forever.
      if (!deps.queue.claim(row.id)) break;

      await runOne(sessionId, row, workspacePath);
      publishQueue(sessionId);
    }
  }

  /**
   * Serialize per session: two turns in one session would interleave, and they
   * share one checkout directory.
   */
  function schedule(sessionId: string, task: () => Promise<void>): Promise<void> {
    const previous = drains.get(sessionId) ?? Promise.resolve();
    const next = previous
      .catch(() => {})
      .then(task)
      .catch((error: unknown) => {
        deps.log('drain-failed', {
          sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        if (drains.get(sessionId) === next) drains.delete(sessionId);
      });
    drains.set(sessionId, next);
    return next;
  }

  function drive(sessionId: string): Promise<void> {
    return schedule(sessionId, () => drainSession(sessionId));
  }

  /**
   * Run the prompt that arrived inside a create-session request.
   *
   * Deliberately NOT drained through the queue: it is recorded there as already
   * completed (so nothing can replay it) and then run directly. Executing it as
   * a pending row would mean a claim, a status transition and a queue
   * publication for work that was never queued.
   */
  function runInitialPrompt(
    sessionId: string,
    prompt: string,
    workspacePath: string,
    submissionId: string,
  ): Promise<void> {
    return schedule(sessionId, async () => {
      if (intakeStopped) return;
      // `queued: false` -- the row is already recorded as completed, and a turn
      // that fails must not flip it back to something a replay could pick up.
      await runOne(sessionId, { id: submissionId, prompt }, workspacePath, false);
    });
  }

  return {
    async handleCreateSessionRequest(request: CreateSessionRequest): Promise<void> {
      // CollabV3Sync already filters targeted broadcasts, but a request that
      // reaches the wrong host creates a session on a machine the user never
      // chose, so the check is repeated where the consequence lives.
      if (request.targetDeviceId !== undefined && request.targetDeviceId !== deps.deviceId) {
        return;
      }
      if (intakeStopped) {
        deps.log('request-refused', { requestId: request.requestId, reason: 'node is shutting down' });
        return;
      }
      if (handledRequests.has(request.requestId)) {
        deps.log('request-duplicate', { requestId: request.requestId });
        return;
      }
      handledRequests.add(request.requestId);

      // The socket that received this broadcast is the only one the server will
      // accept an answer on, so every later check compares against the
      // generation as of RECEIPT.
      //
      // `receiptGeneration` is stamped by the provider before it decrypts the
      // request, and that distinction is the whole point: decryption is
      // asynchronous, so a disconnect during it delivers a request whose claim
      // is already gone -- and reading the generation here would read the new
      // socket's and conclude the claim was still ours. Sampling on delivery is
      // only the fallback for a provider that does not report receipt.
      const claimedGeneration = request.receiptGeneration ?? deps.connectionGeneration();

      /**
       * Give up on a claim the server no longer associates with us.
       *
       * `forget` un-marks the requestId as handled, which is right exactly while
       * nothing has been created yet: the requester will re-send, and a
       * duplicate-suppressed retry would leave it waiting forever. Once the
       * session exists the opposite is true -- handling it again would create a
       * second one -- so those callers keep the id.
       */
      function claimLost(when: string, forget: boolean): boolean {
        if (deps.connectionGeneration() === claimedGeneration) return false;
        if (forget) handledRequests.delete(request.requestId);
        deps.log('claim-abandoned', {
          requestId: request.requestId,
          when,
          reason: 'the index socket was replaced; the server no longer associates this claim with us',
        });
        return true;
      }

      // Before anything else: the provider decrypts a broadcast asynchronously,
      // so the socket can already be gone by the time this runs.
      if (claimLost('the request was decrypted', true)) return;

      if (request.provider && request.provider !== DEFAULT_PROVIDER) {
        await refuse(request.requestId, 'This machine currently supports Claude Code sessions.');
        return;
      }
      if (request.parentSessionId && await deps.getSessionProjectId(request.parentSessionId) !== request.projectId) {
        await refuse(request.requestId, 'The parent session is not hosted in this workspace on this machine.');
        return;
      }

      if (!request.projectId || request.projectId === 'unknown' || request.projectId === 'default') {
        // 'unknown' is what CollabV3Sync substitutes when the encrypted
        // projectId could not be decrypted -- a key mismatch, not a mapping gap.
        await refuse(
          request.requestId,
          `projectId is required and could not be read (got "${request.projectId}")`,
        );
        return;
      }

      let mapping: WorkspaceMapping | undefined;
      try {
        mapping = findWorkspace(deps.loadWorkspaces(), request.projectId);
      } catch (error) {
        await refuse(
          request.requestId,
          error instanceof Error ? error.message : String(error),
        );
        return;
      }

      if (!mapping) {
        await refuse(
          request.requestId,
          `no workspace mapping for project ${request.projectId}. `
          + 'Add it to the node\'s workspaces file.',
        );
        return;
      }

      deps.log('request-claimed', {
        requestId: request.requestId,
        projectId: request.projectId,
        checkoutDir: mapping.checkoutDir,
      });

      // The canonical, confined path -- the same value the drain path resolves
      // for a follow-up turn, so both run the agent in exactly one place.
      let checkoutDir: string;
      try {
        checkoutDir = deps.confineCheckout(mapping);
        const outcome = await deps.ensureCheckout(mapping);
        deps.log('checkout-ready', {
          checkoutDir,
          branch: mapping.branch,
          outcome,
        });
      } catch (error) {
        await refuse(
          request.requestId,
          `checkout failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        return;
      }

      // Checked before the session exists: the server has already reported
      // host-vanished to the requester, who will have re-sent to whoever is
      // available. Creating a session and running a turn now produces a second
      // agent working the same checkout with nobody watching.
      if (claimLost('the checkout finished', true)) return;

      let session: CreatedSession;
      try {
        session = await deps.createSession({
          // The requester's path, deliberately. See the header.
          projectId: request.projectId,
          provider: request.provider || DEFAULT_PROVIDER,
          model: request.model,
          sessionType: request.sessionType,
          agentRole: request.agentRole,
          parentSessionId: request.parentSessionId,
          hostDeviceId: deps.deviceId,
        });
      } catch (error) {
        await refuse(
          request.requestId,
          `session creation failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        return;
      }

      deps.log('session-created', {
        requestId: request.requestId,
        sessionId: session.id,
        projectId: request.projectId,
      });

      // Re-checked immediately before the answer goes out. `createSession`
      // writes to the database and publishes an index entry, which is long
      // enough for the twelve-minute rotation to land in the middle of it. A
      // response on a socket that does not hold the claim is rejected by the
      // server and the requester is told the host vanished -- so running the
      // prompt after that produces a turn nobody is listening to.
      if (claimLost('the session was created', false)) return;

      // Answer before running anything. The requester is waiting on this to
      // open the session; a turn can take minutes and the request would time
      // out and be retried, creating a second session for the same ask.
      await respond({ requestId: request.requestId, success: true, sessionId: session.id });

      if (request.initialPrompt) {
        // Durable de-duplication, and the ONLY kind: recorded as completed under
        // an id derived from the requestId, so a queued copy carrying that id is
        // skipped forever -- no text comparison, no window. See
        // `initialSubmissionId`.
        const submissionId = initialSubmissionId(request.requestId);
        if (deps.queue.offer({
          id: submissionId,
          sessionId: session.id,
          prompt: request.initialPrompt,
          createdAt: now(),
        })) {
          deps.queue.complete(submissionId);
        }

        // Last check before work starts. Everything above is recoverable; a turn
        // is not, and this one would be running against a claim we no longer
        // hold.
        if (claimLost('the prompt was about to run', false)) return;

        void runInitialPrompt(session.id, request.initialPrompt, checkoutDir, submissionId);
      }
    },

    async handleIndexChange(sessionId: string, entry: IndexEntryQueue): Promise<void> {
      if (intakeStopped) return;
      const queued = entry.queuedPrompts;
      if (!queued || queued.length === 0) return;

      // Only for sessions this node hosts. Every index entry the user owns is
      // broadcast here, including ones running on their laptop.
      const projectId = await deps.getSessionProjectId(sessionId);
      if (!projectId) return;

      let accepted = 0;
      for (const prompt of queued) {
        if (!prompt?.id || typeof prompt.prompt !== 'string') continue;

        // Identity is the whole rule. A replayed id is already recorded --
        // whatever status it reached -- which is what stops a reconnect from
        // re-running the last prompt, and it is also what stops a queued copy of
        // the request's own initial prompt (recorded as completed under
        // `request:<requestId>`) from running a second time. Nothing here
        // compares text or clocks.
        if (deps.queue.offer({
          id: prompt.id,
          sessionId,
          prompt: prompt.prompt,
          createdAt: prompt.timestamp || now(),
          attachments: prompt.attachments,
          options: prompt.options,
        })) {
          accepted += 1;
        } else if (prompt.id.startsWith('request:')) {
          deps.log('initial-prompt-duplicate-skipped', {
            sessionId,
            promptId: prompt.id,
            note: 'the requester queued the prompt it already sent inside the request',
          });
        }
      }

      if (accepted === 0) return;
      deps.log('prompts-queued', { sessionId, count: accepted });
      void drive(sessionId);
    },

    async handleSessionControlMessage(message: SessionControlMessage): Promise<void> {
      if (message.targetDeviceId !== undefined && message.targetDeviceId !== deps.deviceId) {
        return;
      }

      if (message.type === 'workspace-context-request') {
        if (!message.sentByDeviceId || typeof message.payload?.requestId !== 'string' || !deps.workspaceContext) return;
        const workspace = await resolveWorkspacePath(message.sessionId);
        if (!workspace) return;
        try {
          const payload = await deps.workspaceContext(workspace);
          await deps.sync.sendSessionControlMessage?.({sessionId: message.sessionId, type: 'workspace-context-response', targetDeviceId: message.sentByDeviceId, sentByDeviceId: deps.deviceId, sentBy: 'desktop', timestamp: now(), payload: {...payload, requestId: message.payload.requestId}});
        } catch { deps.log('workspace-context-failed', {sessionId: message.sessionId}); }
        return;
      }
      switch (message.type) {
        case 'cancel': {
          const active = activeTurns.get(message.sessionId);
          if (!active) {
            deps.log('cancel-ignored', { sessionId: message.sessionId, reason: 'no active turn' });
            return;
          }
          deps.log('turn-cancelled', { sessionId: message.sessionId });
          try {
            await active.cancel();
          } catch (error) {
            deps.log('cancel-failed', {
              sessionId: message.sessionId,
              error: error instanceof Error ? error.message : String(error),
            });
          }
          return;
        }

        case 'prompt':
          // The prompt itself arrives through the index; this is only a nudge
          // to start draining now rather than on the next broadcast.
          void drive(message.sessionId);
          return;

        default:
          // Interactive prompts (AskUserQuestion, plan approval) are not
          // answerable from here yet. Log and keep serving -- crashing the node
          // because the phone asked something is far worse than not answering.
          deps.log('control-unsupported', {
            sessionId: message.sessionId,
            type: message.type,
          });
      }
    },

    async recoverPersistedQueue(): Promise<void> {
      // Rows left `executing` belong to a turn that no longer exists. They are
      // NOT replayed: a turn's side effects (files written, commands run,
      // commits made) are not once-only, so re-running one is not a retry, it
      // is a second, uncoordinated attempt. Fail them and say so in the
      // transcript, where the person waiting on the session will see it.
      const interrupted = deps.queue.failInterrupted();
      for (const row of interrupted) {
        deps.log('prompt-interrupted', {
          sessionId: row.sessionId,
          promptId: row.id,
          note: 'was executing when the previous process stopped; not replayed',
        });
        try {
          await deps.noteInterrupted?.(row.sessionId, row.prompt);
        } catch (error) {
          deps.log('interrupt-note-failed', {
            sessionId: row.sessionId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      // Pending rows never started, so they are safe to run. Without this a
      // restart strands them: nothing re-broadcasts a prompt the server already
      // considers delivered, and a later replay is deduplicated by its own id.
      const sessions = new Set([
        ...deps.queue.listPendingSessions(),
        ...interrupted.map((row) => row.sessionId),
      ]);

      for (const sessionId of sessions) {
        if (interrupted.some((row) => row.sessionId === sessionId)) {
          publishQueue(sessionId);
        }
        if (deps.queue.listPending(sessionId).length > 0) {
          deps.log('queue-recovered', {
            sessionId,
            pending: deps.queue.listPending(sessionId).length,
          });
          void drive(sessionId);
        }
      }
    },

    stopIntake(): void {
      intakeStopped = true;
    },

    async cancelAll(): Promise<void> {
      const active = [...activeTurns.entries()];
      if (active.length === 0) return;
      deps.log('cancelling-turns', { count: active.length });
      await Promise.allSettled(active.map(async ([sessionId, control]) => {
        try {
          await control.cancel();
        } catch (error) {
          deps.log('cancel-failed', {
            sessionId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }));
    },

    async idle(): Promise<void> {
      while (drains.size > 0) {
        await Promise.allSettled([...drains.values()]);
      }
      // A transcript row that is written locally but never published is a turn
      // the user cannot see from any device they own.
      const unflushed = await deps.flushTranscripts?.();
      if (unflushed) deps.log('transcript-unflushed', { rows: unflushed });
    },
  };
}
