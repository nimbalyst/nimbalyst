// @vitest-environment jsdom
import React from 'react';
import { Provider } from 'jotai';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@nimbalyst/runtime', async () => {
  const { atom } = await import('jotai');
  return {
    MaterialSymbol: () => null,
    ProviderIcon: () => null,
    copyToClipboard: vi.fn(),
    sessionRefMapAtom: atom(new Map()),
  };
});
vi.mock('../SessionContextMenu', () => ({ SessionContextMenu: () => null }));
vi.mock('../SessionRelativeTime', () => ({ SessionRelativeTime: () => null }));

import { WorkstreamGroup } from '../WorkstreamGroup';
import {
  sessionProcessingAtom,
  sessionRegistryAtom,
  sessionStoreAtom,
  store,
  type SessionMeta,
} from '../../../store';
import { initSessionListListeners } from '../../../store/listeners/sessionListListeners';
import { initSessionStateListeners } from '../../../store/sessionStateListeners';

type EventHandler = (...args: any[]) => void;

const childId = 'nim-420-child';
const parentId = 'nim-420-parent';
const parentTitle = 'V13 parent container';

const cachedChild: SessionMeta = {
  id: childId,
  title: 'Cached child title',
  provider: 'claude-code',
  model: 'claude-code:sonnet',
  sessionType: 'session',
  workspaceId: '/workspace',
  worktreeId: null,
  parentSessionId: parentId,
  childCount: 0,
  uncommittedCount: 0,
  createdAt: 1,
  updatedAt: 1,
  messageCount: 0,
  isArchived: false,
  isPinned: false,
};

const parentSession: SessionMeta = {
  ...cachedChild,
  id: parentId,
  title: parentTitle,
  sessionType: 'workstream',
  parentSessionId: null,
  childCount: 1,
};

function currentChild(title: string): SessionMeta {
  return { ...cachedChild, title };
}

function renderExpandedChild(session = cachedChild) {
  return render(
    <Provider store={store}>
      <WorkstreamGroup
        type="workstream"
        id={parentId}
        title={parentTitle}
        isExpanded
        isActive={false}
        onToggle={() => {}}
        onSelect={() => {}}
        sessions={[session]}
        activeSessionId={null}
        onSessionSelect={() => {}}
      />
    </Provider>
  );
}

function expectNoChildRefetch(): void {
  expect(invoke.mock.calls.some(([channel]) => channel === 'sessions:list-children')).toBe(false);
}

let handlers: Map<string, EventHandler>;
let cleanups: Array<() => void>;
let invoke: ReturnType<typeof vi.fn>;

beforeEach(() => {
  handlers = new Map();
  cleanups = [];
  invoke = vi.fn().mockResolvedValue({ success: true, sessions: [] });

  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      on: vi.fn((channel: string, handler: EventHandler) => {
        handlers.set(channel, handler);
        return () => handlers.delete(channel);
      }),
      invoke,
      send: vi.fn(),
      sessionState: {
        subscribe: vi.fn().mockResolvedValue({ success: true }),
        unsubscribe: vi.fn().mockResolvedValue({ success: true }),
        getTrackedSessionIds: vi.fn().mockResolvedValue({ success: true, sessionIds: [] }),
        getRunningSessionIds: vi.fn().mockResolvedValue({ success: true, sessionIds: [] }),
        onStateChange: vi.fn((handler: EventHandler) => {
          handlers.set('ai-session-state:event', handler);
          return () => handlers.delete('ai-session-state:event');
        }),
      },
    },
  });

  store.set(sessionRegistryAtom, new Map([
    [parentId, parentSession],
    [childId, currentChild('Loaded child title')],
  ]));
  store.set(sessionStoreAtom(childId), {
    id: childId,
    title: 'Loaded child title',
  } as any);
  store.set(sessionProcessingAtom(childId), false);

  cleanups.push(initSessionStateListeners());
  cleanups.push(initSessionListListeners());
});

afterEach(() => {
  cleanups.reverse().forEach(cleanupListener => cleanupListener());
  cleanup();
  store.set(sessionRegistryAtom, new Map());
  store.set(sessionStoreAtom(childId), null);
  store.set(sessionProcessingAtom(childId), false);
  delete (window as any).electronAPI;
});

describe('expanded workstream title reconciliation (NIM-420)', () => {
  it('renders two external title events from normalized state without changing membership or refetching children', () => {
    const view = renderExpandedChild();

    expect(screen.getByText('Loaded child title')).toBeTruthy();
    expect(screen.getByText(parentTitle)).toBeTruthy();
    expect(document.querySelectorAll('.workstream-session-item')).toHaveLength(1);

    act(() => {
      handlers.get('session:title-updated')?.({
        sessionId: childId,
        title: 'First external rename',
      });
    });
    expect(screen.getByText('First external rename')).toBeTruthy();

    act(() => {
      handlers.get('sessions:session-updated')?.(childId, {
        title: 'Second external rename',
      });
    });
    expect(screen.getByText('Second external rename')).toBeTruthy();
    expect(screen.queryByText('First external rename')).toBeNull();

    act(() => {
      handlers.get('ai:message-logged')?.({
        sessionId: childId,
        direction: 'output',
        workspacePath: '/workspace',
      });
      store.set(sessionProcessingAtom(childId), true);
      store.set(sessionProcessingAtom(childId), false);
    });

    expect(screen.getByText('Second external rename')).toBeTruthy();
    expect(screen.getByText(parentTitle)).toBeTruthy();
    expect(document.querySelectorAll('.workstream-session-item')).toHaveLength(1);
    expectNoChildRefetch();

    view.rerender(
      <Provider store={store}>
        <WorkstreamGroup
          type="workstream"
          id={parentId}
          title={parentTitle}
          isExpanded={false}
          isActive={false}
          onToggle={() => {}}
          onSelect={() => {}}
          sessions={[cachedChild]}
          activeSessionId={null}
          onSessionSelect={() => {}}
        />
      </Provider>
    );
    expect(document.querySelectorAll('.workstream-session-item')).toHaveLength(0);

    view.rerender(
      <Provider store={store}>
        <WorkstreamGroup
          type="workstream"
          id={parentId}
          title={parentTitle}
          isExpanded
          isActive={false}
          onToggle={() => {}}
          onSelect={() => {}}
          sessions={[cachedChild]}
          activeSessionId={null}
          onSessionSelect={() => {}}
        />
      </Provider>
    );
    expect(screen.getByText('Second external rename')).toBeTruthy();
    expect(screen.getByText(parentTitle)).toBeTruthy();

    // A full session-view refresh reconstructs the structural cache from the
    // latest database metadata. This was the observed pre-fix recovery path.
    view.rerender(
      <Provider store={store}>
        <WorkstreamGroup
          type="workstream"
          id={parentId}
          title={parentTitle}
          isExpanded
          isActive={false}
          onToggle={() => {}}
          onSelect={() => {}}
          sessions={[currentChild('Second external rename')]}
          activeSessionId={null}
          onSessionSelect={() => {}}
        />
      </Provider>
    );
    expect(screen.getByText('Second external rename')).toBeTruthy();
    expectNoChildRefetch();
  });
});
