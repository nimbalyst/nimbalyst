import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A question from a session the user is NOT looking at, answered by voice
 * after the user has moved on.
 *
 * Worth a test because both halves used to be wrong in a way nothing else
 * catches: voice only ever watched the one linked session, so a second agent's
 * question was never spoken at all, and the answer was submitted to whichever
 * session the voice agent currently targets -- which, by the time someone has
 * heard a question and replied to it, is regularly not the one that asked.
 * Both failures are silent: an answer lands on a real session and resolves a
 * real prompt, just not the right one.
 */

const listeners = new Map<string, (payload: unknown) => void>();
let invoke: ReturnType<typeof vi.fn>;
let send: ReturnType<typeof vi.fn>;

/**
 * Pay the module graph's cost once, here, rather than inside whichever test
 * happens to run first.
 *
 * Importing `voiceModeListeners` takes about five seconds, essentially all of
 * it in `atoms/appSettings` -> `@nimbalyst/runtime` (the barrel drags in the
 * Lexical tree; see the testing rules in CLAUDE.md). That is a pre-existing
 * cost in production code and not this file's to fix, but charging it to a
 * single test put that test within variance of the 20s per-test timeout, and it
 * duly flaked. Warming it here makes the cost visible as setup and keeps every
 * test's own budget about its own behavior.
 */
beforeAll(async () => {
  await import('../voiceModeListeners');
});

beforeEach(() => {
  listeners.clear();
  vi.resetModules();
  invoke = vi.fn().mockResolvedValue({ success: true });
  send = vi.fn();
  // Augment the jsdom window rather than replacing it: renderer modules
  // imported along the way register global error handlers on it.
  (window as unknown as { electronAPI: unknown }).electronAPI = {
      on: vi.fn((channel: string, handler: (payload: unknown) => void) => {
        listeners.set(channel, handler);
        return () => listeners.delete(channel);
      }),
      send,
      invoke,
      onAIStreamResponse: vi.fn(() => () => {}),
  };
});

const ASKING_SESSION = 'session-asking';
const FOCUSED_SESSION = 'session-focused';
const SUBMITTED_SESSION = 'session-submitted';

/** Register the listeners with two known sessions and voice already running. */
async function boot(options?: { listenState?: 'listening' | 'sleeping' }) {
  const { store } = await import('@nimbalyst/runtime/store');
  const sessions = await import('../../atoms/sessions');
  const voice = await import('../../atoms/voiceModeState');
  const listenersModule = await import('../voiceModeListeners');

  store.set(sessions.sessionListWorkspaceAtom, '/ws');
  store.set(
    sessions.sessionRegistryAtom,
    new Map([
      [FOCUSED_SESSION, { id: FOCUSED_SESSION, title: 'Focused', workspaceId: '/ws', updatedAt: 2 }],
      [ASKING_SESSION, { id: ASKING_SESSION, title: 'Delivery table', workspaceId: '/ws', updatedAt: 1 }],
    ] as never),
  );
  store.set(sessions.activeSessionIdAtom, FOCUSED_SESSION);
  store.set(voice.voiceActiveSessionIdAtom, FOCUSED_SESSION);
  store.set(voice.voiceWorkspacePathAtom, '/ws');
  store.set(voice.voiceDbSessionIdAtom, 'voice-db-1');
  store.set(voice.voiceListenStateAtom, options?.listenState ?? 'listening');

  const dispose = listenersModule.initVoiceModeListeners();
  // Main issues the conversation claim at activation, to the owning window
  // only. Without it the renderer has no conversation to name and every send
  // is refused -- which is the point of the claim, so tests activate properly
  // rather than sending unnamed messages.
  listeners.get('voice-mode:engine-selected')?.({
    sessionId: FOCUSED_SESSION,
    engine: 'realtime',
    fallbackFrom: null,
    reason: '',
    generation: 7,
    workspacePath: '/ws',
  });
  // Audio has to reach a playback pipeline to be evidence of anything.
  voice.registerVoiceAudioCallback(() => true);
  return { store, sessions, voice, dispose };
}

/** Hand an announcement its audio and let that audio finish playing. */
async function hearAnnouncement(): Promise<void> {
  const listenersModule = await import('../voiceModeListeners');
  fire('voice-mode:audio-received', { sessionId: FOCUSED_SESSION, audioBase64: 'AQABAA==' });
  listenersModule.notifyVoiceAudioPlaybackDrained();
}

const fire = (channel: string, payload: unknown): void => {
  listeners.get(channel)?.(payload);
};

