// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import type { CreateSessionRequest, SessionControlMessage } from '@nimbalyst/runtime/sync/types';
import { createServeRuntime, type ServeRuntimeDeps } from '../serve/serveRuntime.js';
import type { PendingPrompt, QueuedPromptStore } from '../serve/queuedPrompts.js';
import type { WorkspaceMapping } from '../serve/workspaces.js';

const DEVICE_ID = 'sandbox-abc123';
const PROJECT_ID = '/Users/someone/sources/stravu-editor';
const CHECKOUT_DIR = '/workspace/stravu-editor';

const MAPPING: WorkspaceMapping = {
  projectId: PROJECT_ID,
  repoUrl: 'https://github.com/nimbalyst/nimbalyst.git',
  branch: 'main',
  checkoutDir: CHECKOUT_DIR,
};

/**
 * An in-memory stand-in for the SQLite queue with the same transition rules:
 * ids are remembered forever and a row is never removed, which is what makes a
 * replayed prompt a no-op instead of a re-run.
 */
function fakeQueue() {
  const rows = new Map<string, PendingPrompt & { status: string }>();
  return {
    statuses: new Map<string, string>(),
    offer(prompt) {
      if (rows.has(prompt.id)) return false;
      rows.set(prompt.id, { ...prompt, status: 'pending' });
      return true;
    },
    listPending(sessionId) {
      return [...rows.values()]
        .filter((row) => row.sessionId === sessionId && row.status === 'pending')
        .sort((a, b) => a.createdAt - b.createdAt)
        .map(({ status: _status, ...row }) => row);
    },
    claim(id) {
      const row = rows.get(id);
      if (!row || row.status !== 'pending') return false;
      row.status = 'executing';
      return true;
    },
    complete(id) {
      const row = rows.get(id);
      if (row) row.status = 'completed';
      this.statuses.set(id, 'completed');
    },
    fail(id, message) {
      const row = rows.get(id);
      if (row) row.status = 'failed';
      this.statuses.set(id, `failed:${message}`);
    },
    listPendingSessions() {
      return [...new Set(
        [...rows.values()].filter((row) => row.status === 'pending').map((row) => row.sessionId),
      )];
    },
    failInterrupted() {
      const interrupted = [...rows.values()].filter((row) => row.status === 'executing');
      for (const row of interrupted) {
        row.status = 'failed';
        this.statuses.set(row.id, 'failed:interrupted');
      }
      return interrupted.map(({ status: _status, ...row }) => row);
    },
    /** Test-only: seed a row in a given state, as a previous process would have left it. */
    seed(row: PendingPrompt, status: string) {
      rows.set(row.id, { ...row, status });
    },
  } as QueuedPromptStore & {
    statuses: Map<string, string>;
    seed(row: PendingPrompt, status: string): void;
  };
}

