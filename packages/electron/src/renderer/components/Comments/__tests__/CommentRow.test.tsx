// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CommentRow } from '../CommentRow';
import { buildCommentView } from '../commentViewModel';
import { createCommentFixtures, createFixtureResolver, FULL_CAPABILITIES } from '../commentFixtures';
import { resourceRefToUrn } from '../resourceUrn';
import type { Comment, CommentCapabilities, ResourcePreviewState } from '../commentTypes';

vi.mock('@nimbalyst/runtime', () => ({
  MaterialSymbol: ({ icon }: { icon: string }) => <span data-icon={icon} />,
}));

const NOW = Date.parse('2026-07-26T18:00:00.000Z');

async function previewsFor(comments: Comment[]): Promise<Record<string, ResourcePreviewState>> {
  const resolver = createFixtureResolver();
  const refs = comments.flatMap((comment) => comment.resourceRefs ?? []);
  return resolver.resolve(refs);
}

function renderRow(
  comment: Comment,
  options: {
    capabilities?: CommentCapabilities;
    viewerUserId?: string;
    previews?: Record<string, ResourcePreviewState>;
    reactionsSupported?: boolean;
    replyParent?: Comment | null;
  } = {},
) {
  const fixtures = createCommentFixtures({ now: NOW });
  const withCaps: Comment = options.capabilities
    ? { ...comment, capabilities: options.capabilities }
    : comment;
  const view = buildCommentView(withCaps, {
    viewerUserId: options.viewerUserId ?? fixtures.viewerUserId,
    directory: fixtures.directory,
    previews: options.previews ?? {},
    reactionsSupported: options.reactionsSupported ?? true,
    now: NOW,
    replyParent: options.replyParent,
  });
  const onAction = vi.fn();
  const onToggleReaction = vi.fn();
  const utils = render(
    <CommentRow view={view} onAction={onAction} onToggleReaction={onToggleReaction} />,
  );
  return { fixtures, view, onAction, onToggleReaction, ...utils };
}

function commentsOf(overrides: Parameters<typeof createCommentFixtures>[0] = {}) {
  return createCommentFixtures({ now: NOW, ...overrides }).comments;
}

describe('CommentRow capability-driven affordances', () => {
  afterEach(() => cleanup());

  it('hides edit and delete when the viewer holds neither editOwn nor deleteOwn', () => {
    const [own] = commentsOf();
    renderRow(own, {
      viewerUserId: 'user-dana',
      capabilities: { ...FULL_CAPABILITIES, editOwn: false, deleteOwn: false },
    });

    fireEvent.click(screen.getByTestId('comment-action-trigger'));
    const menu = screen.getByTestId('comment-action-menu');

    expect(within(menu).queryByTestId('comment-action-edit')).toBeNull();
    expect(within(menu).queryByTestId('comment-action-delete')).toBeNull();
    expect(within(menu).getByTestId('comment-action-copy-link')).toBeTruthy();
  });

  it('offers edit and delete on the viewer own comment when both capabilities are held', () => {
    const [own] = commentsOf();
    renderRow(own, { viewerUserId: 'user-dana', capabilities: FULL_CAPABILITIES });

    fireEvent.click(screen.getByTestId('comment-action-trigger'));
    const menu = screen.getByTestId('comment-action-menu');

    expect(within(menu).getByTestId('comment-action-edit')).toBeTruthy();
    expect(within(menu).getByTestId('comment-action-delete')).toBeTruthy();
    expect(within(menu).getByTestId('comment-action-reply')).toBeTruthy();
  });

  it('grants a moderator delete on someone else comment but never edit', () => {
    const [other] = commentsOf();
    renderRow(other, {
      viewerUserId: 'user-mira',
      capabilities: { ...FULL_CAPABILITIES, editOwn: true, deleteOwn: true, moderate: true },
    });

    fireEvent.click(screen.getByTestId('comment-action-trigger'));
    const menu = screen.getByTestId('comment-action-menu');

    expect(within(menu).getByTestId('comment-action-delete')).toBeTruthy();
    expect(within(menu).queryByTestId('comment-action-edit')).toBeNull();
  });

  it('drops reply from the menu when the comment capability is absent', () => {
    const [own] = commentsOf();
    renderRow(own, {
      viewerUserId: 'user-dana',
      capabilities: { ...FULL_CAPABILITIES, comment: false },
    });

    fireEvent.click(screen.getByTestId('comment-action-trigger'));
    expect(screen.queryByTestId('comment-action-reply')).toBeNull();
  });

  it('renders no reaction affordance when the adapter does not support reactions', () => {
    const [withReactions] = commentsOf();
    renderRow(withReactions, { reactionsSupported: false });

    expect(screen.queryByTestId('reaction-bar')).toBeNull();
    expect(screen.queryByTestId('reaction-add-trigger')).toBeNull();
  });

  it('renders existing aggregates inert but withholds the picker without the react capability', () => {
    const [withReactions] = commentsOf();
    renderRow(withReactions, { capabilities: { ...FULL_CAPABILITIES, react: false } });

    expect(screen.getByTestId('reaction-chip-eyes')).toBeTruthy();
    expect(screen.getByTestId('reaction-chip-eyes').hasAttribute('disabled')).toBe(true);
    expect(screen.queryByTestId('reaction-add-trigger')).toBeNull();
  });
});

