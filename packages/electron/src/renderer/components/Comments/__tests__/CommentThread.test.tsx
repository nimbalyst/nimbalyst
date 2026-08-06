// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createStore, Provider } from 'jotai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CommentThread } from '../CommentThread';
import { suppressDuplicateActivity } from '../ActivityRow';
import { createConversationCommentAdapter } from '../ConversationCommentAdapter';
import { composerText, type as typeIntoComposer } from '../composerTestDriver';
import {
  FULL_CAPABILITIES,
  LEAK_CANARIES,
  READ_ONLY_CAPABILITIES,
  createCommentFixtures,
  createFixtureCommentAdapter,
  createFixtureResolver,
} from '../commentFixtures';
import type {
  ActivityView,
  Actor,
  CommentAdapter,
  CommentCapabilities,
  CommentView,
  TimelineEntry,
} from '../commentTypes';

vi.mock('@nimbalyst/runtime/ui/icons/MaterialSymbol', () => ({
  MaterialSymbol: ({ icon }: { icon: string }) => <span data-icon={icon} />,
}));

const NOW = Date.parse('2026-07-26T18:00:00.000Z');
const VIEWER: Actor = { kind: 'user', userId: 'user-rowan', onBehalfOfUserId: 'user-rowan' };

function renderThread(
  options: {
    supportsReactions?: boolean;
    capabilities?: CommentCapabilities;
    sourceKind?: 'roomMessage' | 'trackerComment';
    onCopyLink?: (urn: string) => void;
    activity?: ActivityView[];
    adapter?: CommentAdapter;
    store?: ReturnType<typeof createStore>;
  } = {},
) {
  const fixtures = createCommentFixtures({ now: NOW, capabilities: options.capabilities });
  const fixtureAdapter = createFixtureCommentAdapter({
    now: NOW,
    capabilities: options.capabilities,
    supportsReactions: options.supportsReactions,
    sourceKind: options.sourceKind,
  });
  const adapter = options.adapter ?? fixtureAdapter;
  const targetStore = options.store ?? createStore();
  const utils = render(
    <Provider store={targetStore}>
      <CommentThread
        adapter={adapter}
        capabilities={options.capabilities ?? FULL_CAPABILITIES}
        context={fixtures.context}
        directory={fixtures.directory}
        orgId={fixtures.orgId}
        viewerUserId={fixtures.viewerUserId}
        viewerActor={VIEWER}
        resolver={createFixtureResolver()}
        resourceCandidates={fixtures.candidates}
        now={NOW}
        onCopyLink={options.onCopyLink}
        activity={options.activity}
      />
    </Provider>,
  );
  return { adapter, fixtureAdapter, fixtures, store: targetStore, ...utils };
}

