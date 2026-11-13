// @vitest-environment node
import { afterEach, describe, it, expect, vi } from 'vitest';
import type { SessionData, TranscriptViewMessage } from '@nimbalyst/runtime/ai/server/types';
import { loadSessionDataAtom, reloadSessionDataAtom, sessionStoreAtom, preserveReloadIdentity, sessionRegistryAtom, sessionListRootAtom, sessionListWorkspaceAtom, updateSessionStoreAtom } from '../atoms/sessions';
import {createStore} from 'jotai';
import {selectedMachineAtom} from '../atoms/remoteMachines';
import { TranscriptProjector } from '@nimbalyst/runtime/ai/server/transcript/TranscriptProjector';
import type { TranscriptEvent } from '@nimbalyst/runtime/ai/server/transcript/types';
import { warnOnDuplicateUserPrompt } from '../transcriptReconciliation';

function makeMessage(id: number, text: string): TranscriptViewMessage {
  return {
    id,
    sequence: id,
    createdAt: new Date(0),
    type: 'assistant_message',
    text,
    subagentId: null,
  };
}

/** Payloads of the #919 duplicate-prompt diagnostic caught by a console.warn spy. */
const duplicateWarnings = (warn: { mock: { calls: unknown[][] } }) => warn.mock.calls
  .map(([line]) => String(line))
  .filter((line) => line.includes('Duplicate user prompt'))
  .map((line) => JSON.parse(line.slice(line.indexOf('{'))));

function makeSession(overrides: Partial<SessionData> = {}): SessionData {
  return {
    id: 'session-1',
    provider: 'claude-code',
    messages: [makeMessage(1, 'hello')],
    createdAt: 1,
    updatedAt: 2,
    metadata: {},
    ...overrides,
  };
}

describe('preserveReloadIdentity', () => {
  it('preserves surviving row identities through append, removal and reorder', () => {
    const messages = [makeMessage(1, 'one'), makeMessage(2, 'two')];
    const appended = preserveReloadIdentity(makeSession({ messages }), makeSession({
      messages: [makeMessage(1, 'one'), makeMessage(2, 'two'), makeMessage(3, 'three')],
    }));
    expect(appended.messages[0]).toBe(messages[0]);
    expect(appended.messages[1]).toBe(messages[1]);
    const reordered = preserveReloadIdentity(appended, makeSession({
      messages: [makeMessage(3, 'three'), makeMessage(1, 'one')],
    }));
    expect(reordered.messages.map(m => m.id)).toEqual([3, 1]);
    expect(reordered.messages[0]).toBe(appended.messages[2]);
    expect(reordered.messages[1]).toBe(messages[0]);
  });

  it('does not reuse a row from a replaced transcript generation', () => {
    const old = { ...makeMessage(1, 'same'), transcriptGeneration: 1 };
    const replacement = { ...makeMessage(1, 'same'), transcriptGeneration: 2 };
    const result = preserveReloadIdentity(makeSession({ messages: [old] }), makeSession({ messages: [replacement] }));
    expect(result.messages[0]).toBe(replacement);
  });

  it('reuses the existing messages array when reloaded content is identical', () => {
    const currentMessages = [makeMessage(1, 'hello')];
    const current = makeSession({ messages: currentMessages });
    const next = makeSession({ messages: [makeMessage(1, 'hello')], updatedAt: 999 });

    const merged = preserveReloadIdentity(current, next);

    expect(merged.messages).toBe(currentMessages);
    expect(merged.updatedAt).toBe(999);
  });

  it('keeps the new content when transcript content actually changed', () => {
    const currentMessages = [makeMessage(1, 'hello')];
    const nextMessages = [makeMessage(1, 'hello world')];
    const current = makeSession({ messages: currentMessages });
    const next = makeSession({ messages: nextMessages, updatedAt: 999 });

    const merged = preserveReloadIdentity(current, next);

    expect(merged.messages).not.toBe(currentMessages);
    expect(merged.messages?.[0].text).toBe('hello world');
  });

  it('preserves identity for unchanged messages when only one differs', () => {
    const stableMessages = [makeMessage(1, 'hello'), makeMessage(2, 'world')];
    const currentMessages = [stableMessages[0], stableMessages[1], makeMessage(3, 'optimistic')];
    const nextMessages = [makeMessage(1, 'hello'), makeMessage(2, 'world'), makeMessage(3, 'persisted')];
    const current = makeSession({ messages: currentMessages });
    const next = makeSession({ messages: nextMessages });

    const merged = preserveReloadIdentity(current, next);

    // Outer array must be a new ref (one element differs)
    expect(merged.messages).not.toBe(currentMessages);
    expect(merged.messages).not.toBe(nextMessages);
    // First two messages keep their current refs (virtualized row memos bail)
    expect(merged.messages?.[0]).toBe(currentMessages[0]);
    expect(merged.messages?.[1]).toBe(currentMessages[1]);
    // Last message is the new persisted one
    expect(merged.messages?.[2]).toBe(nextMessages[2]);
  });

  it('reuses currentTeammates when metadata content is identical', () => {
    const currentTeammates = [{ agentId: 'agent-1', status: 'running' as const }];
    const current = makeSession({
      metadata: {
        currentTeammates,
        sessionStatus: 'running',
      },
    });
    const next = makeSession({
      metadata: {
        currentTeammates: [{ agentId: 'agent-1', status: 'running' as const }],
        sessionStatus: 'running',
      },
      updatedAt: 999,
    });

    const merged = preserveReloadIdentity(current, next);

    expect(merged.metadata?.currentTeammates).toBe(currentTeammates);
    expect(merged.metadata?.sessionStatus).toBe('running');
  });
});


