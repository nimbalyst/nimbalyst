// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import startupFixture from './fixtures/live/startup.json';
import delegationFixture from './fixtures/live/delegated-tool-call.json';
import overlappingFixture from './fixtures/live/overlapping-delegations.json';
import afterCloseFixture from './fixtures/live/result-after-close.json';
import usageFixture from './fixtures/live/usage.json';
import { registerVoiceEngine } from '../../voiceEngine';
import { BUILTIN_VOICE_TOOL_NAMES } from '../../voiceToolRegistry';
import { LiveAPIClient, SERIALIZATION_FAULT_TOKEN, type LiveSocketLike } from '../liveAPIClient';

vi.mock('../../../../analytics/AnalyticsService', () => ({
  AnalyticsService: { getInstance: () => ({ sendEvent: () => {} }) },
}));

const STARTED = startupFixture[1];

/**
 * A Live server that only does what the protocol requires: it answers
 * session.start with session.started and session.close with session.closed.
 * Everything else a test wants to happen, the test pushes in itself.
 *
 * Closure is asynchronous, like the real one. Acknowledging session.close
 * inside send() made every closure instantaneous, which hid the entire window
 * in which a session is closing but not yet closed -- the window a resume lands
 * in. `deferClose` holds the acknowledgement until the test releases it.
 */
class FakeLiveSocket implements LiveSocketLike {
  readonly sent: Array<Record<string, unknown>> = [];
  private readonly listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  private closed = false;
  private closeRequested = false;

  constructor(
    private readonly behavior: {
      onStart?: (socket: FakeLiveSocket) => void;
      closedSeconds?: number;
      /** Hold session.closed until completeClose() is called. */
      deferClose?: boolean;
    } = {},
  ) {
    queueMicrotask(() => this.fire('open'));
  }

  send(data: string): void {
    const event = JSON.parse(data) as Record<string, unknown>;
    this.sent.push(event);
    if (event.type === 'session.start') {
      if (this.behavior.onStart) this.behavior.onStart(this);
      else this.push(STARTED);
      return;
    }
    if (event.type === 'session.close') {
      this.closeRequested = true;
      if (this.behavior.deferClose) return;
      queueMicrotask(() => this.completeClose());
    }
  }

