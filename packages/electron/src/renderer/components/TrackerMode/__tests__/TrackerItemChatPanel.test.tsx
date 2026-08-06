// @vitest-environment jsdom
import { Provider } from 'jotai';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { store } from '@nimbalyst/runtime/store';
import type { TrackerRecord } from '@nimbalyst/runtime/core/TrackerRecord';
import { replaceAllTrackerItemsAtom } from '@nimbalyst/runtime/plugins/TrackerPlugin/trackerDataAtoms';
import { sessionRegistryAtom, type SessionMeta } from '../../../store/atoms/sessions';
import { setTrackerModeLayoutAtom } from '../../../store/atoms/trackers';
import { TrackerItemChatPanel } from '../TrackerItemChatPanel';

const chatSidebarProps = vi.hoisted(() => vi.fn());

vi.mock('../../ChatSidebar/ChatSidebar', () => ({
  ChatSidebar: (props: Record<string, unknown>) => {
    chatSidebarProps(props);
    return <div data-testid="standard-chat-sidebar" />;
  },
}));

const ITEM = {
  id: 'bug-1',
  primaryType: 'bug',
  typeTags: ['bug'],
  issueKey: 'NIM-1',
  source: 'native',
  archived: false,
  syncStatus: 'local',
  fields: { title: 'Chat consistency' },
  system: {
    workspace: '/ws',
    createdAt: '2026-07-29T00:00:00.000Z',
    updatedAt: '2026-07-29T00:00:00.000Z',
  },
} as TrackerRecord;

function session(id: string): SessionMeta {
  return {
    id,
    title: 'Linked item session',
    provider: 'claude-code',
    createdAt: 0,
    updatedAt: 1,
    messageCount: 0,
  } as SessionMeta;
}

function renderPanel() {
  return render(
    <Provider store={store}>
      <TrackerItemChatPanel itemId={ITEM.id} workspacePath="/ws" isActive />
    </Provider>,
  );
}

describe('TrackerItemChatPanel', () => {
  beforeEach(() => {
    chatSidebarProps.mockClear();
    store.set(replaceAllTrackerItemsAtom, [ITEM]);
    store.set(sessionRegistryAtom, new Map());
    store.set(setTrackerModeLayoutAtom, { documentChatSessions: {} });
  });

  it('is the ordinary chat panel -- it never seeds a chat about the item', () => {
    renderPanel();

    screen.getByTestId('standard-chat-sidebar');
    const props = chatSidebarProps.mock.lastCall?.[0];
    expect(props.sessionId).toBeNull();
    // No item-titled session, no pre-filled prompt: opening the panel must not
    // create or stage a conversation "about" the tracker item.
    expect(props.newSessionTitle).toBeUndefined();
    expect(props.newSessionDraft).toBeUndefined();
  });

  it('hands the item to the model as document context, like an open document', () => {
    renderPanel();

    const props = chatSidebarProps.mock.lastCall?.[0];
    expect(props.documentContext.editorContextItems[0].label).toBe('NIM-1 Chat consistency');
  });

  it('shows a session the user explicitly opened from the item', () => {
    const linked = session('session-1');
    store.set(sessionRegistryAtom, new Map([[linked.id, linked]]));
    store.set(setTrackerModeLayoutAtom, {
      documentChatSessions: { [ITEM.id]: linked.id },
    });

    renderPanel();

    expect(chatSidebarProps.mock.lastCall?.[0].sessionId).toBe(linked.id);
  });
});