function makeRuntime(overrides: Partial<ServeRuntimeDeps> = {}) {
  const queue = overrides.queue ?? fakeQueue();
  const notes: Array<{ sessionId: string; prompt: string }> = [];
  let generation = 0;
  const responses: Array<{ requestId: string; success: boolean; sessionId?: string; error?: string }> = [];
  const pushes: Array<{ sessionId: string; change: unknown }> = [];
  const events: Array<{ event: string; fields?: Record<string, unknown> }> = [];
  const turns: Array<{ sessionId: string; workspacePath: string; prompt: string }> = [];
  const created: Array<Record<string, unknown>> = [];
  const sessionProjects = new Map<string, string>();

  const deps: ServeRuntimeDeps = {
    deviceId: DEVICE_ID,
    sync: {
      pushChange: (sessionId, change) => { pushes.push({ sessionId, change }); },
      sendCreateSessionResponse: async (response) => { responses.push(response); },
    },
    queue,
    log: (event, fields) => { events.push({ event, fields }); },
    loadWorkspaces: () => [MAPPING],
    ensureCheckout: vi.fn(async () => 'cloned' as const),
    confineCheckout: (mapping) => mapping.checkoutDir,
    createSession: vi.fn(async (input) => {
      created.push(input as unknown as Record<string, unknown>);
      const id = `session-${created.length}`;
      sessionProjects.set(id, input.projectId);
      return { id };
    }),
    getSessionProjectId: async (sessionId) => sessionProjects.get(sessionId) ?? null,
    runTurn: vi.fn(async (input) => {
      turns.push({
        sessionId: input.sessionId,
        workspacePath: input.workspacePath,
        prompt: input.prompt,
      });
      input.onTurnStarted({ cancel: async () => {} });
      return {};
    }),
    now: () => 1_700_000_000_000,
    connectionGeneration: () => generation,
    noteInterrupted: async (sessionId, prompt) => { notes.push({ sessionId, prompt }); },
    ...overrides,
  };

  return {
    runtime: createServeRuntime(deps),
    deps,
    queue,
    responses,
    pushes,
    events,
    turns,
    created,
    sessionProjects,
    notes,
    /** Simulate the index socket being replaced under us. */
    bumpGeneration: () => { generation += 1; },
  };
}

function request(overrides: Partial<CreateSessionRequest> = {}): CreateSessionRequest {
  return {
    requestId: 'req-1',
    projectId: PROJECT_ID,
    targetDeviceId: DEVICE_ID,
    timestamp: 1_700_000_000_000,
    ...overrides,
  };
}

describe('remote composer routing', () => {
  it('returns workspace context only for the targeted host and its owned session', async () => {
    const sendSessionControlMessage = vi.fn(async () => {});
    const workspaceContext = vi.fn(async () => ({encrypted: 'cipher', iv: 'nonce'}));
    const f = makeRuntime({workspaceContext, sync: {pushChange: vi.fn(), sendSessionControlMessage}});
    f.sessionProjects.set('owned', PROJECT_ID);
    const message: SessionControlMessage = {sessionId: 'owned', type: 'workspace-context-request', targetDeviceId: DEVICE_ID, sentByDeviceId: 'viewer', sentBy: 'desktop', timestamp: 1, payload: {requestId: 'request'}};
    await f.runtime.handleSessionControlMessage({...message, targetDeviceId: 'other'});
    await f.runtime.handleSessionControlMessage({...message, sessionId: 'foreign'});
    expect(workspaceContext).not.toHaveBeenCalled();
    await f.runtime.handleSessionControlMessage(message);
    expect(workspaceContext).toHaveBeenCalledWith(CHECKOUT_DIR);
    expect(sendSessionControlMessage).toHaveBeenCalledWith(expect.objectContaining({targetDeviceId: 'viewer', sentByDeviceId: DEVICE_ID, sessionId: 'owned', payload: {encrypted: 'cipher', iv: 'nonce', requestId: 'request'}}));
  });
  it('publishes preparation failures in the transcript and releases Working', async () => {
    const noteFailed = vi.fn(async () => {});
    const f = makeRuntime({noteFailed, runTurn: vi.fn(async () => {throw new Error('Attachment could not be decrypted');})});
    f.sessionProjects.set('owned', PROJECT_ID);
    await f.runtime.handleIndexChange('owned', {queuedPrompts: [{id: 'bad', prompt: 'Read image', timestamp: 1}]});
    await f.runtime.idle();
    expect(noteFailed).toHaveBeenCalledWith('owned', 'Read image', 'Attachment could not be decrypted');
    expect(f.pushes).toContainEqual({sessionId: 'owned', change: {type: 'metadata_updated', metadata: {isExecuting: false}}});
  });

  it('carries attachments/options to the owned turn without touching another host session', async () => {
    const runTurn = vi.fn(async () => ({}));
    const f = makeRuntime({runTurn});
    const attachment = {id: 'image', filename: 'image.png', mimeType: 'image/png', size: 4, encryptedData: 'cipher', iv: 'nonce'};
    await f.runtime.handleCreateSessionRequest({requestId: 'request', projectId: PROJECT_ID, targetDeviceId: DEVICE_ID, timestamp: 1});
    const queuedPrompts = [{id: 'with-image', prompt: 'Read it', timestamp: 2, attachments: [attachment], options: {mode: 'planning' as const}}];
    await f.runtime.handleIndexChange('not-owned', {queuedPrompts});
    await f.runtime.handleIndexChange('session-1', {queuedPrompts});
    await f.runtime.idle();
    expect(runTurn).toHaveBeenCalledTimes(1);
    expect(runTurn).toHaveBeenCalledWith(expect.objectContaining({sessionId: 'session-1', workspacePath: CHECKOUT_DIR, attachments: [attachment], options: {mode: 'planning'}}));
  });
});