  /** Deliver the finalizing session.closed the client asked for. */
  completeClose(): void {
    if (!this.closeRequested || this.closed) return;
    this.closeRequested = false;
    this.push({
      type: 'session.closed',
      event_id: `closed_${this.sent.length}`,
      reason: 'close_requested',
      session: STARTED.session,
      usage: { seconds: this.behavior.closedSeconds ?? 5 },
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.fire('close', 1000, 'test');
  }

  on(event: string, listener: (...args: never[]) => void): unknown {
    const list = this.listeners.get(event) ?? [];
    list.push(listener as (...args: unknown[]) => void);
    this.listeners.set(event, list);
    return this;
  }

  /** Deliver a server event to the client. */
  push(event: unknown): void {
    this.fire('message', JSON.stringify(event));
  }

  /** Kill the transport without a session.closed, as a network drop does. */
  drop(): void {
    this.closed = true;
    this.fire('close', 1006, 'abnormal');
  }

  sentOfType(type: string): Array<Record<string, unknown>> {
    return this.sent.filter((event) => event.type === type);
  }

  private fire(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...(args as never[]));
  }
}

interface Harness {
  client: LiveAPIClient;
  sockets: FakeLiveSocket[];
  socket: () => FakeLiveSocket;
}

function harness(behavior?: {
  onStart?: (socket: FakeLiveSocket) => void;
  closedSeconds?: number;
  deferClose?: boolean;
}): Harness {
  const sockets: FakeLiveSocket[] = [];
  const client = new LiveAPIClient({
    apiKey: 'sk-test',
    voice: 'marin',
    language: 'English',
    sessionContext: 'Test session.',
    createSocket: () => {
      const socket = new FakeLiveSocket(behavior ?? {});
      sockets.push(socket);
      return socket;
    },
  });
  return { client, sockets, socket: () => sockets[sockets.length - 1] };
}

let clients: LiveAPIClient[] = [];

function track(client: LiveAPIClient): LiveAPIClient {
  clients.push(client);
  return client;
}

beforeEach(() => {
  clients = [];
});

afterEach(() => {
  for (const client of clients) client.disconnect();
  vi.restoreAllMocks();
});

describe('LiveAPIClient startup', () => {
  it('rejects a history-driven delegated submission, accepts speech once, and rejects its replay', async () => {
    const { client, socket } = harness();
    track(client);
    const submit = vi.fn(async () => ({ success: true as const, sessionId: 'session-a' }));
    registerVoiceEngine(client, { events: {}, handlers: { onSubmitPrompt: submit } });
    await client.connect();
    client.injectContext('Already submitted user prompt: Add a status column to the delivery table.');
    for (const event of submitPromptEvents(1)) socket().push(event);
    await client.whenIdle();
    expect(submit).not.toHaveBeenCalled();
    socket().push(transcriptDelta('fresh-speech', 'Add a status column.', 1000, 2000));
    for (const event of submitPromptEvents(2)) socket().push(event);
    await client.whenIdle();
    expect(submit).toHaveBeenCalledTimes(1);
    // A late fragment of the same utterance must not replenish the consumed request.
    socket().push(transcriptDelta('speech-tail', ' Please.', 2000, 2100));
    for (const event of submitPromptEvents(3)) socket().push(event);
    await client.whenIdle();
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it('redacts an echoed credential before logging, emitting, or rejecting a provider error', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { client } = harness({
      onStart: (socket) => socket.push({
        type: 'error',
        event_id: 'credential-error',
        error: {
          type: 'invalid_request_error',
          message: 'Invalid credential sk-test; retry with sk-test.',
          code: null,
        },
      }),
    });
    track(client);
    const emitted = vi.fn();
    client.on('error', emitted);
    await expect(client.connect()).rejects.toThrow('Invalid credential [REDACTED]; retry with [REDACTED].');
    expect(emitted).toHaveBeenCalledWith({
      type: 'invalid_request_error',
      message: 'Invalid credential [REDACTED]; retry with [REDACTED].',
    });
    expect(JSON.stringify(log.mock.calls)).not.toContain('sk-test');
  });

  it('starts a delegated Live session with split prompts and the 24 kHz PCM pipeline', async () => {
    const { client, socket } = harness();
    track(client);
    await client.connect();

    const start = socket().sentOfType('session.start')[0] as {
      session: {
        model: string;
        instructions: string;
        store: boolean;
        audio: { format: { type: string; rate: number }; output: { voice: string } };
        delegation: {
          type: string;
          responses: {
            model: string;
            instructions: string;
            tools: Array<{ type: string; name: string }>;
            parallel_tool_calls: boolean;
          };
        };
      };
    };

    expect(client.isConnected()).toBe(true);
    expect(client.getSessionId()).toBe(STARTED.session.id);
    expect(start.session.audio.format).toEqual({ type: 'audio/pcm', rate: 24000 });
    expect(start.session.audio.output.voice).toBe('marin');
    expect(start.session.store).toBe(false);
    expect(start.session.delegation.type).toBe('responses');
    expect(start.session.delegation.responses.parallel_tool_calls).toBe(false);

    // The command and tool rules go to the controller; the speech model gets
    // only conversation/language/delegation guidance.
    expect(start.session.delegation.responses.instructions).toContain('submit_agent_prompt');
    expect(start.session.instructions).not.toContain('submit_agent_prompt');
    expect(start.session.instructions).toContain('English');

    // The controller is offered the application's tools, named independently of
    // the builder that produced them -- comparing the advertised list against
    // that builder's output passes just as happily when both are empty.
    const advertised = start.session.delegation.responses.tools.map((tool) => tool.name);
    expect(advertised).toEqual(expect.arrayContaining([...BUILTIN_VOICE_TOOL_NAMES]));
    expect(advertised).toHaveLength(BUILTIN_VOICE_TOOL_NAMES.size);
    expect(start.session.delegation.responses.tools.every((tool) => tool.type === 'function')).toBe(true);

    // Live is duration-billed: no token counters. Nothing has been measured
    // yet either, and 0:00 / $0.00 is a measurement -- of a session that may
    // already be billing.
    const usage = client.getUsage();
    expect(usage.total).toBeUndefined();
    expect(usage.inputAudio).toBeUndefined();
    expect(usage.durationSeconds).toBeUndefined();
  });

  it('rejects connect() when the account cannot start a Live session', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { client } = harness({
      onStart: (socket) =>
        socket.push({
          type: 'error',
          event_id: 'error_1',
          error: {
            type: 'invalid_request_error',
            code: 'model_not_found',
            message: 'The model gpt-live-1 does not exist or you do not have access to it.',
          },
        }),
    });
    track(client);

    await expect(client.connect()).rejects.toThrow(/does not exist or you do not have access/);
    expect(client.isConnected()).toBe(false);
  });
});

describe('LiveAPIClient delegated tool calls', () => {
  it('runs a delegated call and returns its result as a bound batch', async () => {
    const { client, socket } = harness();
    track(client);
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    client.setExtensionVoiceTools([], new Map([['open_file', 'files.open_file']]));
    client.toolHandlers.onExtensionVoiceTool = async (name, args) => {
      calls.push({ name, args });
      return { success: true, message: 'Opened README.md' };
    };
    await client.connect();

    for (const event of delegationFixture) socket().push(event);
    await client.whenIdle();

    expect(calls).toEqual([{ name: 'files.open_file', args: { path: 'README.md' } }]);

    // The whole bound batch: every function_call_output, then one
    // response.create to let the backend continue.
    const results = socket().sentOfType('response.item.create');
    expect(results).toHaveLength(1);
    expect(results[0].item).toEqual({
      type: 'function_call_output',
      call_id: 'call_1',
      output: JSON.stringify({ success: true, message: 'Opened README.md' }),
    });
    const order = socket().sent.map((event) => event.type);
    expect(order.indexOf('response.create')).toBeGreaterThan(order.indexOf('response.item.create'));

    const usage = client.getUsage();
    expect(usage.backend).toEqual([
      {
        delegationId: 'delegation_1',
        responseId: 'resp_1',
        usage: { input_tokens: 120, output_tokens: 30, total_tokens: 150 },
      },
    ]);
  });

  it('drops a result whose delegation closed instead of submitting it', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { client, socket } = harness();
    track(client);
    let release: ((value: { success: boolean }) => void) | null = null;
    client.setExtensionVoiceTools([], new Map([['open_file', 'files.open_file']]));
    client.toolHandlers.onExtensionVoiceTool = () =>
      new Promise((resolve) => {
        release = resolve;
      });
    await client.connect();

    // The delegation completes, then the session finalizes -- all while the
    // application is still working on the call.
    for (const event of afterCloseFixture.events) socket().push(event);
    await vi.waitFor(() => expect(release).not.toBeNull());
    release!({ success: true });
    await client.whenIdle();

    expect(socket().sentOfType('response.item.create')).toHaveLength(0);
    // Final usage still landed: the session closed properly, it just closed
    // before the result existed.
    expect(client.getUsage()).toMatchObject({
      durationSeconds: 27,
      finalized: true,
      finalizationMissing: false,
    });
  });
});