describe('machine-scoped session lists', () => {
  it('keeps the local and remote session groups separate for the same project', () => {
    const store = createStore();
    store.set(sessionListWorkspaceAtom, '/repo');
    store.set(sessionRegistryAtom, new Map([
      ['local', {id: 'local', createdAt: 1, updatedAt: 1}],
      ['remote', {id: 'remote', createdAt: 2, updatedAt: 2, remoteHostDeviceId: 'sandbox'}],
      ['other', {id: 'other', createdAt: 3, updatedAt: 3, remoteHostDeviceId: 'another-machine'}],
    ]) as any);
    expect(store.get(sessionListRootAtom).map(session => session.id)).toEqual(['local']);
    store.set(selectedMachineAtom('/repo'), 'sandbox');
    expect(store.get(sessionListRootAtom).map(session => session.id)).toEqual(['remote']);
    store.set(selectedMachineAtom('/repo'), '');
    expect(store.get(sessionListRootAtom).map(session => session.id)).toEqual(['local']);
  });
});

describe('updateSessionStoreAtom registry identity', () => {
  // Token usage arrives every assistant step; a new registry Map repaints the
  // session list and every session reference in open transcripts.
  it('keeps the registry Map for updates with no registry fields', () => {
    const store = createStore();
    store.set(sessionStoreAtom('session-1'), makeSession());
    store.set(sessionRegistryAtom, new Map([['session-1', {id: 'session-1', createdAt: 1, updatedAt: 2}]]) as any);
    const registry = store.get(sessionRegistryAtom);

    store.set(updateSessionStoreAtom, {sessionId: 'session-1', updates: {tokenUsage: {inputTokens: 1, outputTokens: 2, totalTokens: 3}}});
    expect(store.get(sessionRegistryAtom)).toBe(registry);
    expect(store.get(sessionStoreAtom('session-1'))?.tokenUsage?.totalTokens).toBe(3);

    store.set(updateSessionStoreAtom, {sessionId: 'session-1', updates: {title: 'Renamed'}});
    expect(store.get(sessionRegistryAtom).get('session-1')?.title).toBe('Renamed');
  });

  // #919 diagnostic: optimistic sends replace the list from a component's copy.
  it('warns once when a messages update holds a duplicated user prompt', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const store = createStore();
      const id = 'duplicate-prompt-update';
      const prompt = { ...makeMessage(1, 'Audit the repo'), type: 'user_message' as const };
      store.set(sessionStoreAtom(id), makeSession({ id, messages: [prompt] }));
      store.set(updateSessionStoreAtom, {sessionId: id, updates: {messages: [prompt, makeMessage(2, 'Working')]}});
      expect(duplicateWarnings(warn)).toEqual([]);
      const copy = { ...prompt, id: -5, sequence: 3 };
      store.set(updateSessionStoreAtom, {sessionId: id, updates: {messages: [prompt, makeMessage(2, 'Working'), copy]}});
      store.set(updateSessionStoreAtom, {sessionId: id, updates: {messages: [prompt, makeMessage(2, 'Working'), copy]}});
      expect(duplicateWarnings(warn)).toEqual([{
        sessionId: id, mergePath: 'update', length: 3, ids: [1, -5], indices: [0, 2],
        transcriptGenerations: [null, null], sequences: [1, 3], createdAt: [0, 0],
      }]);
    } finally {
      warn.mockRestore();
    }
  });
});