describe('serve: create-session requests', () => {
  it('clones the mapped repo, hosts the session under the requester projectId, and runs the initial prompt', async () => {
    const harness = makeRuntime();
    await harness.runtime.handleCreateSessionRequest(
      request({ initialPrompt: 'summarize the README', model: 'claude-code:opus' }),
    );
    await harness.runtime.idle();

    expect(harness.deps.ensureCheckout).toHaveBeenCalledWith(MAPPING);

    // The session is filed under the REQUESTER's path so the desktop groups it
    // with that project; the checkout dir is only ever the agent's cwd.
    expect(harness.created).toEqual([
      expect.objectContaining({
        projectId: PROJECT_ID,
        provider: 'claude-code',
        model: 'claude-code:opus',
        hostDeviceId: DEVICE_ID,
      }),
    ]);
    expect(harness.turns).toEqual([
      { sessionId: 'session-1', workspacePath: CHECKOUT_DIR, prompt: 'summarize the README' },
    ]);

    expect(harness.responses).toEqual([
      { requestId: 'req-1', success: true, sessionId: 'session-1' },
    ]);
  });

  it('answers before the turn runs, so a slow turn cannot time the requester out', async () => {
    let released: () => void;
    const turnStarted = new Promise<void>((resolve) => { released = resolve; });
    const harness = makeRuntime({
      runTurn: async (input) => {
        input.onTurnStarted({ cancel: async () => {} });
        released();
        await new Promise((resolve) => setTimeout(resolve, 50));
        return {};
      },
    });

    await harness.runtime.handleCreateSessionRequest(request({ initialPrompt: 'go' }));
    await turnStarted;

    // Response already delivered while the turn is still streaming.
    expect(harness.responses).toEqual([
      { requestId: 'req-1', success: true, sessionId: 'session-1' },
    ]);
    await harness.runtime.idle();
  });

  it('refuses an unmapped projectId with the reason, and creates nothing', async () => {
    const harness = makeRuntime();
    await harness.runtime.handleCreateSessionRequest(
      request({ projectId: '/Users/someone/sources/other-repo' }),
    );

    expect(harness.responses).toEqual([
      {
        requestId: 'req-1',
        success: false,
        error: expect.stringContaining('no workspace mapping for project /Users/someone/sources/other-repo'),
      },
    ]);
    expect(harness.deps.createSession).not.toHaveBeenCalled();
    expect(harness.deps.ensureCheckout).not.toHaveBeenCalled();
  });

  it('refuses when the checkout fails rather than creating a session with no tree', async () => {
    const harness = makeRuntime({
      ensureCheckout: async () => { throw new Error('fatal: could not read Username'); },
    });
    await harness.runtime.handleCreateSessionRequest(request());

    expect(harness.responses[0]).toMatchObject({
      success: false,
      error: expect.stringContaining('fatal: could not read Username'),
    });
    expect(harness.deps.createSession).not.toHaveBeenCalled();
  });

  it('ignores a request targeted at another device and answers a redelivered one only once', async () => {
    const harness = makeRuntime();

    await harness.runtime.handleCreateSessionRequest(request({ targetDeviceId: 'someone-elses-laptop' }));
    expect(harness.responses).toEqual([]);
    expect(harness.deps.createSession).not.toHaveBeenCalled();

    await harness.runtime.handleCreateSessionRequest(request());
    await harness.runtime.handleCreateSessionRequest(request());
    await harness.runtime.idle();

    // A redelivered broadcast must not produce a second session or a second
    // checkout for the same requestId.
    expect(harness.deps.createSession).toHaveBeenCalledTimes(1);
    expect(harness.responses).toHaveLength(1);
  });

  it('refuses a request whose projectId could not be decrypted', async () => {
    const harness = makeRuntime();
    // CollabV3Sync substitutes 'unknown' when decryption fails -- a key
    // mismatch, which is not the same failure as a missing mapping.
    await harness.runtime.handleCreateSessionRequest(request({ projectId: 'unknown' }));

    expect(harness.responses[0]).toMatchObject({
      success: false,
      error: expect.stringContaining('could not be read'),
    });
  });
});