describe('CommentThread', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('renders the conversation with agent attribution and a composer', async () => {
    renderThread();

    await waitFor(() => screen.getByTestId('comment-row-msg-001'));
    expect(screen.getByTestId('comment-row-msg-003').getAttribute('data-actor-kind')).toBe('agent');
    screen.getByTestId('comment-composer-input');
  });

  it('renders no reactions affordance at all when the adapter omits react', async () => {
    renderThread({ supportsReactions: false });

    await waitFor(() => screen.getByTestId('comment-row-msg-001'));
    expect(screen.queryByTestId('reaction-bar')).toBeNull();
    expect(screen.queryByTestId('reaction-chip-eyes')).toBeNull();
    expect(screen.queryByTestId('reaction-add-trigger')).toBeNull();
    // Explained once for the whole surface rather than as a dead control per row.
    screen.getByTestId('comment-thread-no-reactions');
  });

  it('toggles a reaction through the adapter and holds it to one per user per emoji', async () => {
    renderThread();
    await waitFor(() => screen.getByTestId('comment-row-msg-001'));

    const row = screen.getByTestId('comment-row-msg-001');
    const plusOne = within(row).getByTestId('reaction-chip-+1');
    expect(plusOne.getAttribute('data-reacted')).toBe('false');
    expect(plusOne.textContent).toContain('1');

    fireEvent.click(plusOne);
    await waitFor(() =>
      expect(within(screen.getByTestId('comment-row-msg-001')).getByTestId('reaction-chip-+1').getAttribute('data-reacted')).toBe('true'),
    );
    expect(within(screen.getByTestId('comment-row-msg-001')).getByTestId('reaction-chip-+1').textContent).toContain('2');

    // Selecting the same emoji again from the picker must not add a second one.
    fireEvent.click(within(screen.getByTestId('comment-row-msg-001')).getByTestId('reaction-add-trigger'));
    fireEvent.click(await screen.findByTestId('emoji-quick-+1'));
    await waitFor(() =>
      expect(within(screen.getByTestId('comment-row-msg-001')).getByTestId('reaction-chip-+1').textContent).toContain('2'),
    );

    fireEvent.click(within(screen.getByTestId('comment-row-msg-001')).getByTestId('reaction-chip-+1'));
    await waitFor(() =>
      expect(within(screen.getByTestId('comment-row-msg-001')).getByTestId('reaction-chip-+1').textContent).toContain('1'),
    );
  });

  it('copies the message URN from the action menu', async () => {
    const onCopyLink = vi.fn();
    renderThread({ onCopyLink });
    await waitFor(() => screen.getByTestId('comment-row-msg-001'));

    const row = screen.getByTestId('comment-row-msg-001');
    fireEvent.click(within(row).getByTestId('comment-action-trigger'));
    fireEvent.click(await screen.findByTestId('comment-action-copy-link'));

    expect(onCopyLink).toHaveBeenCalledWith('nimbalyst://conversation/conv-general/message/msg-001');
  });

  it('leaks nothing anywhere in the mounted tree for an unavailable reference', async () => {
    const { container } = renderThread();
    await waitFor(() => screen.getByTestId('comment-row-msg-004'));

    const row = screen.getByTestId('comment-row-msg-004');
    await waitFor(() => {
      const unavailable = within(row)
        .getAllByTestId('resource-pill-document')
        .find((pill) => pill.getAttribute('data-availability') === 'unavailable');
      expect(unavailable).toBeTruthy();
    });

    const unavailable = within(row)
      .getAllByTestId('resource-pill-document')
      .find((pill) => pill.getAttribute('data-availability') === 'unavailable')!;
    expect(unavailable.textContent).toBe('Unavailable');
    // The author-supplied label is withheld too: the pill says only that it is
    // unavailable.
    expect(unavailable.textContent).not.toContain('A document you cannot read');

    const markup = container.innerHTML;
    for (const canary of LEAK_CANARIES) {
      expect(markup).not.toContain(canary);
    }

    const foreign = within(row).getByTestId('resource-pill-file');
    expect(foreign.getAttribute('data-availability')).toBe('notInWorkspace');
    expect(foreign.textContent).toContain('Not in your workspace');
  });

  it('posts a new message through the adapter and renders it', async () => {
    const { fixtureAdapter } = renderThread();
    await waitFor(() => screen.getByTestId('comment-row-msg-001'));

    typeIntoComposer('ack');
    fireEvent.click(screen.getByTestId('comment-composer-send'));

    await waitFor(() => screen.getByTestId('comment-row-msg-local-1'));
    expect(fixtureAdapter.snapshot().some((comment) => comment.body.text === 'ack')).toBe(true);
  });

  it('clears the composer as soon as an optimistic send is accepted', async () => {
    const create = vi.fn(() => new Promise<never>(() => undefined));
    const adapter: CommentAdapter = {
      list: async () => ({ comments: [] }),
      create,
      edit: vi.fn(),
      remove: vi.fn(),
      subscribe: () => () => undefined,
    };
    renderThread({ adapter });
    await waitFor(() => screen.getByTestId('comment-thread-empty'));

    typeIntoComposer('accepted optimistically');
    fireEvent.click(screen.getByTestId('comment-composer-send'));

    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId('comment-row-pending').textContent).toContain('Sending');
    expect(composerText()).toBe('');
  });

  it('restores a persisted conversation draft after unmount and clears it on send', async () => {
    const persisted = new Map<string, unknown>();
    const invoke = vi.fn(
      async (channel: string, key: string, value?: unknown) => {
        if (channel === 'app-settings:get') return persisted.get(key);
        if (channel === 'app-settings:set') {
          persisted.set(key, value);
          return undefined;
        }
        return undefined;
      },
    );
    vi.stubGlobal('electronAPI', { invoke });

    const first = renderThread({ store: createStore() });
    await waitFor(() => screen.getByTestId('comment-composer-input'));
    typeIntoComposer('keep this unsent');
    await waitFor(
      () => expect(
        [...persisted.values()].some(
          (value) => (value as { text?: string })?.text === 'keep this unsent',
        ),
      ).toBe(true),
      { timeout: 2000 },
    );

    const adapter = first.adapter;
    first.unmount();
    renderThread({ adapter, store: createStore() });
    await waitFor(() => expect(composerText()).toBe('keep this unsent'));

    fireEvent.click(screen.getByTestId('comment-composer-send'));
    await waitFor(() => expect(
      [...persisted.values()].some(
        (value) => (value as { text?: string })?.text === '',
      ),
    ).toBe(true));

    cleanup();
    renderThread({ adapter, store: createStore() });
    await waitFor(() => expect(composerText()).toBe(''));
  });

  it('keeps a failed send reachable and retries the real IPC append with the same mutation id', async () => {
    let attempts = 0;
    const invoke = vi.fn(async (channel: string, request: any) => {
      if (channel === 'conversation:list') {
        return { events: [] };
      }
      expect(channel).toBe('conversation:append');
      attempts += 1;
      if (attempts === 1) {
        throw new Error('forced IPC append failure');
      }
      return {
        id: 'server-message-retry',
        conversationId: request.conversationId,
        sequence: 1,
        clientMutationId: request.input.clientMutationId,
        actor: request.input.actor,
        operation: request.input.operation,
        payload: request.input.payload,
        createdAt: NOW,
        serverReceivedAt: NOW,
      };
    });
    const adapter = createConversationCommentAdapter({
      orgId: 'org-acme',
      conversationId: 'conv-general',
      sourceKind: 'roomMessage',
      viewerActor: VIEWER,
      capabilities: FULL_CAPABILITIES,
      store: createStore(),
      invoke,
    });
    renderThread({ adapter });
    await waitFor(() => screen.getByTestId('comment-thread-empty'));

    typeIntoComposer('retry this message');
    fireEvent.click(screen.getByTestId('comment-composer-send'));

    const failed = await screen.findByTestId('comment-row-failed');
    expect(failed.textContent).toContain('Not sent');
    fireEvent.click(within(failed).getByTestId('comment-row-retry'));

    await waitFor(() =>
      expect(screen.getByTestId('comment-row-server-message-retry').textContent)
        .toContain('retry this message'),
    );
    const appendCalls = invoke.mock.calls.filter(
      ([channel]) => channel === 'conversation:append',
    );
    expect(appendCalls).toHaveLength(2);
    expect(appendCalls[0][1].input.clientMutationId).toBeTruthy();
    expect(appendCalls[1][1].input.clientMutationId)
      .toBe(appendCalls[0][1].input.clientMutationId);
    expect(screen.queryByTestId('comment-row-failed')).toBeNull();
  });

  it('turns a comment into a tombstone after delete', async () => {
    renderThread();
    await waitFor(() => screen.getByTestId('comment-row-msg-002'));

    const row = screen.getByTestId('comment-row-msg-002');
    fireEvent.click(within(row).getByTestId('comment-action-trigger'));
    fireEvent.click(await screen.findByTestId('comment-action-delete'));

    await waitFor(() =>
      expect(screen.getByTestId('comment-row-msg-002').getAttribute('data-deleted')).toBe('true'),
    );
    expect(screen.getByTestId('comment-row-msg-002').textContent).not.toContain('Handing it to');
  });

  it('hides the composer input and states the restriction on a read-only surface', async () => {
    renderThread({ capabilities: READ_ONLY_CAPABILITIES });
    await waitFor(() => screen.getByTestId('comment-row-msg-001'));

    expect(screen.queryByTestId('comment-composer-input')).toBeNull();
    expect(screen.getByTestId('comment-composer-restriction-title').textContent).toContain('read-only');
  });
});