describe('CommentRow agent attribution', () => {
  afterEach(() => cleanup());

  it('shows the agent glyph, for-owner attribution, and a session chip that deep-links', () => {
    const agentComment = commentsOf().find((comment) => comment.actor.kind === 'agent')!;
    const onOpenSession = vi.fn();
    const fixtures = createCommentFixtures({ now: NOW });
    const view = buildCommentView(agentComment, {
      viewerUserId: fixtures.viewerUserId,
      directory: fixtures.directory,
      previews: {},
      reactionsSupported: true,
      now: NOW,
    });
    render(
      <CommentRow
        view={view}
        onAction={vi.fn()}
        onToggleReaction={vi.fn()}
        onOpenSession={onOpenSession}
      />,
    );

    expect(screen.getByTestId('comment-row-agent-glyph')).toBeTruthy();
    expect(screen.getByTestId('comment-row-agent-badge')).toBeTruthy();
    expect(screen.getByTestId('comment-row-agent-owner').textContent).toBe('for Rowan Petrie');

    const chip = screen.getByTestId('comment-row-session-chip');
    expect(chip.getAttribute('data-session-id')).toBe('session-sync-repro');
    fireEvent.click(chip);
    expect(onOpenSession).toHaveBeenCalledWith('session-sync-repro');
  });

  it('renders a person mention with an avatar and an agent mention with the agent glyph', () => {
    const comments = commentsOf();
    const personMention = comments[0];
    const agentMention = comments[1];

    const { unmount } = renderRow(personMention);
    const person = screen.getByTestId('comment-mention-person');
    expect(person.getAttribute('data-user-id')).toBe('user-rowan');
    expect(within(person).getByTestId('comment-mention-avatar').textContent).toBe('RP');
    expect(screen.queryByTestId('comment-mention-agent')).toBeNull();
    unmount();

    renderRow(agentMention);
    const agent = screen.getByTestId('comment-mention-agent');
    expect(agent.getAttribute('data-session-id')).toBe('session-sync-repro');
    expect(within(agent).getByTestId('comment-mention-agent-glyph')).toBeTruthy();
    expect(agent.textContent).toContain('Sync repro');
    expect(screen.queryByTestId('comment-mention-person')).toBeNull();
  });

  it('does not turn an uncorroborated mention token into a mention', () => {
    const [base] = commentsOf();
    const forged: Comment = {
      ...base,
      body: {
        version: 1,
        format: 'nimbalystMarkdown',
        text: '[@Dana Okafor](nimbalyst://user/user-dana) shipped it',
      },
      deliveryHints: { mentionedUserIds: [], mentionedAgentSessionIds: [], assignedUserIds: [] },
    };
    renderRow(forged);

    expect(screen.queryByTestId('comment-mention-person')).toBeNull();
    expect(screen.getByRole('article').textContent).toContain('[@Dana Okafor](nimbalyst://user/user-dana)');
  });
});