describe('serve: queued prompts', () => {
  it('runs each queued prompt exactly once across redelivery and republishes the remaining queue', async () => {
    const harness = makeRuntime();
    harness.sessionProjects.set('session-1', PROJECT_ID);

    const queued = [
      { id: 'p1', prompt: 'first', timestamp: 10 },
      { id: 'p2', prompt: 'second', timestamp: 20 },
    ];
    await harness.runtime.handleIndexChange('session-1', { queuedPrompts: queued });
    await harness.runtime.idle();

    // The same broadcast replays on every reconnect.
    await harness.runtime.handleIndexChange('session-1', { queuedPrompts: queued });
    await harness.runtime.idle();

    expect(harness.turns.map((turn) => turn.prompt)).toEqual(['first', 'second']);

    // Each drained prompt republishes what is left, ending at an empty queue so
    // the requester's "N queued" indicator clears.
    const published = harness.pushes.filter(push => 'queuedPrompts' in (push.change as { metadata: object }).metadata).map((push) => (push.change as {
      metadata: { queuedPrompts: Array<{ id: string }> };
    }).metadata.queuedPrompts.map((entry) => entry.id));
    expect(published).toEqual([['p2'], []]);
  });

  it('ignores queued prompts for a session this node does not host', async () => {
    const harness = makeRuntime();
    await harness.runtime.handleIndexChange('someone-elses-session', {
      queuedPrompts: [{ id: 'p1', prompt: 'first', timestamp: 10 }],
    });
    await harness.runtime.idle();

    expect(harness.turns).toEqual([]);
  });

  it('records a failed turn and keeps draining the rest of the queue', async () => {
    const queue = fakeQueue();
    const harness = makeRuntime({
      queue,
      runTurn: async (input) => {
        input.onTurnStarted({ cancel: async () => {} });
        return input.prompt === 'first' ? { error: 'provider exploded' } : {};
      },
    });
    harness.sessionProjects.set('session-1', PROJECT_ID);

    await harness.runtime.handleIndexChange('session-1', {
      queuedPrompts: [
        { id: 'p1', prompt: 'first', timestamp: 10 },
        { id: 'p2', prompt: 'second', timestamp: 20 },
      ],
    });
    await harness.runtime.idle();

    expect(queue.statuses.get('p1')).toBe('failed:provider exploded');
    expect(queue.statuses.get('p2')).toBe('completed');
  });
});

