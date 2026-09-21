// @vitest-environment node
import { afterEach, describe, it, expect, vi } from 'vitest';
import type { SessionData, TranscriptViewMessage } from '@nimbalyst/runtime/ai/server/types';
import { loadSessionDataAtom, reloadSessionDataAtom, sessionStoreAtom, preserveReloadIdentity, sessionRegistryAtom, sessionListRootAtom, sessionListWorkspaceAtom } from '../atoms/sessions';
import {createStore} from 'jotai';
import {selectedMachineAtom} from '../atoms/remoteMachines';
import { TranscriptProjector } from '@nimbalyst/runtime/ai/server/transcript/TranscriptProjector';
import type { TranscriptEvent } from '@nimbalyst/runtime/ai/server/transcript/types';

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
        variant: 'five-second boundary',
        saved: 'Repeat request\n<NIMBALYST_SYSTEM_MESSAGE>Context</NIMBALYST_SYSTEM_MESSAGE>',
        optimistic: 'Repeat request',
        age: 5000,
        acknowledged: false,
      },
    ])(
      `${name} acknowledges context-normalized input: $variant`,
      async ({ variant, saved, optimistic, age, acknowledged }) => {
        const store = createStore();
        const id = `optimistic-context-${name}-${variant}`;
        const pendingInput = { ...makeMessage(-4, optimistic), type: 'user_message' as const };
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