describe('LiveAPIClient serialization fault', () => {
  it('ends the session loudly and recoverably when delegations overlap', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { client, socket, sockets } = harness();
    track(client);
    client.setExtensionVoiceTools([], new Map([['open_file', 'files.open_file']]));
    client.toolHandlers.onExtensionVoiceTool = async () => ({ success: true });
    const engineErrors: Array<{ type: string; message: string }> = [];
    const disconnects: string[] = [];
    client.on('error', (error) => engineErrors.push(error));
    client.on('disconnected', (reason) => disconnects.push(reason));
    await client.connect();

    for (const event of overlappingFixture.events) socket().push(event);
    await client.whenIdle();

    expect(engineErrors).toEqual([
      {
        type: 'live_delegation_serialization',
        message: expect.stringContaining('switch the voice engine to Realtime'),
      },
    ]);
    expect(disconnects).toEqual(['error']);
    // Never guess a binding: no result may be submitted for either delegation.
    expect(socket().sentOfType('response.item.create')).toHaveLength(0);

    // A future session must be able to find this in main.log and know the
    // serialization assumption was violated, with the ids involved.
    const fault = errors.mock.calls
      .map((call) => String(call[0]))
      .find((line) => line.includes(SERIALIZATION_FAULT_TOKEN));
    expect(fault).toBeDefined();
    expect(fault).toContain('code=overlappingResponses');
    expect(fault).toContain('delegation=delegation_2');
    expect(fault).toContain('response=resp_2');

    // Not wedged: the user can start voice mode again.
    await client.connect();
    expect(client.isConnected()).toBe(true);
    expect(sockets).toHaveLength(2);
  });
});