describe('serve: single submission path for the initial prompt', () => {
  it('runs the initial prompt directly, recorded as already satisfied', async () => {
    const queue = fakeQueue();
    const harness = makeRuntime({ queue });

    await harness.runtime.handleCreateSessionRequest(request({ initialPrompt: 'do the thing' }));
    await harness.runtime.idle();

    expect(harness.turns.map((turn) => turn.prompt)).toEqual(['do the thing']);
    // Never pending -- it is not drained, it is run. But it IS recorded, under
    // an id derived from the requestId, so a replayed copy has something
    // durable to collide with.
    expect(queue.listPendingSessions()).toEqual([]);
    expect(queue.statuses.get('request:req-1')).toBe('completed');
  });

  it('skips a queued copy carrying the submission id, however late it arrives', async () => {
    let clock = 1_700_000_000_000;
    const harness = makeRuntime({ now: () => clock });

    await harness.runtime.handleCreateSessionRequest(request({ initialPrompt: 'do the thing' }));
    await harness.runtime.idle();

    // An hour later -- far outside any window a heuristic would have used.
    // Identity does not expire.
    clock += 3_600_000;
    await harness.runtime.handleIndexChange('session-1', {
      queuedPrompts: [{ id: 'request:req-1', prompt: 'do the thing', timestamp: clock }],
    });
    await harness.runtime.idle();

    expect(harness.turns.map((turn) => turn.prompt)).toEqual(['do the thing']);
    expect(harness.events.map((entry) => entry.event)).toContain('initial-prompt-duplicate-skipped');
  });

  it('runs a deliberate repeat of the same words as its own submission', async () => {
    const harness = makeRuntime();

    await harness.runtime.handleCreateSessionRequest(request({ initialPrompt: 'again' }));
    await harness.runtime.idle();

    // The user meant it twice, seconds apart. A text-and-clock heuristic
    // swallowed this; identity does not -- a different id is a different ask.
    await harness.runtime.handleIndexChange('session-1', {
      queuedPrompts: [{ id: 'user-typed-again', prompt: 'again', timestamp: 1_700_000_001_000 }],
    });
    await harness.runtime.idle();

    expect(harness.turns.map((turn) => turn.prompt)).toEqual(['again', 'again']);
  });
});

describe('serve: claims are bound to the socket that received them', () => {
  it('abandons a claim when the index socket is replaced mid-clone', async () => {
    const harness = makeRuntime({
      ensureCheckout: async () => {
        // The twelve-minute credential rotation lands here.
        harness.bumpGeneration();
        return 'cloned' as const;
      },
    });

    await harness.runtime.handleCreateSessionRequest(request({ initialPrompt: 'go' }));
    await harness.runtime.idle();

    // The server already told the requester the host vanished. Answering and
    // running now produces a turn nobody is listening to.
    expect(harness.responses).toEqual([]);
    expect(harness.deps.createSession).not.toHaveBeenCalled();
    expect(harness.turns).toEqual([]);
    expect(harness.events.map((entry) => entry.event)).toContain('claim-abandoned');
  });

  it('binds to the generation at RECEIPT, not the one it sees on delivery', async () => {
    // The provider decrypts a broadcast asynchronously and the socket can go
    // away during that await. Sampling the generation here reads the NEW
    // socket's, so every later check compares new-against-new and passes --
    // the node runs a turn against a claim the server already released.
    const harness = makeRuntime();
    harness.bumpGeneration();

    await harness.runtime.handleCreateSessionRequest(
      request({ initialPrompt: 'go', receiptGeneration: 0 }),
    );
    await harness.runtime.idle();

    expect(harness.responses).toEqual([]);
    expect(harness.deps.createSession).not.toHaveBeenCalled();
    expect(harness.turns).toEqual([]);
    expect(harness.events.some((entry) => entry.event === 'claim-abandoned')).toBe(true);
  });

  it('lets the requester retry an abandoned claim that created nothing', async () => {
    // The requestId is only "handled" once something exists for it. Suppressing
    // a retry as a duplicate after abandoning the claim leaves the requester
    // waiting on a session nobody will ever create.
    const harness = makeRuntime();
    harness.bumpGeneration();

    await harness.runtime.handleCreateSessionRequest(
      request({ initialPrompt: 'go', receiptGeneration: 0 }),
    );
    await harness.runtime.idle();
    expect(harness.responses).toEqual([]);

    // Re-delivered on the socket that now holds the claim.
    await harness.runtime.handleCreateSessionRequest(
      request({ initialPrompt: 'go', receiptGeneration: 1 }),
    );
    await harness.runtime.idle();

    expect(harness.responses).toEqual([
      { requestId: 'req-1', success: true, sessionId: 'session-1' },
    ]);
    expect(harness.turns.map((turn) => turn.prompt)).toEqual(['go']);
  });

  it('abandons a claim when the socket is replaced during createSession', async () => {
    // The window the earlier check missed: `createSession` writes to the
    // database and publishes an index entry, and the rotation lands inside it.
    const harness = makeRuntime();
    harness.deps.createSession = async (input) => {
      harness.bumpGeneration();
      harness.sessionProjects.set('session-1', input.projectId);
      return { id: 'session-1' };
    };

    await harness.runtime.handleCreateSessionRequest(request({ initialPrompt: 'go' }));
    await harness.runtime.idle();

    // The session exists locally -- it cannot be un-created -- but the response
    // would be rejected by the server, so neither it nor the turn goes out.
    expect(harness.responses).toEqual([]);
    expect(harness.turns).toEqual([]);
    expect(harness.events.map((entry) => entry.event)).toContain('claim-abandoned');
  });
});