/** Let an async IPC handler (voice-mode:stopped persists first) finish. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const sentOn = (channel: string): unknown[] =>
  send.mock.calls.filter((call) => call[0] === channel).map((call) => call[1]);

describe('voice transcript refresh cleanup', () => {
  it.each(['scheduled', 'pending-write'] as const)('cancels %s refreshes when listeners are disposed', async (phase) => {
    vi.useFakeTimers();
    const { dispose } = await boot();
    const aiLoadSession = vi.fn().mockResolvedValue(null);
    window.electronAPI.aiLoadSession = aiLoadSession;
    await vi.advanceTimersByTimeAsync(250);
    aiLoadSession.mockClear();
    let finishWrite!: () => void;
    invoke.mockImplementation((channel: string) => channel === 'voice-mode:appendMessage'
      ? new Promise<void>(resolve => { finishWrite = resolve; })
      : Promise.resolve({ success: true }));
    const toolCall = {
      sessionId: FOCUSED_SESSION,
      event: { phase: 'started', callId: 'cleanup', name: 'test', displayName: 'Test', args: {} },
    };
    try {
      fire('voice-mode:tool-call', toolCall);
      if (phase === 'scheduled') { finishWrite(); await Promise.resolve(); }
      dispose();
      // A replacement listener must not reactivate the old write's callback.
      const { initVoiceModeListeners } = await import('../voiceModeListeners');
      const disposeReplacement = initVoiceModeListeners();
      try {
        if (phase === 'pending-write') finishWrite();
        await vi.advanceTimersByTimeAsync(250);
        expect(aiLoadSession).not.toHaveBeenCalled();
        fire('voice-mode:tool-call', toolCall);
        finishWrite();
        await vi.advanceTimersByTimeAsync(250);
        expect(aiLoadSession).toHaveBeenCalledExactlyOnceWith('voice-db-1', '/ws');
      } finally { disposeReplacement(); }
    } finally { dispose(); vi.clearAllTimers(); vi.useRealTimers(); }
  });
});

describe('voice listen timeout wiring', () => {
  it('sleeps despite continuous silent Live output and a lost speech close', async () => {
    const { store, voice, dispose } = await boot();
    const { wakeVoiceListening } = await import('../voiceModeListeners');
    fire('voice-mode:engine-selected', { sessionId: FOCUSED_SESSION, engine: 'live', generation: 7, workspacePath: '/ws' });
    vi.useFakeTimers();
    try {
      wakeVoiceListening();
      fire('voice-mode:transcript-delta', { sessionId: FOCUSED_SESSION, itemId: 'lost-close', delta: 'hello' });
      for (let i = 0; i < 180; i++) {
        if (i === 30) fire('voice-mode:interrupt', { sessionId: FOCUSED_SESSION });
        fire('voice-mode:audio-received', { sessionId: FOCUSED_SESSION, audioBase64: 'AAAA' });
        vi.advanceTimersByTime(100);
      }
      expect(store.get(voice.voiceListenStateAtom)).toBe('sleeping');
      fire('voice-mode:audio-received', { sessionId: FOCUSED_SESSION, audioBase64: 'AAAA' });
      fire('voice-mode:text-received', { sessionId: FOCUSED_SESSION, text: ' ' });
      expect(store.get(voice.voiceListenStateAtom)).toBe('sleeping');
      expect(sentOn('voice-mode:listen-state-changed')).toContainEqual(expect.objectContaining({ sleeping: true }));
    } finally { dispose(); vi.useRealTimers(); }
  });

  it('times out Live text-only output and keeps explicit sleep through a pending audio drain', async () => {
    const { store, voice, dispose } = await boot();
    const { notifyVoiceAudioPlaybackDrained, sleepVoiceListening } = await import('../voiceModeListeners');
    fire('voice-mode:engine-selected', { sessionId: FOCUSED_SESSION, engine: 'live', generation: 7, workspacePath: '/ws' });
    voice.registerVoiceAudioActiveQuery(() => false);
    vi.useFakeTimers();
    try {
      fire('voice-mode:text-received', { sessionId: FOCUSED_SESSION, text: 'Hello' });
      vi.advanceTimersByTime(15_000);
      expect(store.get(voice.voiceListenStateAtom)).toBe('sleeping');
      fire('voice-mode:audio-received', { sessionId: FOCUSED_SESSION, audioBase64: 'AQABAA==' });
      expect(store.get(voice.voiceListenStateAtom)).toBe('listening');
      sleepVoiceListening();
      notifyVoiceAudioPlaybackDrained();
      vi.advanceTimersByTime(75_000);
      expect(store.get(voice.voiceListenStateAtom)).toBe('sleeping');
    } finally {
      dispose();
      voice.registerVoiceAudioActiveQuery(null);
      vi.useRealTimers();
    }
  });

  it.each([['live', true], ['live', false], ['realtime', false]] as const)('expires after audible playback on %s (periodic usage: %s)', async (engine, periodicUsage) => {
    const { store, voice, dispose } = await boot();
    const { notifyVoiceAudioPlaybackDrained, wakeVoiceListening } = await import('../voiceModeListeners');
    fire('voice-mode:engine-selected', {
      sessionId: FOCUSED_SESSION, engine, generation: 7, workspacePath: '/ws',
    });
    let playing = true;
    voice.registerVoiceAudioActiveQuery(() => playing);
    vi.useFakeTimers();
    try {
      wakeVoiceListening();
      fire('voice-mode:audio-received', { sessionId: FOCUSED_SESSION, audioBase64: 'AQABAA==' });
      if (engine === 'realtime') {
        fire('voice-mode:token-usage', { sessionId: FOCUSED_SESSION, engine, usage: {} });
      }
      if (engine === 'live') {
        // A delayed user transcript settles while the assistant is audible.
        fire('voice-mode:transcript-delta', { sessionId: FOCUSED_SESSION, itemId: 'u1', delta: 'hello' });
        fire('voice-mode:speech-window-closed', { sessionId: FOCUSED_SESSION, itemId: 'u1', transcript: 'hello' });
      }
      // No Live usage report is required to finish audible playback.
      vi.advanceTimersByTime(20_000);
      expect(store.get(voice.voiceListenStateAtom)).toBe('listening');
      playing = false;
      notifyVoiceAudioPlaybackDrained();
      for (let elapsed = 0; elapsed < 15_000; elapsed += 5_000) {
        if (periodicUsage) {
          fire('voice-mode:token-usage', {
            sessionId: FOCUSED_SESSION, engine, usage: { durationSeconds: elapsed / 1000 },
          });
        }
        vi.advanceTimersByTime(4_999);
        expect(store.get(voice.voiceListenStateAtom)).toBe('listening');
        vi.advanceTimersByTime(1);
      }
      expect(store.get(voice.voiceListenStateAtom)).toBe('sleeping');
      expect(sentOn('voice-mode:listen-state-changed')).toContainEqual(expect.objectContaining({ sleeping: true }));
      if (engine === 'live') {
        fire('voice-mode:token-usage', { sessionId: FOCUSED_SESSION, engine, usage: { durationSeconds: 40 } });
        expect(store.get(voice.voiceListenStateAtom)).toBe('sleeping');
        expect(store.get(voice.voiceTokenUsageAtom)?.durationSeconds).toBe(40);
      }
    } finally {
      dispose();
      voice.registerVoiceAudioActiveQuery(null);
      vi.useRealTimers();
    }
  });
});

describe('voice event queue wiring', () => {
  it('retries a completion when ordinary assistant playback drains', async () => {
    const { voice, dispose } = await boot();
    let playing = true;
    voice.registerVoiceAudioActiveQuery(() => playing);
    try {
      fire('voice-mode:task-completed', { sessionId: FOCUSED_SESSION, summary: 'Coding finished.' });
      expect(sentOn('voice-mode:announce-completion')).toHaveLength(0);
      playing = false;
      (await import('../voiceModeListeners')).notifyVoiceAudioPlaybackDrained();
      expect(sentOn('voice-mode:announce-completion')).toHaveLength(1);
    } finally { voice.registerVoiceAudioActiveQuery(null); dispose(); }
  });

  it('announces another session\'s question and sends the answer back to it', async () => {
    const { store } = await import('@nimbalyst/runtime/store');
    const sessions = await import('../../atoms/sessions');
    const voice = await import('../../atoms/voiceModeState');
    const { initVoiceModeListeners } = await import('../voiceModeListeners');

    store.set(sessions.sessionListWorkspaceAtom, '/ws');
    store.set(
      sessions.sessionRegistryAtom,
      new Map([
        [FOCUSED_SESSION, { id: FOCUSED_SESSION, title: 'Focused', workspaceId: '/ws', updatedAt: 2 }],
        [ASKING_SESSION, { id: ASKING_SESSION, title: 'Delivery table', workspaceId: '/ws', updatedAt: 1 }],
      ] as never),
    );
    store.set(sessions.activeSessionIdAtom, FOCUSED_SESSION);
    store.set(voice.voiceActiveSessionIdAtom, FOCUSED_SESSION);
    store.set(voice.voiceWorkspacePathAtom, '/ws');
    store.set(voice.voiceListenStateAtom, 'listening');

    const dispose = initVoiceModeListeners();
    listeners.get('voice-mode:engine-selected')?.({
      sessionId: FOCUSED_SESSION,
      engine: 'realtime',
      fallbackFrom: null,
      reason: '',
      generation: 7,
      workspacePath: '/ws',
    });
    voice.registerVoiceAudioCallback(() => true);

    store.set(sessions.sessionPendingPromptsAtom(ASKING_SESSION), [
      {
        id: 'row-1',
        sessionId: ASKING_SESSION,
        promptType: 'ask_user_question_request',
        promptId: 'prompt-1',
        data: { questions: [{ question: 'Pick a column type', options: [{ label: 'text' }, { label: 'integer' }] }] },
        createdAt: 10,
      },
    ]);
    store.set(sessions.sessionHasPendingInteractivePromptAtom(ASKING_SESSION), true);

    const announced = send.mock.calls.filter((call) => call[0] === 'voice-mode:interactive-prompt');
    expect(announced).toHaveLength(1);
    expect(announced[0][1]).toMatchObject({ sessionId: ASKING_SESSION, promptId: 'prompt-1' });
    // Spoken with its source, because the user is looking at something else.
    expect(String((announced[0][1] as { description: string }).description)).toContain('Delivery table');

    // The assistant reads it out and that audio finishes playing. Only a drain
    // of our own playback queue establishes that the user heard the question:
    // a single fragment carries no announcement identity, so it could belong to
    // whatever the model was already saying.
    const { notifyVoiceAudioPlaybackDrained } = await import('../voiceModeListeners');
    listeners.get('voice-mode:audio-received')?.({ sessionId: FOCUSED_SESSION, audioBase64: 'AQABAA==' });
    notifyVoiceAudioPlaybackDrained();

    // Main forwards the spoken answer with the session the voice agent is
    // pointed at -- which is not the session that asked.
    listeners.get('voice-mode:respond-to-prompt')?.({
      sessionId: FOCUSED_SESSION,
      promptId: 'prompt-1',
      promptType: 'ask_user_question_request',
      response: { answers: { _voice: 'text' } },
    });

    const responded = invoke.mock.calls.filter((call) => call[0] === 'messages:respond-to-prompt');
    expect(responded).toHaveLength(1);
    expect(responded[0][1]).toMatchObject({
      sessionId: ASKING_SESSION, promptId: 'prompt-1',
      response: { answers: { 'Pick a column type': 'text' } },
    });

    // The question is answered; a second delivery of the same answer must not
    // submit it again.
    invoke.mockClear();
    listeners.get('voice-mode:respond-to-prompt')?.({
      sessionId: FOCUSED_SESSION,
      promptId: 'prompt-1',
      promptType: 'ask_user_question_request',
      response: { answers: { _voice: 'text' } },
    });
    expect(invoke.mock.calls.filter((call) => call[0] === 'messages:respond-to-prompt')).toHaveLength(0);

    dispose();
  });

  it('is not marked heard by the previous answer\'s text', async () => {
    const { dispose } = await boot();

    fire('voice-mode:task-completed', { sessionId: FOCUSED_SESSION, summary: 'Added the column.' });
    fire('voice-mode:task-completed', { sessionId: ASKING_SESSION, summary: 'Reindexed.' });
    // One announcement at a time; the second waits for the first to be heard.
    expect(sentOn('voice-mode:announce-completion')).toHaveLength(1);

    // A text fragment is the backend having accepted the announcement, and it
    // can just as well be a fragment of the answer already being spoken.
    // Treating it as proof releases the floor while the user has heard nothing.
    fire('voice-mode:text-received', { sessionId: FOCUSED_SESSION, text: 'as I was saying' });
    expect(sentOn('voice-mode:announce-completion')).toHaveLength(1);

    // Nor does a single audio fragment. `voice-mode:audio-received` carries the
    // voice session and PCM and nothing that identifies which announcement it
    // belongs to, so it cannot be told apart from the tail of whatever was
    // already being spoken.
    fire('voice-mode:audio-received', { sessionId: FOCUSED_SESSION, audioBase64: 'AQABAA==' });
    expect(sentOn('voice-mode:announce-completion')).toHaveLength(1);

    // Our own playback queue draining is the one thing the application owns:
    // everything queued since the claim has audibly finished.
    (await import('../voiceModeListeners')).notifyVoiceAudioPlaybackDrained();
    expect(sentOn('voice-mode:announce-completion')).toHaveLength(2);

    dispose();
  });

  it('announces the completion of work the user handed over, even asleep', async () => {
    const { voice, dispose } = await boot({ listenState: 'sleeping' });
    voice.registerVoiceSubmitPromptCallback(async () => ({ queued: true }));

    // Background chatter from a session the user never mentioned stays queued:
    // reopening a paid session to say "that finished" is the interruption this
    // design avoids.
    fire('voice-mode:task-completed', { sessionId: ASKING_SESSION, summary: 'Reindexed.' });
    expect(sentOn('voice-mode:announce-completion')).toHaveLength(0);

    // The task the user submitted through voice is the one they are waiting on.
    fire('voice-mode:submit-prompt', {
      sessionId: SUBMITTED_SESSION,
      workspacePath: '/ws',
      prompt: 'Add a status column.',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    fire('voice-mode:task-completed', { sessionId: SUBMITTED_SESSION, summary: 'Added the column.' });

    const announced = sentOn('voice-mode:announce-completion');
    expect(announced).toHaveLength(1);
    expect(String((announced[0] as { summary: string }).summary)).toContain('Added the column');

    dispose();
  });

  it('ignores blank Live speech activity so completion delivery and idle sleep still work', async () => {
    const { store, voice, dispose } = await boot();
    vi.useFakeTimers();
    try {
      fire('voice-mode:engine-selected', { sessionId: FOCUSED_SESSION, engine: 'live', generation: 7, workspacePath: '/ws' });
      fire('voice-mode:transcript-delta', { sessionId: FOCUSED_SESSION, itemId: 'u1', delta: 'hello' });
      fire('voice-mode:speech-window-closed', { sessionId: FOCUSED_SESSION, itemId: 'u1', transcript: 'hello' });
      fire('voice-mode:transcript-delta', { sessionId: FOCUSED_SESSION, itemId: 'u1', delta: ' ' });
      fire('voice-mode:task-completed', { sessionId: FOCUSED_SESSION, summary: 'Here is the answer.' });
      expect(sentOn('voice-mode:announce-completion')).toHaveLength(1);
      await hearAnnouncement();
      vi.advanceTimersByTime(16000);
      expect(store.get(voice.voiceListenStateAtom)).toBe('sleeping');
    } finally { dispose(); vi.useRealTimers(); }
  });

  it('closes the Live speech window so sleep can arm and utterances persist', async () => {
    const { store, voice, dispose } = await boot();
    fire('voice-mode:engine-selected', {
      sessionId: FOCUSED_SESSION,
      engine: 'live',
      fallbackFrom: null,
      reason: '',
      generation: 7,
      workspacePath: '/ws',
    });

    // Live has no VAD: transcript fragments are the only evidence the user is
    // talking, and they are incremental, so the caption is their sum.
    fire('voice-mode:transcript-delta', { sessionId: FOCUSED_SESSION, delta: 'open the ', itemId: 'u1' });
    fire('voice-mode:transcript-delta', { sessionId: FOCUSED_SESSION, delta: 'delivery table', itemId: 'u1' });
    expect(store.get(voice.voiceCurrentUserTextAtom)).toBe('open the delivery table');

    // Mid-utterance, a routine completion must not interrupt.
    fire('voice-mode:task-completed', { sessionId: ASKING_SESSION, summary: 'Reindexed.' });
    expect(sentOn('voice-mode:announce-completion')).toHaveLength(0);

    // Live emits no speech-stopped and no completed transcript. Without its own
    // close the user is "speaking" for the rest of the session: sleep never
    // arms, completions stay blocked, and the utterance is never persisted.
    fire('voice-mode:speech-window-closed', {
      sessionId: FOCUSED_SESSION,
      itemId: 'u1',
      transcript: 'open the delivery table',
    });

    expect(store.get(voice.voiceCurrentUserTextAtom)).toBe('');
    expect(sentOn('voice-mode:announce-completion')).toHaveLength(1);
    const persisted = invoke.mock.calls
      .filter((call) => call[0] === 'voice-mode:appendMessage')
      .map((call) => call[1] as { direction: string; content: string });
    expect(persisted).toContainEqual(
      expect.objectContaining({ direction: 'input', content: 'open the delivery table' }),
    );

    dispose();
  });

  it('persists the tail of an utterance that kept talking after its window closed', async () => {
    const { store, voice, dispose } = await boot();
    try {
      fire('voice-mode:engine-selected', {
        sessionId: FOCUSED_SESSION,
        engine: 'live',
        fallbackFrom: null,
        reason: '',
        generation: 7,
        workspacePath: '/ws',
      });

      // The renderer half of the late-contiguous-fragment case the engine now
      // splits (see liveAPIClient's "recloses after a late fragment" test). The
      // engine emits a second close under a NEW item id; if the renderer only
      // ever handled one close per utterance, the tail would still be lost and
      // the caption would keep showing text the user already finished saying.
      fire('voice-mode:transcript-delta', { sessionId: FOCUSED_SESSION, delta: 'open', itemId: 'u1' });
      fire('voice-mode:speech-window-closed', {
        sessionId: FOCUSED_SESSION,
        itemId: 'u1',
        transcript: 'open',
      });
      expect(store.get(voice.voiceCurrentUserTextAtom)).toBe('');

      fire('voice-mode:transcript-delta', { sessionId: FOCUSED_SESSION, delta: ' that file', itemId: 'u2' });
      expect(store.get(voice.voiceCurrentUserTextAtom)).toBe(' that file');
      fire('voice-mode:speech-window-closed', {
        sessionId: FOCUSED_SESSION,
        itemId: 'u2',
        transcript: 'that file',
      });

      // Caption cleared, and BOTH halves persisted -- once each, with no
      // duplicated prefix from re-reporting the whole group.
      expect(store.get(voice.voiceCurrentUserTextAtom)).toBe('');
      const persisted = invoke.mock.calls
        .filter((call) => call[0] === 'voice-mode:appendMessage')
        .map((call) => (call[1] as { direction: string; content: string }))
        .filter((entry) => entry.direction === 'input')
        .map((entry) => entry.content);
      expect(persisted).toEqual(['open', 'that file']);
    } finally {
      dispose();
    }
  });

  it('does not supersede a task when a session merely stops to ask a question', async () => {
    const { store, sessions, dispose } = await boot();

    store.set(sessions.sessionProcessingAtom(ASKING_SESSION), true);
    expect(sentOn('voice-mode:task-revision')).toMatchObject([
      { sessionId: ASKING_SESSION, revision: 1 },
    ]);

    // running -> awaitingInput -> running is one run pausing to ask something,
    // not a new request. Counting the resumption as a new revision made the
    // session supersede its own outstanding task, and its result was then
    // never spoken.
    store.set(sessions.sessionHasPendingInteractivePromptAtom(ASKING_SESSION), true);
    store.set(sessions.sessionHasPendingInteractivePromptAtom(ASKING_SESSION), false);
    expect(sentOn('voice-mode:task-revision')).toHaveLength(1);

    // A genuinely new run, after the session went idle, does bump it.
    store.set(sessions.sessionProcessingAtom(ASKING_SESSION), false);
    store.set(sessions.sessionProcessingAtom(ASKING_SESSION), true);
    expect(sentOn('voice-mode:task-revision')).toMatchObject([
      { sessionId: ASKING_SESSION, revision: 1 },
      { sessionId: ASKING_SESSION, revision: 2 },
    ]);

    dispose();
  });

  it('names the conversation and its workspace on every message it sends', async () => {
    const { dispose } = await boot();
    try {
      fire('voice-mode:task-completed', { sessionId: FOCUSED_SESSION, summary: 'Added the column.' });
      // Main will not act on a message that does not name the conversation and
      // the workspace it belongs to, because substituting ambient state for a
      // missing workspace is what let a foreign workspace's content through.
      expect(sentOn('voice-mode:announce-completion')[0]).toMatchObject({
        generation: 7,
        workspacePath: '/ws',
      });
    } finally {
      dispose();
    }
  });

  it('sends nothing about a conversation that has ended', async () => {
    const { dispose } = await boot();
    try {
      fire('voice-mode:stopped', { sessionId: FOCUSED_SESSION });
      await settle();
      send.mockClear();
      fire('voice-mode:task-completed', { sessionId: FOCUSED_SESSION, summary: 'Added the column.' });
      expect(sentOn('voice-mode:announce-completion')).toHaveLength(0);
    } finally {
      dispose();
    }
  });

  it('does not answer a prompt it never announced', async () => {
    const { dispose } = await boot();
    try {
      // A prompt id the controller could have learned from session-summary
      // context rather than from an announcement this device made. Falling back
      // to the session it supplied answered it anyway, bypassing announcement
      // ownership -- and nothing about a tool call is evidence that a human
      // heard a question, let alone consented to an answer.
      fire('voice-mode:respond-to-prompt', {
        sessionId: FOCUSED_SESSION,
        promptId: 'unseen-prompt',
        promptType: 'request_user_input_request',
        response: { answers: { approval: true } },
      });
      expect(
        invoke.mock.calls.filter(([channel]) => channel === 'messages:respond-to-prompt'),
      ).toHaveLength(0);
    } finally {
      dispose();
    }
  });

  it('does not answer a question the user has not been read yet', async () => {
    const { store, sessions, dispose } = await boot();
    try {
      store.set(sessions.sessionPendingPromptsAtom(ASKING_SESSION), [
        {
          id: 'row-1',
          sessionId: ASKING_SESSION,
          promptType: 'ask_user_question_request',
          promptId: 'prompt-1',
          data: { questions: [{ question: 'Pick a column type', options: [{ label: 'text' }] }] },
          createdAt: 10,
        },
      ]);
      store.set(sessions.sessionHasPendingInteractivePromptAtom(ASKING_SESSION), true);
      expect(sentOn('voice-mode:interactive-prompt')).toHaveLength(1);

      // The announcement was issued; no audio has played. The controller
      // answering at this point is the model deciding the question was heard,
      // which is the one thing it cannot know.
      fire('voice-mode:respond-to-prompt', {
        sessionId: ASKING_SESSION,
        promptId: 'prompt-1',
        promptType: 'ask_user_question_request',
        response: { answers: { _voice: 'text' } },
      });
      expect(
        invoke.mock.calls.filter(([channel]) => channel === 'messages:respond-to-prompt'),
      ).toHaveLength(0);

      // Once it has actually been read out, the same answer lands.
      await hearAnnouncement();
      fire('voice-mode:respond-to-prompt', {
        sessionId: ASKING_SESSION,
        promptId: 'prompt-1',
        promptType: 'ask_user_question_request',
        response: { answers: { _voice: 'text' } },
      });
      expect(
        invoke.mock.calls.filter(([channel]) => channel === 'messages:respond-to-prompt'),
      ).toHaveLength(1);
    } finally {
      dispose();
    }
  });

  it('rejects an answer whose type is not the pending prompt\'s', async () => {
    const { store, sessions, dispose } = await boot();
    try {
      store.set(sessions.sessionPendingPromptsAtom(ASKING_SESSION), [
        {
          id: 'row-1',
          sessionId: ASKING_SESSION,
          promptType: 'ask_user_question_request',
          promptId: 'prompt-1',
          data: { questions: [{ question: 'Pick a column type', options: [{ label: 'text' }] }] },
          createdAt: 10,
        },
      ]);
      store.set(sessions.sessionHasPendingInteractivePromptAtom(ASKING_SESSION), true);
      await hearAnnouncement();

      // promptType comes from the controller and used to pick the delivery
      // branch without ever being compared against the prompt it claims to
      // answer, so a question the user was asked could be answered through the
      // approval branch instead.
      fire('voice-mode:respond-to-prompt', {
        sessionId: ASKING_SESSION,
        promptId: 'prompt-1',
        promptType: 'git_commit_proposal_request',
        response: { approved: true },
      });
      expect(invoke.mock.calls.filter(([channel]) => channel === 'git:commit')).toHaveLength(0);
      expect(
        invoke.mock.calls.filter(([channel]) => channel === 'messages:respond-to-prompt'),
      ).toHaveLength(0);

      // The claim was handed back, so the question the user did hear is still
      // answerable -- a rejected answer must not strand it.
      fire('voice-mode:respond-to-prompt', {
        sessionId: ASKING_SESSION,
        promptId: 'prompt-1',
        promptType: 'ask_user_question_request',
        response: { answers: { _voice: 'text' } },
      });
      expect(
        invoke.mock.calls.filter(([channel]) => channel === 'messages:respond-to-prompt'),
      ).toHaveLength(1);
    } finally {
      dispose();
    }
  });

  /**
   * Voice commit approval is a capability the user chose to keep, so the thing
   * worth pinning is the boundary it was kept behind: a spoken "approve" only
   * commits a proposal that was genuinely announced AND genuinely read out.
   * Nothing else here is close to as expensive to get wrong, and an approval
   * for a proposal that was never presented is the regression that would rot
   * silently -- every path to it looks reasonable in isolation.
   */
  describe('commit approval', () => {
    const PROPOSAL = {
      id: 'row-commit',
      sessionId: ASKING_SESSION,
      promptType: 'git_commit_proposal_request' as const,
      promptId: 'prompt-commit',
      data: {
        commitMessage: 'fix: stop the delivery table losing its status column',
        filesToStage: ['src/delivery.ts'],
        workspacePath: '/ws',
      },
      createdAt: 10,
    };

    const approve = (over: Record<string, unknown> = {}): void =>
      fire('voice-mode:respond-to-prompt', {
        sessionId: ASKING_SESSION,
        promptId: 'prompt-commit',
        promptType: 'git_commit_proposal_request',
        response: { approved: true },
        ...over,
      });

    const commits = (): unknown[][] => invoke.mock.calls.filter(([channel]) => channel === 'git:commit');

    it.each([['Committed successfully', undefined], [undefined, 'Auto-commit failed']])(
      'waits for the actual auto-commit outcome instead of asking for approval (%s, %s)',
      async (summary, error) => {
        const { store, sessions, dispose } = await boot();
        try {
          store.set(sessions.sessionPendingPromptsAtom(ASKING_SESSION), [
            { ...PROPOSAL, data: { ...PROPOSAL.data, autoApproved: true } },
          ]);
          store.set(sessions.sessionHasPendingInteractivePromptAtom(ASKING_SESSION), true);
          expect(sentOn('voice-mode:interactive-prompt')).toHaveLength(0);
          expect(sentOn('voice-mode:announce-completion')).toHaveLength(0);
          approve();
          expect(commits()).toHaveLength(0);
          store.set(sessions.sessionPendingPromptsAtom(ASKING_SESSION), []);
          store.set(sessions.sessionHasPendingInteractivePromptAtom(ASKING_SESSION), false);
          fire('voice-mode:task-completed', { sessionId: ASKING_SESSION, summary, error });
          expect(sentOn('voice-mode:announce-completion')).toEqual([
            expect.objectContaining({ summary: expect.stringContaining(summary || error!) }),
          ]);
        } finally {
          dispose();
        }
      },
    );


    it('does not commit a proposal that was never presented', async () => {
      const { store, sessions, dispose } = await boot();
      try {
        // Never announced at all: a prompt id the controller could have picked
        // up from session-summary context.
        approve();
        expect(commits()).toHaveLength(0);

        // Announced, but nothing has been read out. `announcing` is the request
        // to speak having been issued -- the model calling the approve tool at
        // this point is the model deciding the user heard a commit proposal.
        store.set(sessions.sessionPendingPromptsAtom(ASKING_SESSION), [PROPOSAL]);
        store.set(sessions.sessionHasPendingInteractivePromptAtom(ASKING_SESSION), true);
        expect(sentOn('voice-mode:interactive-prompt')).toHaveLength(1);
        approve();
        expect(commits()).toHaveLength(0);

        // Read out, and audibly finished. Now the approval is accepted: this is
        // the capability, and the test would be worthless without pinning that
        // the gate still lets it through.
        await hearAnnouncement();
        approve();
        expect(commits()).toHaveLength(1);
      } finally {
        dispose();
      }
    });

    it('commits the proposal\'s own workspace and files, not the ones sent with the answer', async () => {
      const { store, sessions, dispose } = await boot();
      try {
        store.set(sessions.sessionPendingPromptsAtom(ASKING_SESSION), [PROPOSAL]);
        store.set(sessions.sessionHasPendingInteractivePromptAtom(ASKING_SESSION), true);
        await hearAnnouncement();

        // Everything but `approved` in the answer is ignored. Reading any of it
        // would let an approval the user did give be redirected at another
        // project, other files, or another message.
        approve({
          response: {
            approved: true,
            workspacePath: '/somewhere-else',
            filesToStage: ['.env'],
            commitMessage: 'chore: unrelated',
          },
        });

        expect(commits()).toHaveLength(1);
        expect(commits()[0]).toEqual([
          'git:commit',
          '/ws',
          PROPOSAL.data.commitMessage,
          ['src/delivery.ts'],
          ASKING_SESSION,
          undefined,
          undefined,
          PROPOSAL.promptId,
        ]);
      } finally {
        dispose();
      }
    });

    it('does not commit on an answer that is neither approve nor reject', async () => {
      const { store, sessions, dispose } = await boot();
      try {
        store.set(sessions.sessionPendingPromptsAtom(ASKING_SESSION), [PROPOSAL]);
        store.set(sessions.sessionHasPendingInteractivePromptAtom(ASKING_SESSION), true);
        await hearAnnouncement();

        // Not a decision. The branch reads anything that is not `approved: true`
        // as a cancellation, so accepting this would quietly discard a proposal
        // the user was read.
        approve({ response: { answers: { _voice: 'sure' } } });
        expect(commits()).toHaveLength(0);
        expect(
          invoke.mock.calls.filter(([channel]) => channel === 'messages:respond-to-prompt'),
        ).toHaveLength(0);

        // The claim went back, so a real decision still lands.
        approve({ response: { approved: false } });
        expect(commits()).toHaveLength(0);
        expect(
          invoke.mock.calls.filter(([channel]) => channel === 'messages:respond-to-prompt'),
        ).toMatchObject([[
          'messages:respond-to-prompt',
          { promptId: 'prompt-commit', response: { action: 'cancelled' } },
        ]]);
      } finally {
        dispose();
      }
    });
  });

  it('clears announcing and presented questions when voice is turned off', async () => {
    const { store, sessions, voice, dispose } = await boot();
    try {
      store.set(sessions.sessionPendingPromptsAtom(ASKING_SESSION), [
        {
          id: 'row-1',
          sessionId: ASKING_SESSION,
          promptType: 'ask_user_question_request',
          promptId: 'prompt-1',
          data: { questions: [{ question: 'Pick a column type', options: [{ label: 'text' }] }] },
          createdAt: 10,
        },
      ]);
      store.set(sessions.sessionHasPendingInteractivePromptAtom(ASKING_SESSION), true);
      expect(sentOn('voice-mode:interactive-prompt')).toHaveLength(1);

      // Voice off, then on again. Cleanup dropped only announcement
      // *candidates*, so this question survived in its announcing state and
      // went on holding the next conversation's floor -- every completion after
      // it stayed silent.
      fire('voice-mode:stopped', { sessionId: FOCUSED_SESSION });
      await settle();

      // Voice on again, same listeners: a fresh conversation with a fresh
      // claim.
      store.set(voice.voiceActiveSessionIdAtom, FOCUSED_SESSION);
      store.set(voice.voiceWorkspacePathAtom, '/ws');
      store.set(voice.voiceListenStateAtom, 'listening');
      fire('voice-mode:engine-selected', {
        sessionId: FOCUSED_SESSION,
        engine: 'realtime',
        fallbackFrom: null,
        reason: '',
        generation: 8,
        workspacePath: '/ws',
      });
      send.mockClear();
      fire('voice-mode:task-completed', { sessionId: FOCUSED_SESSION, summary: 'Added the column.' });
      expect(sentOn('voice-mode:announce-completion')).toHaveLength(1);
    } finally {
      dispose();
    }
  });
});
