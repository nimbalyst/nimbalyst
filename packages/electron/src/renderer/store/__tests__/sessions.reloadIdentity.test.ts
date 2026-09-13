// @vitest-environment node
import { describe, it, expect } from 'vitest';
import type { SessionData, TranscriptViewMessage } from '@nimbalyst/runtime/ai/server/types';
import { preserveReloadIdentity, sessionRegistryAtom, sessionListRootAtom, sessionListWorkspaceAtom } from '../atoms/sessions';
import {createStore} from 'jotai';
import {selectedMachineAtom} from '../atoms/remoteMachines';

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