describe('serve: checkout confinement on every execution path', () => {
  it('refuses to run a queued turn in a checkout that is no longer confined', async () => {
    // The workspaces file is re-read from disk on every resolution, so the
    // mapping in force for a follow-up turn is not necessarily the one the
    // session was created against. A queued turn runs no git at all, so
    // `ensureCheckout`'s validation never sees this path.
    const harness = makeRuntime({
      confineCheckout: (mapping) => {
        if (mapping.checkoutDir !== CHECKOUT_DIR) {
          throw new Error(`invalid checkoutDir "${mapping.checkoutDir}": outside the checkout root`);
        }
        return mapping.checkoutDir;
      },
    });

    await harness.runtime.handleCreateSessionRequest(request());
    await harness.runtime.idle();

    harness.deps.loadWorkspaces = () => [{ ...MAPPING, checkoutDir: '/etc' }];
    await harness.runtime.handleIndexChange('session-1', {
      queuedPrompts: [{ id: 'q1', prompt: 'rm the thing', timestamp: 1 }],
    });
    await harness.runtime.idle();

    expect(harness.turns).toEqual([]);
    expect(harness.events.some((entry) => entry.event === 'drain-skipped')).toBe(true);
  });
});

describe('serve: restart recovery', () => {
  it('drives prompts the previous process left pending', async () => {
    const queue = fakeQueue();
    queue.seed({ id: 'p1', sessionId: 'session-1', prompt: 'unfinished', createdAt: 10 }, 'pending');

    const harness = makeRuntime({ queue });
    harness.sessionProjects.set('session-1', PROJECT_ID);

    await harness.runtime.recoverPersistedQueue();
    await harness.runtime.idle();

    // Nothing re-broadcasts a prompt the server considers delivered, so without
    // this the row sits pending forever and the user waits on a dead session.
    expect(harness.turns.map((turn) => turn.prompt)).toEqual(['unfinished']);
  });

  it('fails an interrupted turn with a transcript note instead of replaying it', async () => {
    const queue = fakeQueue();
    queue.seed({ id: 'p1', sessionId: 'session-1', prompt: 'half done', createdAt: 10 }, 'executing');

    const harness = makeRuntime({ queue });
    harness.sessionProjects.set('session-1', PROJECT_ID);

    await harness.runtime.recoverPersistedQueue();
    await harness.runtime.idle();

    // A turn's side effects are not once-only: files were written and commands
    // ran. Re-running is a second uncoordinated attempt, not a retry.
    expect(harness.turns).toEqual([]);
    expect(queue.statuses.get('p1')).toBe('failed:interrupted');
    expect(harness.notes).toEqual([{ sessionId: 'session-1', prompt: 'half done' }]);
    expect(harness.events.map((entry) => entry.event)).toContain('prompt-interrupted');
  });
});