describe('activity composition', () => {
  afterEach(() => cleanup());

  // The helper below is only rule 1 of "Activity and Chat Composition" in the
  // abstract. This asserts the mounted surface actually applies it, which is
  // the thing a tracker timeline depends on.
  it('drops a correlated audit row from the mounted timeline and keeps a domain change', async () => {
    renderThread({
      sourceKind: 'trackerComment',
      activity: [
        {
          key: 'audit-commented',
          icon: 'chat',
          actorLabel: 'Dana Okafor',
          summary: 'commented',
          timestampLabel: '1h',
          timestampTitle: '',
          correlatedCommentId: 'msg-001',
        },
        {
          key: 'audit-status',
          icon: 'label',
          actorLabel: 'Dana Okafor',
          summary: 'changed status to In review',
          timestampLabel: '1h',
          timestampTitle: '',
        },
      ],
    });

    await waitFor(() => screen.getByTestId('comment-row-msg-001'));
    expect(screen.queryByTestId('activity-row-audit-commented')).toBeNull();
    screen.getByTestId('activity-row-audit-status');
  });

  it('suppresses an audit activity row correlated to a rendered comment', () => {
    const entries: TimelineEntry[] = [
      {
        kind: 'comment',
        comment: {
          key: 'k',
          ref: { orgId: 'o', sourceKind: 'trackerComment', sourceId: 's', commentId: 'c-1' },
        } as CommentView,
      },
      {
        kind: 'activity',
        activity: {
          key: 'a-1',
          icon: 'chat',
          actorLabel: 'Dana Okafor',
          summary: 'commented',
          timestampLabel: '1h',
          timestampTitle: '',
          correlatedCommentId: 'c-1',
        },
      },
      {
        kind: 'activity',
        activity: {
          key: 'a-2',
          icon: 'label',
          actorLabel: 'Dana Okafor',
          summary: 'changed status to In review',
          timestampLabel: '1h',
          timestampTitle: '',
        },
      },
    ];

    const kept = suppressDuplicateActivity(entries);
    expect(kept.map((entry) => (entry.kind === 'activity' ? entry.activity.key : 'comment'))).toEqual([
      'comment',
      'a-2',
    ]);
  });
});