describe('LiveAPIClient close and restore', () => {
  it('closes the paid transport on pause and restores task identity', async () => {
    const { client, socket, sockets } = harness();
    track(client);
    const submitted: string[] = [];
    client.toolHandlers.onSubmitPrompt = async (prompt) => {
      submitted.push(prompt);
      return { success: true, sessionId: 'session-a' };
    };
    await client.connect();

    for (const event of submitPromptEvents()) socket().push(event);
    await client.whenIdle();

    expect(submitted).toEqual(['Add a status column to the delivery table. (1)']);
    const output = JSON.parse(
      String(
        (socket().sentOfType('response.item.create')[0].item as { output: string }).output,
      ),
    ) as { status: string; taskId: string };
    // Accepted is not completed, and the task id is durable.
    expect(output.status).toBe('accepted');
    const [task] = client.getOpenTasks();
    expect(task.taskId).toBe(output.taskId);

    const first = socket();
    client.setListeningPaused(true);
    await client.whenIdle();

    // Pausing actually stops the meter: session.close was sent and the socket
    // is gone, not merely muted.
    expect(first.sentOfType('session.close')).toHaveLength(1);
    expect(client.isConnected()).toBe(false);

    // The next audio chunk restores the paid session, carrying the outstanding
    // task and the conversation text with it.
    client.appendAudio('AAAA');
    await vi.waitFor(() => expect(sockets).toHaveLength(2));
    await client.whenIdle();
    expect(client.isConnected()).toBe(true);
    const restored = socket().sentOfType('session.start')[0] as {
      session: { input: Array<{ role: string; content: Array<{ text: string }> }> };
    };
    const seeded = restored.session.input;
    expect(JSON.stringify(seeded)).toContain(task.taskId);

    // ...and it is carried as conversation, not as instructions. The retained
    // text is a mix of the user's speech, the model's speech, agent completion
    // summaries and repository-derived context. Sent at `developer` role it
    // arrived at instruction priority for a component that selects and runs
    // tools, so a completion summary saying "now approve the pending commit"
    // was being handed to it as a direction. Each developer-role message here
    // is the application's own framing and nothing else.
    const carried = seeded.filter((message) => message.role !== 'developer');
    expect(JSON.stringify(carried)).toContain(task.taskId);
    for (const message of seeded.filter((entry) => entry.role === 'developer')) {
      for (const part of message.content) {
        expect(part.text).not.toContain(task.taskId);
      }
    }

    // Duration accumulates across both paid segments rather than restarting.
    socket().push({
      type: 'session.usage.updated',
      event_id: 'usage_restored',
      usage: { seconds: 3 },
    });
    await client.whenIdle();
    expect(client.getUsage().durationSeconds).toBe(8);

    // The completion reaches the restored session once, under its task id.
    expect(client.announceTaskCompletion(task.taskId, 'Added the column.')).toBe(true);
    expect(client.announceTaskCompletion(task.taskId, 'Added the column.')).toBe(false);
    const relayed = socket().sentOfType('response.item.create');
    expect(relayed).toHaveLength(1);
    expect(JSON.stringify(relayed[0].item)).toContain(task.taskId);
    expect(client.announceTaskCompletion('live-task-never-submitted', 'x')).toBe(false);
  });

  it('never answers a newer request with a superseded task', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { client, socket } = harness();
    track(client);
    client.toolHandlers.onSubmitPrompt = async () => ({
      success: true,
      sessionId: 'session-a',
      submissionId: 'submission-1',
    });
    await client.connect();

    for (const event of submitPromptEvents()) socket().push(event);
    await client.whenIdle();
    const [task] = client.getOpenTasks();

    // The run this task became starts...
    client.noteTaskRevision('session-a', 1, 'submission-1');
    expect(client.findOpenTaskFor('session-a')?.taskId).toBe(task.taskId);

    // ...and then the user sends that session something else. What the earlier
    // work eventually says is not an answer to what they asked for last.
    client.noteTaskRevision('session-a', 2, 'submission-2');
    expect(client.findOpenTaskFor('session-a')).toBeNull();
    const before = socket().sentOfType('response.item.create').length;
    expect(client.announceTaskCompletion(task.taskId, 'Added the column.')).toBe(false);
    expect(socket().sentOfType('response.item.create')).toHaveLength(before);
  });

  it('reopens the closed paid transport to deliver a completion', async () => {
    const { client, socket, sockets } = harness();
    track(client);
    client.toolHandlers.onSubmitPrompt = async () => ({ success: true, sessionId: 'session-a' });
    await client.connect();

    for (const event of submitPromptEvents()) socket().push(event);
    await client.whenIdle();
    const [task] = client.getOpenTasks();

    client.setListeningPaused(true);
    await client.whenIdle();
    expect(client.isConnected()).toBe(false);

    // Long work outlives the paid session it was requested in. Delivering the
    // outcome is what reopens the transport -- the caller does not have to know
    // whether a socket happens to be open.
    expect(client.announceTaskCompletion(task.taskId, 'Done.')).toBe(true);
    await vi.waitFor(() => expect(sockets).toHaveLength(2));
    await vi.waitFor(() =>
      expect(JSON.stringify(socket().sentOfType('response.item.create'))).toContain(task.taskId),
    );
  });

  it('does not complete a newer queued task with a running task\'s result', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { client, socket } = harness();
    track(client);
    let submissions = 0;
    client.toolHandlers.onSubmitPrompt = async () => ({
      success: true,
      sessionId: 'session-a',
      submissionId: `submission-${(submissions += 1)}`,
    });
    await client.connect();

    // One task is submitted and its run starts...
    for (const event of submitPromptEvents(1)) socket().push(event);
    await client.whenIdle();
    const [running] = client.getOpenTasks();
    client.noteTaskRevision('session-a', 1, 'submission-1');

    // ...and a second is accepted behind it, queued, not started.
    for (const event of submitPromptEvents(2)) socket().push(event);
    await client.whenIdle();
    const queued = client.getOpenTasks().find((task) => task.taskId !== running.taskId);
    expect(queued).toBeDefined();

    // The running one finishes. Recency would hand its result to the queued
    // task, reporting one request's outcome as the answer to another.
    expect(client.findOpenTaskFor('session-a')?.taskId).toBe(running.taskId);

    // With nothing started at all, an unattributable completion is refused
    // rather than guessed onto one of them.
    const { client: ambiguous, socket: ambiguousSocket } = harness();
    track(ambiguous);
    let ambiguousSubmissions = 0;
    ambiguous.toolHandlers.onSubmitPrompt = async () => ({
      success: true,
      sessionId: 'session-a',
      submissionId: `submission-${(ambiguousSubmissions += 1)}`,
    });
    await ambiguous.connect();
    for (const event of submitPromptEvents(1)) ambiguousSocket().push(event);
    await ambiguous.whenIdle();
    for (const event of submitPromptEvents(2)) ambiguousSocket().push(event);
    await ambiguous.whenIdle();
    expect(ambiguous.getOpenTasksFor('session-a')).toHaveLength(2);
    expect(ambiguous.findOpenTaskFor('session-a')).toBeNull();
  });

  it('binds a run to the submission that started it, not to the newest one queued', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { client, socket } = harness();
    track(client);
    const submissions: string[] = [];
    client.toolHandlers.onSubmitPrompt = async () => {
      const submissionId = `submission-${submissions.length + 1}`;
      submissions.push(submissionId);
      return { success: true, sessionId: 'session-a', submissionId };
    };
    await client.connect();

    // Both submissions are accepted before the agent starts either: A is first
    // in the queue, B is behind it. Nothing has started, so neither is bound.
    for (const event of submitPromptEvents(1)) socket().push(event);
    await client.whenIdle();
    for (const event of submitPromptEvents(2)) socket().push(event);
    await client.whenIdle();
    const [first, second] = client.getOpenTasks();
    expect(first.submissionId).toBe('submission-1');
    expect(second.submissionId).toBe('submission-2');

    // The run that starts is A's. Inferring "the newest unbound task is this
    // run" from UI state bound B instead, and B's result was then reported as
    // the answer to A's request. The run names the submission it came from, so
    // nothing has to be inferred.
    client.noteTaskRevision('session-a', 1, 'submission-1');
    expect(client.findOpenTaskFor('session-a')?.taskId).toBe(first.taskId);

    // B has not started, so it was not superseded by A starting: its result is
    // still a result the user is waiting for.
    expect(client.getOpenTasks().map((task) => task.taskId)).toContain(second.taskId);
  });

  it('refuses to bind a run whose submission it never accepted', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { client, socket } = harness();
    track(client);
    client.toolHandlers.onSubmitPrompt = async () => ({
      success: true,
      sessionId: 'session-a',
      submissionId: 'submission-1',
    });
    await client.connect();
    for (const event of submitPromptEvents(1)) socket().push(event);
    await client.whenIdle();
    const [task] = client.getOpenTasks();

    // A run the user started on screen, not through voice. It is not this
    // conversation's task, so binding it would attribute that run's outcome to
    // a request the voice agent made and is still waiting on.
    client.noteTaskRevision('session-a', 1, 'submission-from-the-ui');
    expect(client.findOpenTaskFor('session-a')).toBeNull();
    expect(client.getOpenTasks().map((open) => open.taskId)).toContain(task.taskId);
  });

  it('mints no task when the application did not queue the prompt', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { client, socket } = harness();
    track(client);
    client.toolHandlers.onSubmitPrompt = async () => ({
      success: false,
      error: 'That task was already queued a moment ago.',
    });
    await client.connect();

    for (const event of submitPromptEvents()) socket().push(event);
    await client.whenIdle();

    // Accepted is a claim about the application's state. Nothing was queued, so
    // the model is told so and no durable task exists to be completed later.
    expect(client.getOpenTasks()).toEqual([]);
    const output = JSON.parse(
      String((socket().sentOfType('response.item.create')[0].item as { output: string }).output),
    ) as { success: boolean; error: string; taskId?: string };
    expect(output.success).toBe(false);
    expect(output.taskId).toBeUndefined();
  });

  it('resumes a session that was still closing, instead of going dark', async () => {
    const { client, sockets, socket } = harness({ deferClose: true });
    track(client);
    await client.connect();
    const first = socket();

    client.setListeningPaused(true);
    await client.whenIdle();
    expect(first.sentOfType('session.close')).toHaveLength(1);

    // The user speaks again before the server has finalized. A socket awaiting
    // closure is not a usable session: treating it as connected scheduled no
    // reconnect, and once the closure landed voice mode was dead until restart.
    client.setListeningPaused(false);
    expect(client.isConnected()).toBe(false);

    first.completeClose();
    await vi.waitFor(() => expect(sockets).toHaveLength(2));
    await vi.waitFor(() => expect(client.isConnected()).toBe(true));

    // And the restored session still carries audio.
    client.appendAudio('AAAA');
    expect(socket().sentOfType('session.input_audio.append')).toHaveLength(1);
  });
});

