// @vitest-environment jsdom
import React from 'react';
import { Provider, createStore } from 'jotai';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ConversationDirectoryEntry } from '../../../../shared/conversationDirectory';
import { RoomView } from '../RoomView';
import { settingAtom } from '../../../store/atoms/settingAtomFamily';

vi.mock('@nimbalyst/runtime', () => ({
  MaterialSymbol: ({ icon }: { icon: string }) => <span>{icon}</span>,
}));
const threadProps = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }));
vi.mock('../../Comments/CommentThread', () => ({
  // Stands in for the real thread's defining behavior: every page it loads is
  // merged into the state the instance already holds, and an adapter change
  // never clears it. Whatever this renders is what a surviving instance would
  // show after a room switch.
  CommentThread: (props: Record<string, unknown>) => {
    threadProps.current = props;
    const context = props.context as { conversationId?: string };
    const [loaded, setLoaded] = React.useState<string[]>([]);
    React.useEffect(() => {
      setLoaded((current) => [...current, context.conversationId ?? '']);
      // Deliberately keyed on the adapter alone, as the thread itself is.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [props.adapter]);
    return <div data-testid="comment-thread">{loaded.join(',')}</div>;
  },
}));
vi.mock('../../Comments/ConversationCommentAdapter', () => ({
  createConversationCommentAdapter: (
    input: { conversationId: string },
  ) => ({ conversationId: input.conversationId }),
}));
vi.mock('../../../store/listeners/conversationDirectoryListeners', () => ({
  markConversationNotificationLevelChanged: vi.fn(),
}));

const entry: ConversationDirectoryEntry = {
  id: 'design',
  orgId: 'org-a',
  kind: 'orgRoom',
  visibility: 'private',
  title: 'Design',
  agentPostingEnabled: false,
  createdByUserId: 'member-a',
  createdAt: 1,
  capabilities: ['read', 'comment'],
};

describe('RoomView', () => {
  const setSubscription = vi.fn();

  beforeEach(() => {
    setSubscription.mockReset();
    setSubscription.mockImplementation(async (request) => ({
      conversationId: request.conversationId,
      userId: 'member-a',
      state: request.state,
      reason: 'explicit',
      notificationLevel: request.notificationLevel,
    }));
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        conversation: { setSubscription },
      },
    });
  });

  afterEach(() => cleanup());

  it('enables the bell and persists the selected level', async () => {
    render(
      <Provider store={createStore()}>
        <RoomView
          orgId="org-a"
          entry={entry}
          viewerUserId="member-a"
          members={[]}
        />
      </Provider>,
    );

    const bell = screen.getByTestId('org-room-notifications') as HTMLButtonElement;
    expect(bell.disabled).toBe(false);

    fireEvent.click(bell);
    fireEvent.click(screen.getByRole('menuitem', { name: /Mentions only/ }));

    await waitFor(() => expect(setSubscription).toHaveBeenCalledWith({
      orgId: 'org-a',
      conversationId: 'design',
      state: 'following',
      notificationLevel: 'mentions',
    }));
    await waitFor(() => expect(bell.title).toBe('Notification level: Mentions only'));
  });

  it('does not carry one room\'s thread into the next', () => {
    const store = createStore();
    const { rerender } = render(
      <Provider store={store}>
        <RoomView orgId="org-a" entry={entry} viewerUserId="member-a" members={[]} />
      </Provider>,
    );
    expect(screen.getByTestId('comment-thread').textContent).toBe('design');

    // The window keeps this component mounted and swaps the entry.
    rerender(
      <Provider store={store}>
        <RoomView
          orgId="org-a"
          entry={{ ...entry, id: 'general', title: 'General', visibility: 'public' }}
          viewerUserId="member-a"
          members={[]}
        />
      </Provider>,
    );

    expect(screen.getByTestId('comment-thread').textContent).toBe('general');
  });

  it('gives an empty room a first-message invitation rather than "no messages"', () => {
    render(
      <Provider store={createStore()}>
        <RoomView orgId="org-a" entry={entry} viewerUserId="member-a" members={[]} />
      </Provider>,
    );

    expect(threadProps.current?.emptyLabel)
      .toBe('This is the beginning of #Design. Send the first message to get it started.');
  });

  it('disables the actions menu when there is nothing to manage', () => {
    // A direct message: the window supplies neither settings nor invite, so an
    // enabled menu could only offer entries that do nothing.
    render(
      <Provider store={createStore()}>
        <RoomView
          orgId="org-a"
          entry={{ ...entry, id: 'dm-1', kind: 'dm', capabilities: ['read', 'comment', 'manageRoom'] }}
          viewerUserId="member-a"
          members={[]}
        />
      </Provider>,
    );

    const actions = screen.getByTestId('org-room-actions') as HTMLButtonElement;
    expect(actions.disabled).toBe(true);
    fireEvent.click(actions);
    expect(screen.queryByTestId('org-room-actions-menu')).toBeNull();
  });

  it('offers only the actions the window supplied', () => {
    render(
      <Provider store={createStore()}>
        <RoomView
          orgId="org-a"
          entry={{ ...entry, capabilities: ['read', 'comment', 'manageRoom'] }}
          viewerUserId="member-a"
          members={[]}
          onOpenRoomSettings={vi.fn()}
        />
      </Provider>,
    );

    const actions = screen.getByTestId('org-room-actions') as HTMLButtonElement;
    expect(actions.disabled).toBe(false);
    fireEvent.click(actions);

    expect(screen.getByRole('menuitem', { name: /Room settings/ })).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: /Invite members/ })).toBeNull();
  });

  // Where the invited-member welcome card lands: room width, under the header,
  // above the thread — not a band across the window (2026-07-28 layout).
  it('renders a notice between the room header and the thread', () => {
    const { container } = render(
      <Provider store={createStore()}>
        <RoomView
          orgId="org-a"
          entry={entry}
          viewerUserId="member-a"
          members={[]}
          notice={<div data-testid="welcome-stand-in" />}
        />
      </Provider>,
    );

    expect(screen.getByTestId('welcome-stand-in')).toBeTruthy();
    const order = Array.from(
      container.querySelectorAll('.org-room-header, .org-room-notice, .org-room-thread'),
    ).map((element) => element.className.split(' ')[0]);
    expect(order).toEqual(['org-room-header', 'org-room-notice', 'org-room-thread']);
  });

  it('leaves no notice slot behind when there is nothing to show', () => {
    render(
      <Provider store={createStore()}>
        <RoomView orgId="org-a" entry={entry} viewerUserId="member-a" members={[]} />
      </Provider>,
    );

    expect(screen.queryByTestId('org-room-notice')).toBeNull();
  });

  it('hands the thread the org window message density, comfortable by default', async () => {
    const store = createStore();
    render(
      <Provider store={store}>
        <RoomView orgId="org-a" entry={entry} viewerUserId="member-a" members={[]} />
      </Provider>,
    );
    expect(threadProps.current?.density).toBe('comfortable');

    // The preference is a setting, so a change anywhere reaches the room
    // without the room being told about it.
    void store.set(settingAtom('team.messages.density'), 'compact');
    await waitFor(() => expect(threadProps.current?.density).toBe('compact'));
  });
});