// #919 diagnostic: which lists count as a duplicated prompt. The guard is
// per session, so each test uses its own session id.
describe('warnOnDuplicateUserPrompt matching rule', () => {
  const user = (id: number, text: string, at: number, extra: Partial<TranscriptViewMessage> = {}): TranscriptViewMessage =>
    ({ id, sequence: id, transcriptGeneration: 3, createdAt: new Date(at), type: 'user_message', text, subagentId: null, ...extra });
  const reply = (id: number, at: number): TranscriptViewMessage =>
    ({ id, sequence: id, transcriptGeneration: 3, createdAt: new Date(at), type: 'assistant_message', text: 'ok', subagentId: null });
  const optimistic = { sequence: -1, optimistic: true, transcriptGeneration: undefined };

  it('stays silent for repeated sends, an optimistic re-send after its saved twin, and repeated system prompts', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const id = 'duplicate-rule-repeats';
      warnOnDuplicateUserPrompt(id, 'reload', [user(1, 'continue', 1000), reply(2, 1100), user(3, 'continue', 2000), reply(4, 2100), user(5, 'continue', 3000)]);
      warnOnDuplicateUserPrompt(id, 'update', [user(1, 'continue', 1000), reply(2, 1100), user(-7, 'continue', 2000, optimistic)]);
      warnOnDuplicateUserPrompt(id, 'stream', [user(1, 'Answered', 1000, { promptActor: 'system' }), reply(2, 1100), user(3, 'Answered', 2000, { promptActor: 'system' })]);
      expect(duplicateWarnings(warn)).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });

  it('stays silent for tool calls and replies that share a raw row\'s time and have no text', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const tool = (id: number): TranscriptViewMessage =>
        ({ id, sequence: id, transcriptGeneration: 3, createdAt: new Date(2000), type: 'tool_call', subagentId: null });
      warnOnDuplicateUserPrompt('duplicate-rule-tools', 'stream', [user(1, 'Audit', 1000), tool(2), tool(3), reply(4, 2000), reply(5, 2000)]);
      expect(duplicateWarnings(warn)).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });

  it('reports the same saved prompt id twice, even when the copies differ in time', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const id = 'duplicate-rule-same-id';
      warnOnDuplicateUserPrompt(id, 'update', [user(1, 'Audit', 1000), reply(2, 1100), user(1, 'Audit', 1000, { transcriptGeneration: 4 })]);
      warnOnDuplicateUserPrompt(id, 'update', [user(1, 'Audit', 1000), reply(2, 1100), user(1, 'Audit', 999, { transcriptGeneration: 2 })]);
      expect(duplicateWarnings(warn).map((w) => [w.ids, w.transcriptGenerations])).toEqual([[[1, 1], [3, 4]], [[1, 1], [3, 2]]]);
    } finally {
      warn.mockRestore();
    }
  });
});