describe('serve: shutdown', () => {
  it('stops intake and cancels streaming turns', async () => {
    const cancel = vi.fn(async () => {});
    let turnStarted: () => void;
    const started = new Promise<void>((resolve) => { turnStarted = resolve; });
    let finishTurn: () => void;
    const finished = new Promise<void>((resolve) => { finishTurn = resolve; });

    const harness = makeRuntime({
      runTurn: async (input) => {
        input.onTurnStarted({ cancel });
        turnStarted();
        await finished;
        return {};
      },
    });
    harness.sessionProjects.set('session-1', PROJECT_ID);

    void harness.runtime.handleIndexChange('session-1', {
      queuedPrompts: [{ id: 'p1', prompt: 'long', timestamp: 1 }],
    });
    await started;

    harness.runtime.stopIntake();
    await harness.runtime.cancelAll();
    expect(cancel).toHaveBeenCalledTimes(1);

    // Intake is closed: a request arriving during shutdown must not start work
    // we are about to abandon.
    await harness.runtime.handleCreateSessionRequest(request({ requestId: 'late' }));
    expect(harness.deps.createSession).not.toHaveBeenCalled();

    finishTurn!();
    await harness.runtime.idle();
  });

  it('waits for transcript publication before reporting idle', async () => {
    const flushTranscripts = vi.fn(async () => 0);
    const harness = makeRuntime({ flushTranscripts });
    harness.sessionProjects.set('session-1', PROJECT_ID);

    await harness.runtime.handleIndexChange('session-1', {
      queuedPrompts: [{ id: 'p1', prompt: 'go', timestamp: 1 }],
    });
    await harness.runtime.idle();

    // A row written locally but never published is a turn the user cannot see
    // from any device they own.
    expect(flushTranscripts).toHaveBeenCalled();
  });
});

describe('serve: session control', () => {
  function control(overrides: Partial<SessionControlMessage>): SessionControlMessage {
    return {
      sessionId: 'session-1',
      type: 'cancel',
      timestamp: 1,
      sentBy: 'mobile',
      ...overrides,
    };
  }

  it('cancels the turn that is actually streaming', async () => {
    const cancel = vi.fn(async () => {});
    let turnStarted: () => void;
    const started = new Promise<void>((resolve) => { turnStarted = resolve; });
    let finishTurn: () => void;
    const finished = new Promise<void>((resolve) => { finishTurn = resolve; });

    const harness = makeRuntime({
      runTurn: async (input) => {
        input.onTurnStarted({ cancel });
        turnStarted();
        await finished;
        return {};
      },
    });
    harness.sessionProjects.set('session-1', PROJECT_ID);

    void harness.runtime.handleIndexChange('session-1', {
      queuedPrompts: [{ id: 'p1', prompt: 'long', timestamp: 1 }],
    });
    await started;

    await harness.runtime.handleSessionControlMessage(control({}));
    expect(harness.pushes).toContainEqual({ sessionId: 'session-1', change: { type: 'metadata_updated', metadata: { isExecuting: true } } });
    expect(cancel).toHaveBeenCalledTimes(1);

    finishTurn!();
    await harness.runtime.idle();
    expect(harness.pushes).toContainEqual({ sessionId: 'session-1', change: { type: 'metadata_updated', metadata: { isExecuting: false } } });
  });

  it('logs an unsupported control kind instead of throwing', async () => {
    const harness = makeRuntime();
    await harness.runtime.handleSessionControlMessage(control({ type: 'prompt_response' }));
    await harness.runtime.handleSessionControlMessage(control({ type: 'cancel' }));

    expect(harness.events.map((entry) => entry.event)).toEqual([
      'control-unsupported',
      'cancel-ignored',
    ]);
  });
});