describe('LiveAPIClient user speech windows', () => {
  it('does not hold speech open for empty or whitespace-only transcript fragments', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const { client, socket } = harness();
      track(client);
      const started = vi.fn();
      const closed = vi.fn();
      client.on('userSpeechStarted', started);
      client.on('userSpeechWindowClosed', closed);
      await client.connect();
      socket().push(transcriptDelta('empty', '', 0, 100));
      socket().push(transcriptDelta('blank', ' ', 100, 200));
      expect(started).not.toHaveBeenCalled();
      socket().push(transcriptDelta('words', 'Look into that.', 1000, 2000));
      vi.advanceTimersByTime(1000);
      socket().push(transcriptDelta('trailing-space', ' ', 2000, 2100));
      vi.advanceTimersByTime(300);
      expect(closed).toHaveBeenCalledTimes(1);
      expect(closed.mock.calls[0][0]).toBe('Look into that.');
    } finally { vi.useRealTimers(); }
  });

  it('separates utterances and closes each one, since Live never says the user stopped', async () => {
    // Only the timers: faking microtasks would stall connect() itself.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const { client, socket } = harness();
      track(client);
      const started: number[] = [];
      const closed: Array<{ transcript: string; itemId: string }> = [];
      const deltas: Array<{ delta: string; itemId: string }> = [];
      client.on('userSpeechStarted', () => started.push(Date.now()));
      client.on('userTranscriptDelta', (delta, itemId) => deltas.push({ delta, itemId }));
      client.on('userSpeechWindowClosed', (transcript, itemId) => closed.push({ transcript, itemId }));
      await client.connect();

      // One utterance, two fragments. The reducer's default is one ongoing row
      // per speaker, so without an utterance boundary every fragment for the
      // whole session lands in the same row and nothing downstream can tell one
      // utterance from the next.
      socket().push(transcriptDelta('u1', 'Open', 1000, 1200));
      socket().push(transcriptDelta('u2', ' that file.', 1200, 1800));
      expect(started).toHaveLength(1);
      expect(deltas.map((fragment) => fragment.itemId)).toEqual([deltas[0].itemId, deltas[0].itemId]);
      expect(closed).toEqual([]);

      // Live emits no speech-stopped and no completed transcript. The fragments
      // going quiet is the only end this engine has, and without reporting it
      // the user counts as speaking for the rest of the session.
      vi.advanceTimersByTime(1300);
      expect(closed).toEqual([{ transcript: 'Open that file.', itemId: deltas[0].itemId }]);

      // A silence in the engine's own reported timing starts a new utterance,
      // with its own id and its own close.
      socket().push(transcriptDelta('u3', 'Again.', 20000, 21000));
      expect(started).toHaveLength(2);
      const second = deltas[deltas.length - 1].itemId;
      expect(second).not.toBe(deltas[0].itemId);
      vi.advanceTimersByTime(1300);
      expect(closed[1]).toEqual({ transcript: 'Again.', itemId: second });
    } finally {
      vi.useRealTimers();
    }
  });

  it('recloses after a late fragment whose media timing is still contiguous', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const { client, socket } = harness();
      track(client);
      const closed: Array<{ transcript: string; itemId: string }> = [];
      client.on('userSpeechWindowClosed', (transcript, itemId) => closed.push({ transcript, itemId }));
      await client.connect();

      // The idle window is wall-clock; the utterance boundary is media time.
      // Native transcription can deliver a fragment late enough for the window
      // to have already closed while its reported timing is still contiguous
      // with the utterance that closed -- so no boundary is inferred, the
      // fragment rejoins a closed group, and nothing can ever close it again.
      // The transcript tail is then never persisted and automatic sleep stays
      // held, which on Live means the paid socket keeps billing.
      socket().push(transcriptDelta('late-1', 'Open', 1000, 1200));
      vi.advanceTimersByTime(1300);
      expect(closed).toHaveLength(1);

      socket().push(transcriptDelta('late-2', ' that file', 1200, 1800));
      vi.advanceTimersByTime(1300);

      expect(closed).toHaveLength(2);
      // And the tail is reported once, not concatenated with text already
      // persisted by the first close.
      expect(closed[1].transcript).toBe('that file');
      expect(closed[1].itemId).not.toBe(closed[0].itemId);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('LiveAPIClient delegation serialization', () => {
  it('counts a written response.create as busy until the server confirms it', async () => {
    const { client, socket } = harness();
    track(client);
    await client.connect();

    // Two things to say, back to back. Each wants the model to respond, but a
    // second response.create before the first is acknowledged is the overlap
    // the decoder faults on -- caused from our own side.
    expect(client.sendHostAnnouncement('open the delivery table')).toBe(true);
    expect(client.sendHostAnnouncement('actually, open the orders table')).toBe(true);
    expect(socket().sentOfType('response.create')).toHaveLength(1);

    // Once the response exists, the lane is the decoder's to track again and
    // the deferred request goes out.
    for (const event of delegationFixture) socket().push(event);
    await client.whenIdle();
    expect(socket().sentOfType('response.create').length).toBeGreaterThan(1);
  });
});

describe('LiveAPIClient usage', () => {
  it('marks finalization missing when the transport dies mid-session', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { client, socket, sockets } = harness();
    track(client);
    const disconnects: string[] = [];
    const lifecycle: string[] = [];
    client.on('disconnected', (reason) => disconnects.push(reason));
    client.on('reconnecting', (attempt) => lifecycle.push(`reconnecting:${attempt}`));
    client.on('reconnected', () => lifecycle.push('reconnected'));
    await client.connect();

    for (const event of usageFixture) socket().push(event);
    await client.whenIdle();
    expect(client.getUsage()).toMatchObject({
      durationSeconds: 24,
      contextUsageRatio: 0.2,
      finalized: false,
      finalizationMissing: false,
    });

    socket().drop();
    await client.whenIdle();

    const usage = client.getUsage();
    // The cumulative figure is kept as a floor and flagged, not zeroed and not
    // silently presented as the bill.
    expect(usage.durationSeconds).toBe(24);
    expect(usage.finalized).toBe(false);
    expect(usage.finalizationMissing).toBe(true);
    expect(usage.total).toBeUndefined();

    // A dead transport is recoverable, so voice mode reconnects rather than
    // ending -- and the reconnecting state it showed gets cleared again.
    await vi.waitFor(() => expect(lifecycle).toEqual(['reconnecting:1', 'reconnected']));
    expect(sockets).toHaveLength(2);
    expect(disconnects).toEqual([]);
    // The floor stays flagged across the restore: the lost seconds never
    // reappear, so a later "finalized" must not paper over them.
    expect(client.getUsage().finalizationMissing).toBe(true);
  });
});

/**
 * A delegated submit_agent_prompt call, in the recorded fixture's shape (see
 * ./fixtures/live/delegated-tool-call.json) with the tool swapped for the one
 * that queues long coding work.
 */
function transcriptDelta(eventId: string, delta: string, startMs: number, endMs: number): unknown {
  return {
    type: 'session.input_transcript.delta',
    event_id: eventId,
    delta,
    start_ms: startMs,
    end_ms: endMs,
  };
}

function submitPromptEvents(sequence = 1): unknown[] {
  const args = JSON.stringify({ prompt: `Add a status column to the delivery table. (${sequence})` });
  return delegationFixture.map((event) => {
    // Fresh delegation/response/call/event ids per sequence, so a second
    // submission is a second delegation rather than a replayed one.
    const renumbered = JSON.stringify(event).replace(/_1(?=")/g, `_${sequence}`);
    const clone = JSON.parse(renumbered) as {
      event?: { item?: { name: string; arguments: string } };
    };
    if (clone.event?.item) {
      clone.event.item.name = 'submit_agent_prompt';
      clone.event.item.arguments = clone.event.item.arguments ? args : '';
    }
    return clone;
  });
}