describe('canonical generation load/reload reconciliation', () => {
  afterEach(() => vi.unstubAllGlobals());
  const message = (
    id: number,
    sequence: number,
    generation: number,
    text = 'Repeated text',
  ): TranscriptViewMessage => ({
    ...makeMessage(id, text),
    sequence,
    transcriptGeneration: generation,
  });
  for (const name of ['load', 'reload'] as const) {
    const run = (
      store: ReturnType<typeof createStore>,
      payload: { sessionId: string; workspacePath: string },
    ) =>
      name === 'load'
        ? store.set(loadSessionDataAtom, payload)
        : store.set(reloadSessionDataAtom, payload);
    it.each([
      {
        variant: 'appended context',
        saved:
          'Repeat request\n\n<NIMBALYST_SYSTEM_MESSAGE>Document context</NIMBALYST_SYSTEM_MESSAGE>',
        optimistic: 'Repeat request',
        age: 294,
        acknowledged: true,
      },
      {
        variant: 'prepended context',
        saved: '<NIMBALYST_SYSTEM_MESSAGE>Instructions</NIMBALYST_SYSTEM_MESSAGE>\nRepeat request',
        optimistic: 'Repeat request',
        age: 294,
        acknowledged: true,
      },
      {
        variant: 'multiple blocks',
        saved:
          '<NIMBALYST_SYSTEM_MESSAGE>One</NIMBALYST_SYSTEM_MESSAGE>\nRepeat<NIMBALYST_SYSTEM_MESSAGE>Two</NIMBALYST_SYSTEM_MESSAGE> request\n<NIMBALYST_SYSTEM_MESSAGE>Three</NIMBALYST_SYSTEM_MESSAGE>',
        optimistic: 'Repeat request',
        age: 294,
        acknowledged: true,
      },
      {
        variant: 'wrapped optimistic',
        saved: 'Repeat request',
        optimistic:
          '  Repeat request\n<NIMBALYST_SYSTEM_MESSAGE>Local context</NIMBALYST_SYSTEM_MESSAGE> ',
        age: 294,
        acknowledged: true,
      },
      {
        variant: 'different visible suffix',
        saved:
          'Repeat request with another instruction\n<NIMBALYST_SYSTEM_MESSAGE>Context</NIMBALYST_SYSTEM_MESSAGE>',
        optimistic: 'Repeat request',
        age: 294,
        acknowledged: false,
      },
      {
        variant: 'incomplete context tag',
        saved: 'Repeat request\n<NIMBALYST_SYSTEM_MESSAGE>unfinished',
        optimistic: 'Repeat request',
        age: 294,
        acknowledged: false,
      },
      {
        // #1620: slow turn setup saves the prompt long after send.
        variant: 'saved long after send',
        saved: 'Repeat request\n<NIMBALYST_SYSTEM_MESSAGE>Context</NIMBALYST_SYSTEM_MESSAGE>',
        optimistic: 'Repeat request',
        age: 8000,
        acknowledged: true,
      },
      {
        variant: 'saved before send',
        saved: 'Repeat request',
        optimistic: 'Repeat request',
        age: 294,
        sentAt: 1000,
        acknowledged: false,
      },
    ])(
      `${name} acknowledges context-normalized input: $variant`,
      async ({ variant, saved, optimistic, age, sentAt = 0, acknowledged }) => {
        const store = createStore();
        const id = `optimistic-context-${name}-${variant}`;
        const pendingInput = {
          ...makeMessage(-4, optimistic),
          type: 'user_message' as const,
          createdAt: new Date(sentAt),
        };
        const canonical = {
          ...message(7369, 241, 99, saved),
          type: 'user_message' as const,
          createdAt: new Date(age),
        };
        store.set(sessionStoreAtom(id), makeSession({ id, messages: [pendingInput] }));
        vi.stubGlobal('window', {
          electronAPI: {
            aiLoadSession: vi
              .fn()
              .mockResolvedValue(makeSession({ id, model: 'claude:test', messages: [canonical] })),
          },
        });
        await run(store, { sessionId: id, workspacePath: '/repo' });
        const messages = store.get(sessionStoreAtom(id))!.messages;
        expect(messages.map((m) => m.id)).toEqual(acknowledged ? [7369] : [7369, -4]);
        expect(messages[0].text).toBe(saved);
        expect(canonical.text).toBe(saved);
        expect(pendingInput.text).toBe(optimistic);
      },
    );
    it(`${name} consumes enriched acknowledgments once without deduplicating legitimate repeated sends`, async () => {
      const store = createStore();
      const id = `optimistic-context-repeat-${name}`;
      const saved = 'yes\n\n<NIMBALYST_SYSTEM_MESSAGE>Document context</NIMBALYST_SYSTEM_MESSAGE>';
      const first = {
        ...message(10, 0, 99, saved),
        type: 'user_message' as const,
        createdAt: new Date(294),
      };
      const second = { ...first, id: 11, sequence: 1, createdAt: new Date(700) };
      const pendingInputs = [-1, -2].map((id) => ({
        ...makeMessage(id, 'yes'),
        type: 'user_message' as const,
      }));
      let snapshot = [first];
      vi.stubGlobal('window', {
        electronAPI: {
          aiLoadSession: vi.fn(async () =>
            makeSession({ id, model: 'claude:test', messages: snapshot }),
          ),
        },
      });
      store.set(sessionStoreAtom(id), makeSession({ id, messages: pendingInputs }));
      await run(store, { sessionId: id, workspacePath: '/repo' });
      expect(store.get(sessionStoreAtom(id))!.messages.map((m) => m.id)).toEqual([10, -2]);
      await run(store, { sessionId: id, workspacePath: '/repo' });
      expect(store.get(sessionStoreAtom(id))!.messages.map((m) => m.id)).toEqual([10, -2]);
      snapshot = [first, second];
      await run(store, { sessionId: id, workspacePath: '/repo' });
      expect(store.get(sessionStoreAtom(id))!.messages.map((m) => m.id)).toEqual([10, 11]);
      expect(store.get(sessionStoreAtom(id))!.messages.map((m) => m.text)).toEqual([saved, saved]);
    });

    it(`${name} recovers an existing enriched optimistic duplicate on generation replacement`, async () => {
      const store = createStore();
      const id = `optimistic-context-recovery-${name}`;
      const saved =
        'Repeat request\n\n<NIMBALYST_SYSTEM_MESSAGE>Document context</NIMBALYST_SYSTEM_MESSAGE>';
      const canonical = {
        ...message(10, 0, 98, saved),
        type: 'user_message' as const,
        createdAt: new Date(294),
      };
      const optimistic = { ...makeMessage(-4, 'Repeat request'), type: 'user_message' as const };
      let snapshot = [canonical];
      vi.stubGlobal('window', {
        electronAPI: {
          aiLoadSession: vi.fn(async () =>
            makeSession({ id, model: 'claude:test', messages: snapshot }),
          ),
        },
      });
      store.set(sessionStoreAtom(id), makeSession({ id, messages: [canonical, optimistic] }));
      await run(store, { sessionId: id, workspacePath: '/repo' });
      expect(store.get(sessionStoreAtom(id))!.messages.map((m) => m.id)).toEqual([10, -4]);
      snapshot = [{ ...canonical, id: 20, transcriptGeneration: 99 }];
      await run(store, { sessionId: id, workspacePath: '/repo' });
      expect(store.get(sessionStoreAtom(id))!.messages.map((m) => m.id)).toEqual([20]);
      expect(store.get(sessionStoreAtom(id))!.messages[0].text).toBe(saved);
    });

    // #1663: no saved row ever acknowledges a local error, so it stayed pinned
    // below every later turn and kept re-mounting the login card.
    it(`${name} keeps a local error row only until a later turn is saved`, async () => {
      const store = createStore();
      const id = `optimistic-error-${name}`;
      const prompt = {
        ...message(1, 0, 7, 'First request'),
        type: 'user_message' as const,
        createdAt: new Date(1000),
      };
      const localError: TranscriptViewMessage = {
        ...makeMessage(-7, 'Error: OAuth token has expired'),
        type: 'system_message',
        createdAt: new Date(2000),
        isError: true,
        isAuthError: true,
        systemMessage: { systemType: 'error' },
      };
      let snapshot: TranscriptViewMessage[] = [prompt];
      vi.stubGlobal('window', {
        electronAPI: {
          aiLoadSession: vi.fn(async () =>
            makeSession({ id, model: 'claude:test', messages: snapshot }),
          ),
        },
      });
      store.set(sessionStoreAtom(id), makeSession({ id, messages: [prompt, localError] }));
      await run(store, { sessionId: id, workspacePath: '/repo' });
      expect(store.get(sessionStoreAtom(id))!.messages.map((m) => m.id)).toEqual([1, -7]);
      snapshot = [
        prompt,
        { ...message(2, 1, 7, 'Second request'), type: 'user_message', createdAt: new Date(3000) },
        { ...message(3, 2, 7, 'Answer'), createdAt: new Date(4000) },
      ];
      await run(store, { sessionId: id, workspacePath: '/repo' });
      expect(store.get(sessionStoreAtom(id))!.messages.map((m) => m.id)).toEqual([1, 2, 3]);
    });
    // #1608: a copy no saved row acknowledges (its send failed, or a retry of
    // the same text was matched to the failed copy instead) stayed pinned below
    // every later turn. Sends are serial, so an answered later prompt retires it.
    it.each([
      { variant: 'a failed send', copies: [2000], laterText: 'Next request' },
      { variant: 'a retried send', copies: [2000, 2500], laterText: '/compact' },
      { variant: 'a reply with an unparseable time', copies: [2000], laterText: 'Next request', malformed: true },
    ])(`${name} retires an unacknowledged prompt copy once a later prompt is answered: $variant`, async ({ variant, copies, laterText, malformed }) => {
      const store = createStore();
      const id = `optimistic-orphan-${name}-${variant}`;
      const prompt = {
        ...message(1, 0, 7, 'First request'),
        type: 'user_message' as const,
        createdAt: new Date(1000),
      };
      const pending = copies.map((time, i) => ({
        ...makeMessage(-7 - i, '/compact'),
        type: 'user_message' as const,
        createdAt: new Date(time),
      }));
      let snapshot: TranscriptViewMessage[] = [prompt];
      vi.stubGlobal('window', {
        electronAPI: {
          aiLoadSession: vi.fn(async () =>
            makeSession({ id, model: 'claude:test', messages: snapshot }),
          ),
        },
      });
      store.set(sessionStoreAtom(id), makeSession({ id, messages: [prompt, ...pending] }));
      await run(store, { sessionId: id, workspacePath: '/repo' });
      expect(store.get(sessionStoreAtom(id))!.messages.map((m) => m.id)).toEqual([1, ...pending.map((m) => m.id)]);
      snapshot = [
        prompt,
        { ...message(2, 1, 7, laterText), type: 'user_message', createdAt: new Date(3000) },
        { ...message(3, 2, 7, 'Answer'), createdAt: new Date(4000) },
        ...(malformed
          ? [{ ...message(4, 3, 7, 'Note'), createdAt: 'not a date' as unknown as Date }]
          : []),
      ];
      await run(store, { sessionId: id, workspacePath: '/repo' });
      expect(store.get(sessionStoreAtom(id))!.messages.map((m) => m.id)).toEqual(
        malformed ? [1, 2, 3, 4] : [1, 2, 3],
      );
    });
    // The copy of a prompt sent after an answered turn is still waiting on its
    // saved row (slow turn setup, #1620); the answered earlier prompt must not
    // retire it.
    it(`${name} keeps a prompt copy sent after an answered turn until its saved row arrives`, async () => {
      const store = createStore();
      const id = `optimistic-waiting-${name}`;
      const answered: TranscriptViewMessage[] = [
        { ...message(1, 0, 7, 'First request'), type: 'user_message', createdAt: new Date(3000) },
        { ...message(2, 1, 7, 'Answer'), createdAt: new Date(4000) },
      ];
      const copy = { ...makeMessage(-9, 'Slow request'), type: 'user_message' as const, createdAt: new Date(5000) };
      let snapshot = answered;
      vi.stubGlobal('window', {
        electronAPI: {
          aiLoadSession: vi.fn(async () =>
            makeSession({ id, model: 'claude:test', messages: snapshot }),
          ),
        },
      });
      store.set(sessionStoreAtom(id), makeSession({ id, messages: [...answered, copy] }));
      await run(store, { sessionId: id, workspacePath: '/repo' });
      expect(store.get(sessionStoreAtom(id))!.messages.map((m) => m.id)).toEqual([1, 2, -9]);
      snapshot = [
        ...answered,
        { ...message(3, 2, 7, 'Slow request'), type: 'user_message', createdAt: new Date(6000) },
      ];
      await run(store, { sessionId: id, workspacePath: '/repo' });
      expect(store.get(sessionStoreAtom(id))!.messages.map((m) => m.id)).toEqual([1, 2, 3]);
    });
    it(`${name} rejects an older snapshot arriving after newer streamed messages`, async () => {
      const store = createStore();
      const id = `generation-stale-${name}`;
      let resolve!: (session: SessionData) => void;
      vi.stubGlobal('window', {
        electronAPI: {
          aiLoadSession: vi.fn(
            () =>
              new Promise<SessionData>((r) => {
                resolve = r;
              }),
          ),
        },
      });
      store.set(sessionStoreAtom(id), makeSession({ id, messages: [message(10, 0, 1)] }));
      const pending = run(store, { sessionId: id, workspacePath: '/repo' });
      const live = [message(20, 0, 2), message(21, 1, 2)];
      store.set(sessionStoreAtom(id), makeSession({ id, messages: live }));
      resolve(makeSession({ id, model: 'claude:test', messages: [message(10, 0, 1)] }));
      await pending;
      expect(store.get(sessionStoreAtom(id))?.messages).toEqual(live);
    });
    it(`${name} preserves a same-generation streaming tail and unmatched optimistic input`, async () => {
      const store = createStore();
      const id = `generation-tail-${name}`;
      let resolve!: (session: SessionData) => void;
      vi.stubGlobal('window', {
        electronAPI: {
          aiLoadSession: vi.fn(
            () =>
              new Promise<SessionData>((r) => {
                resolve = r;
              }),
          ),
        },
      });
      store.set(sessionStoreAtom(id), makeSession({ id, messages: [message(90, 0, 3)] }));
      const pending = run(store, { sessionId: id, workspacePath: '/repo' });
      const optimistic = {
        ...makeMessage(-1, 'Pending user request'),
        type: 'user_message' as const,
      };
      store.set(
        sessionStoreAtom(id),
        makeSession({
          id,
          messages: [message(90, 0, 3, 'Updated while loading'), message(80, 1, 3), optimistic],
        }),
      );
      resolve(makeSession({ id, model: 'claude:test', messages: [message(90, 0, 3)] }));
      await pending;
      expect(store.get(sessionStoreAtom(id))?.messages.map((m) => m.id)).toEqual([90, 80, -1]);
      expect(store.get(sessionStoreAtom(id))?.messages[0].text).toBe('Updated while loading');
    });
    it(`${name} replaces a split baseline with the actual fused projection while preserving a post-request tail`, async () => {
      const store = createStore();
      const id = `generation-fused-${name}`;
      const events: TranscriptEvent[] = ['A', 'B'].map((text, index) => ({
        id: index + 1,
        sessionId: id,
        sequence: index,
        createdAt: new Date(index),
        eventType: 'assistant_message',
        searchableText: text,
        payload: { mode: 'agent' },
        parentEventId: null,
        searchable: true,
        subagentId: null,
        provider: 'openai-codex',
        providerToolCallId: null,
        transcriptGeneration: 5,
      }));
      const split = events.flatMap((event) => TranscriptProjector.project([event]).messages);
      const fused = TranscriptProjector.project(events).messages;
      expect(fused.map((m) => m.text)).toEqual(['AB']);
      let resolve!: (session: SessionData) => void;
      vi.stubGlobal('window', {
        electronAPI: {
          aiLoadSession: vi.fn(
            () =>
              new Promise<SessionData>((r) => {
                resolve = r;
              }),
          ),
        },
      });
      store.set(sessionStoreAtom(id), makeSession({ id, messages: split }));
      const pending = run(store, { sessionId: id, workspacePath: '/repo' });
      const tail = { ...message(3, 2, 5, 'New request'), type: 'user_message' as const };
      store.set(sessionStoreAtom(id), makeSession({ id, messages: [...split, tail] }));
      resolve(makeSession({ id, model: 'claude:test', messages: fused }));
      await pending;
      expect(store.get(sessionStoreAtom(id))?.messages.map((m) => m.text)).toEqual([
        'AB',
        'New request',
      ]);
    });
    // #919 diagnostic: the saved first prompt showed a second time under load.
    it(`${name} warns once for a duplicated user prompt, naming the ${name} path`, async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const store = createStore();
        const id = `duplicate-prompt-${name}`;
        const prompt = (msgId: number, sequence: number) =>
          ({ ...message(msgId, sequence, 3, 'Audit the repo'), type: 'user_message' as const, createdAt: new Date(500) });
        const normal = [prompt(1, 0), message(2, 1, 3)];
        let snapshot = normal;
        store.set(sessionStoreAtom(id), makeSession({ id, messages: [] }));
        vi.stubGlobal('window', {
          electronAPI: { aiLoadSession: vi.fn(async () => makeSession({ id, model: 'claude:test', messages: snapshot })) },
        });
        await run(store, { sessionId: id, workspacePath: '/repo' });
        expect(duplicateWarnings(warn)).toEqual([]);

        snapshot = [...normal, prompt(9, 2)];
        await run(store, { sessionId: id, workspacePath: '/repo' });
        await run(store, { sessionId: id, workspacePath: '/repo' });
        expect(store.get(sessionStoreAtom(id))?.messages.map((m) => m.id)).toEqual([1, 2, 9]);
        expect(duplicateWarnings(warn)).toEqual([{
          sessionId: id, mergePath: name, length: 3, ids: [1, 9], indices: [0, 2],
          transcriptGenerations: [3, 3], sequences: [0, 2], createdAt: [500, 500],
        }]);
      } finally {
        warn.mockRestore();
      }
    });
    it(`${name} treats an untagged empty result as no authority to remove tagged live data`, async () => {
      const store = createStore();
      const id = `generation-empty-${name}`;
      const live = [message(30, 0, 4)];
      store.set(sessionStoreAtom(id), makeSession({ id, messages: live }));
      vi.stubGlobal('window', {
        electronAPI: {
          aiLoadSession: vi
            .fn()
            .mockResolvedValue(makeSession({ id, model: 'claude:test', messages: [] })),
        },
      });
      await run(store, { sessionId: id, workspacePath: '/repo' });
      expect(store.get(sessionStoreAtom(id))?.messages).toEqual(live);
    });
    it(`${name} retires old generations but preserves legitimate repeated canonical text`, async () => {
      const store = createStore();
      const id = `generation-new-${name}`;
      store.set(sessionStoreAtom(id), makeSession({ id, messages: [message(10, 0, 1)] }));
      const newer = [message(90, 0, 2), message(80, 1, 2)];
      vi.stubGlobal('window', {
        electronAPI: {
          aiLoadSession: vi
            .fn()
            .mockResolvedValue(makeSession({ id, model: 'claude:test', messages: newer })),
        },
      });
      await run(store, { sessionId: id, workspacePath: '/repo' });
      expect(store.get(sessionStoreAtom(id))?.messages).toEqual(newer);
    });
  }
});