describe('CommentRow states', () => {
  afterEach(() => cleanup());

  it('renders a deleted comment as a tombstone with no body and no actions', () => {
    const deleted = commentsOf().find((comment) => comment.deletedAt !== undefined)!;
    renderRow(deleted);

    expect(screen.getByTestId('comment-row-deleted').textContent).toContain('Message deleted');
    expect(screen.getByRole('article').textContent).not.toContain('wrong room');
    expect(screen.queryByTestId('comment-action-trigger')).toBeNull();
    expect(screen.queryByTestId('reaction-bar')).toBeNull();
  });

  it('marks an edited comment and titles it with the edit time', () => {
    const edited = commentsOf().find((comment) => comment.editedAt !== undefined)!;
    renderRow(edited);

    const marker = screen.getByTestId('comment-row-edited');
    expect(marker.textContent).toBe('(edited)');
    expect(marker.getAttribute('title')).toContain('Edited');
  });

  it('shows one level of reply context and never a nested tree', () => {
    const comments = commentsOf();
    const reply = comments[1];
    renderRow(reply, { replyParent: comments[0] });

    const strips = screen.getAllByTestId('comment-reply-parent');
    expect(strips).toHaveLength(1);
    expect(strips[0].textContent).toContain('Dana Okafor');
  });

  it('says the parent is unreadable rather than quoting it when it is unavailable', () => {
    const comments = commentsOf();
    renderRow(comments[1], { replyParent: null });

    const strip = screen.getByTestId('comment-reply-parent');
    expect(strip.getAttribute('data-unavailable')).toBe('true');
    expect(strip.textContent).toContain('Replying to a message you cannot see');
    expect(strip.textContent).not.toContain('Fanout is landing');
  });
});

describe('CommentRow copy link to message', () => {
  afterEach(() => cleanup());

  it('passes the conversation message URN through the action menu', () => {
    const [first] = commentsOf();
    const { onAction, view } = renderRow(first);

    fireEvent.click(screen.getByTestId('comment-action-trigger'));
    fireEvent.click(screen.getByTestId('comment-action-copy-link'));

    expect(onAction).toHaveBeenCalledTimes(1);
    const [action, passed] = onAction.mock.calls[0];
    expect(action).toBe('copyLink');
    expect(passed.messageUrn).toBe('nimbalyst://conversation/conv-general/message/msg-001');
    expect(view.messageUrn).toBe('nimbalyst://conversation/conv-general/message/msg-001');
  });

  it('omits copy link on a tracker comment, which is not an addressable conversation message', () => {
    const [trackerComment] = commentsOf({ sourceKind: 'trackerComment' });
    renderRow(trackerComment);

    fireEvent.click(screen.getByTestId('comment-action-trigger'));
    expect(screen.queryByTestId('comment-action-copy-link')).toBeNull();
  });
});

describe('CommentRow resource pills', () => {
  afterEach(() => cleanup());

  it('renders every available pill kind with its resolved title', async () => {
    const comments = commentsOf();
    const previews = await previewsFor(comments);

    renderRow(comments[3], { previews });
    const documentPills = screen.getAllByTestId('resource-pill-document');
    const available = documentPills.find((pill) => pill.getAttribute('data-availability') === 'available')!;
    expect(available.textContent).toContain('Teams Messaging Subsystem');
    expect(screen.getByTestId('resource-pill-conversation').textContent).toContain('Release coordination');

    cleanup();
    renderRow(comments[2], { previews });
    expect(screen.getByTestId('resource-pill-pullRequest').textContent).toContain('Add capability resolver matrix');
    expect(screen.getByTestId('resource-pill-commit').textContent).toContain('Release v0.71.2');
  });

  it('marks a pill loading, not available, before the resolver answers', () => {
    const comments = commentsOf();
    renderRow(comments[0], { previews: {} });
    const pill = screen.getByTestId('resource-pill-tracker');
    expect(pill.getAttribute('data-availability')).toBe('loading');
    expect(pill.tagName).toBe('SPAN');
  });

  it('keeps the tracker URN out of the rendered text once it becomes a pill', async () => {
    const comments = commentsOf();
    const previews = await previewsFor(comments);
    renderRow(comments[0], { previews });

    expect(screen.getByRole('article').textContent).not.toContain(
      resourceRefToUrn({ orgId: 'org-nimbalyst', kind: 'tracker', sourceId: 'itm-2212' }),
    );
  });
});