/**
 * jsdom has no layout, so scroll geometry has to be supplied. Rows are a fixed
 * height and the viewport holds two of them, which is enough to tell "pinned to
 * the newest message" apart from "left where the reader put it".
 */
const ROW_HEIGHT_PX = 100;
const VIEWPORT_PX = 200;

function stubScrollGeometry(): () => void {
  const proto = Element.prototype;
  const names = ['scrollTop', 'scrollHeight', 'clientHeight'] as const;
  const original = names.map(
    (name) => [name, Object.getOwnPropertyDescriptor(proto, name)] as const,
  );
  const offsets = new WeakMap<Element, number>();
  Object.defineProperty(proto, 'scrollTop', {
    configurable: true,
    get(this: Element) {
      return offsets.get(this) ?? 0;
    },
    set(this: Element, value: number) {
      offsets.set(this, value);
    },
  });
  Object.defineProperty(proto, 'scrollHeight', {
    configurable: true,
    get(this: Element) {
      return this.querySelectorAll('[data-testid^="comment-row-"]').length * ROW_HEIGHT_PX;
    },
  });
  Object.defineProperty(proto, 'clientHeight', {
    configurable: true,
    get: () => VIEWPORT_PX,
  });
  return () => {
    for (const [name, descriptor] of original) {
      if (descriptor) Object.defineProperty(proto, name, descriptor);
    }
  };
}

describe('CommentThread scroll position', () => {
  let restoreGeometry: () => void;

  beforeEach(() => {
    restoreGeometry = stubScrollGeometry();
  });
  afterEach(() => {
    cleanup();
    restoreGeometry();
  });

  it('opens on the newest message and follows a message the viewer sends', async () => {
    renderThread();
    await waitFor(() => screen.getByTestId('comment-row-msg-001'));

    const list = screen.getByTestId('comment-thread-list');
    expect(list.scrollTop).toBe(list.scrollHeight);

    // Reading history and then posting: sending is an unconditional jump back
    // to the end, or the message you just wrote is off screen.
    list.scrollTop = 0;
    fireEvent.scroll(list);
    typeIntoComposer('ack');
    fireEvent.click(screen.getByTestId('comment-composer-send'));

    await waitFor(() => screen.getByTestId('comment-row-msg-local-1'));
    expect(list.scrollTop).toBe(list.scrollHeight);
  });

  it('leaves a reader who scrolled up where they are when a message arrives', async () => {
    const { fixtureAdapter } = renderThread();
    await waitFor(() => screen.getByTestId('comment-row-msg-001'));

    const list = screen.getByTestId('comment-thread-list');
    list.scrollTop = 0;
    fireEvent.scroll(list);

    await act(async () => {
      await fixtureAdapter.create({
        actor: { kind: 'user', userId: 'user-dana', onBehalfOfUserId: 'user-dana' },
        body: { version: 1, format: 'plainText', text: 'from someone else' },
        clientMutationId: 'remote-1',
      });
    });

    await waitFor(() => screen.getByTestId('comment-row-msg-local-1'));
    expect(list.scrollTop).toBe(0);
  });
});
