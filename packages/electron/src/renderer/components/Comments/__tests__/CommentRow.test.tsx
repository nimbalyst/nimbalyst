// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CommentRow, formatClockTime, type CommentDensity } from '../CommentRow';
import { buildCommentView } from '../commentViewModel';
import { createCommentFixtures, createFixtureResolver, FULL_CAPABILITIES } from '../commentFixtures';
import { resourceRefToUrn } from '../resourceUrn';
import type { Comment, CommentCapabilities, ResourcePreviewState } from '../commentTypes';

vi.mock('@nimbalyst/runtime', () => ({
  MaterialSymbol: ({ icon }: { icon: string }) => <span data-icon={icon} />,
}));

vi.mock('@nimbalyst/runtime/plugins/TrackerLinkPlugin', () => ({
  useResolvedTrackerReference: (referenceKey: string) =>
    referenceKey === 'itm-pasted-plan'
      ? {
          id: referenceKey,
          issueKey: 'NIM-2299',
          title: 'Messaging link chips',
          type: 'plan',
          status: 'in-progress',
        }
      : null,
  TrackerReferenceChip: ({
    referenceKey,
    unresolvedLabel,
  }: {
    referenceKey: string;
    unresolvedLabel?: string;
  }) => (
    <span
      className="tracker-reference-chip"
      data-testid="tracker-reference-chip"
      data-reference-key={referenceKey}
    >
      {unresolvedLabel ?? referenceKey}
    </span>
  ),
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
    density?: CommentDensity;
    grouped?: boolean;
    timestampMs?: number;
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
    <CommentRow
      view={view}
      onAction={onAction}
      onToggleReaction={onToggleReaction}
      density={options.density}
      grouped={options.grouped}
      timestampMs={options.timestampMs}
    />,
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
    within(menu).getByTestId('comment-action-copy-link');
  });

  it('offers edit and delete on the viewer own comment when both capabilities are held', () => {
    const [own] = commentsOf();
    renderRow(own, { viewerUserId: 'user-dana', capabilities: FULL_CAPABILITIES });

    fireEvent.click(screen.getByTestId('comment-action-trigger'));
    const menu = screen.getByTestId('comment-action-menu');

    within(menu).getByTestId('comment-action-edit');
    within(menu).getByTestId('comment-action-delete');
    within(menu).getByTestId('comment-action-reply');
  });

  it('grants a moderator delete on someone else comment but never edit', () => {
    const [other] = commentsOf();
    renderRow(other, {
      viewerUserId: 'user-mira',
      capabilities: { ...FULL_CAPABILITIES, editOwn: true, deleteOwn: true, moderate: true },
    });

    fireEvent.click(screen.getByTestId('comment-action-trigger'));
    const menu = screen.getByTestId('comment-action-menu');

    within(menu).getByTestId('comment-action-delete');
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

    screen.getByTestId('reaction-chip-eyes');
    expect(screen.getByTestId('reaction-chip-eyes').hasAttribute('disabled')).toBe(true);
    expect(screen.queryByTestId('reaction-add-trigger')).toBeNull();
  });

  it('renders no reaction row for a message with no reactions, keeping the add affordance in the row actions', () => {
    const [, noReactions] = commentsOf();
    renderRow(noReactions);

    // Zero reactions must cost zero vertical space -- no reserved row.
    expect(screen.queryByTestId('reaction-bar')).toBeNull();
    expect(
      within(screen.getByTestId('comment-row-actions')).getByTestId('reaction-add-trigger'),
    ).toBeTruthy();
  });

  it('keeps the reaction bar chips-only and the add trigger in the hover actions', () => {
    const [withReactions] = commentsOf();
    renderRow(withReactions);

    // Aggregates are content and always visible; the affordance is not in the bar.
    const bar = screen.getByTestId('reaction-bar');
    expect(within(bar).getByTestId('reaction-chip-eyes').className).not.toContain('opacity-0');
    expect(within(bar).queryByTestId('reaction-add-trigger')).toBeNull();

    // Revealed with the action menu, keyed off the row's `group`.
    const actions = screen.getByTestId('comment-row-actions');
    within(actions).getByTestId('reaction-add-trigger');
    expect(actions.className).toContain('opacity-0');
    expect(actions.className).toContain('group-hover:opacity-100');
    expect(actions.className).toContain('focus-within:opacity-100');
  });

  it('keeps the row actions visible while the add-reaction picker is open', () => {
    const [withReactions] = commentsOf();
    renderRow(withReactions);

    fireEvent.click(screen.getByTestId('reaction-add-trigger'));

    // The picker autofocuses into a portal, so focus-within cannot hold the
    // container open -- a popover anchored to an invisible element reads as a bug.
    screen.getByTestId('reaction-emoji-picker');
    const actions = screen.getByTestId('comment-row-actions');
    expect(actions.className).not.toContain('opacity-0');
    expect(actions.className).toContain('opacity-100');
  });

  it('adds a reaction through the hover-actions picker', () => {
    const [withReactions] = commentsOf();
    const { onToggleReaction, view } = renderRow(withReactions);

    fireEvent.click(screen.getByTestId('reaction-add-trigger'));
    fireEvent.click(screen.getByTestId('emoji-quick-rocket'));

    expect(onToggleReaction).toHaveBeenCalledWith('rocket', true, view);
    // Choosing closes the popover, which releases the actions container again.
    expect(screen.queryByTestId('reaction-emoji-picker')).toBeNull();
    expect(screen.getByTestId('comment-row-actions').className).toContain('opacity-0');
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

    screen.getByTestId('comment-row-agent-glyph');
    screen.getByTestId('comment-row-agent-badge');
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
    within(agent).getByTestId('comment-mention-agent-glyph');
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

describe('CommentRow compact density', () => {
  afterEach(() => cleanup());

  const POSTED_AT = Date.parse('2026-07-26T17:35:00.000Z');

  it('renders author and message on one line behind a clock gutter, with no avatar', () => {
    const [first] = commentsOf();
    renderRow(first, { density: 'compact', timestampMs: POSTED_AT });

    const row = screen.getByRole('article');
    expect(row.getAttribute('data-density')).toBe('compact');
    expect(row.className).toContain('items-baseline');
    expect(screen.queryByTestId('comment-row-avatar')).toBeNull();
    expect(screen.queryByTestId('comment-row-agent-glyph')).toBeNull();

    // The gutter carries a wall clock, not the relative label the comfortable
    // header uses. It participates in the row's baseline alignment instead of
    // compensating with top padding, which drifts below the sender and body.
    const clock = screen.getByTestId('comment-row-clock');
    expect(clock.parentElement?.className).not.toContain('pt-[3px]');
    expect(clock.textContent).toBe(formatClockTime(POSTED_AT));
    expect(clock.textContent).toMatch(/\d{1,2}:\d{2}/);

    // Author and body are siblings on the single line, in that order.
    const line = row.querySelector('.comment-row-compact-line')!;
    expect(line).toBeTruthy();
    const actor = line.querySelector('.comment-row-actor')!;
    const body = line.querySelector('.comment-row-compact-body')!;
    expect(actor.textContent).toBe('Dana Okafor');
    expect(body.textContent).toBeTruthy();
    expect(actor.compareDocumentPosition(body) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('drops the repeated author on a grouped row but keeps the gutter reserved', () => {
    const [first] = commentsOf();
    renderRow(first, { density: 'compact', grouped: true, timestampMs: POSTED_AT });

    const row = screen.getByRole('article');
    expect(row.querySelector('.comment-row-actor')).toBeNull();

    // The time is revealed on hover rather than removed: a run of messages
    // reads as one block, but every row can still be dated, and the gutter
    // keeps its width so grouped and ungrouped bodies line up.
    const clock = screen.getByTestId('comment-row-clock');
    expect(clock.getAttribute('data-hover-only')).toBe('true');
    expect(clock.className).toContain('group-hover:opacity-100');
    expect(row.querySelector('.comment-row-clock-gutter')).toBeTruthy();
    expect(row.querySelector('.comment-row-compact-body')!.textContent).toBeTruthy();
  });

  it('keeps agent attribution and the pending marker on the compact line', () => {
    const agentComment = commentsOf().find((comment) => comment.actor.kind === 'agent')!;
    renderRow(agentComment, { density: 'compact', timestampMs: POSTED_AT });

    const line = screen.getByRole('article').querySelector('.comment-row-compact-line')!;
    within(line as HTMLElement).getByTestId('comment-row-agent-badge');
    within(line as HTMLElement).getByTestId('comment-row-agent-owner');
    within(line as HTMLElement).getByTestId('comment-row-session-chip');
  });

  it('keeps the hover actions and reaction bar working in compact', () => {
    const withReactions = commentsOf().find((comment) => (comment.reactions ?? []).length > 0)!;
    const { onToggleReaction } = renderRow(withReactions, {
      density: 'compact',
      timestampMs: POSTED_AT,
    });

    screen.getByTestId('comment-row-actions');
    const bar = screen.getByTestId('reaction-bar');
    fireEvent.click(bar.querySelector<HTMLButtonElement>('.reaction-chip')!);
    expect(onToggleReaction).toHaveBeenCalled();
  });

  it('defaults to comfortable: avatar, relative timestamp, no clock gutter', () => {
    const [first] = commentsOf();
    renderRow(first, { timestampMs: POSTED_AT });

    const row = screen.getByRole('article');
    expect(row.getAttribute('data-density')).toBe('comfortable');
    screen.getByTestId('comment-row-avatar');
    expect(screen.queryByTestId('comment-row-clock')).toBeNull();
    expect(row.querySelector('.comment-row-compact-line')).toBeNull();
    expect(row.querySelector('.comment-row-timestamp')).toBeTruthy();
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

  it('marks a generic resource pill loading, not available, before the resolver answers', () => {
    const comments = commentsOf();
    renderRow(comments[0], { previews: {} });
    const pill = screen.getByTestId('resource-pill-file');
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

  it('uses the live tracker reference chip when the pasted tracker is locally resolved', () => {
    const [base] = commentsOf();
    const trackerRef = {
      orgId: 'org-nimbalyst',
      kind: 'tracker' as const,
      sourceId: 'itm-pasted-plan',
    };
    const token = '[Plan](nimbalyst://tracker/itm-pasted-plan)';
    renderRow({
      ...base,
      body: {
        version: 1,
        format: 'nimbalystMarkdown',
        text: token,
        entities: [
          {
            start: 0,
            end: new TextEncoder().encode(token).byteLength,
            kind: 'resource',
            refIndex: 0,
          },
        ],
      },
      resourceRefs: [trackerRef],
    });

    const chip = screen.getByTestId('tracker-reference-chip');
    expect(chip.getAttribute('data-reference-key')).toBe('itm-pasted-plan');
    expect(screen.queryByTestId('resource-pill-tracker')).toBeNull();
  });

  it('keeps a pasted plan as an actionable tracker chip when the org window cannot resolve it locally', () => {
    const [base] = commentsOf();
    const token = '[Plan](nimbalyst://tracker/itm-org-window-plan)';
    renderRow({
      ...base,
      body: {
        version: 1,
        format: 'nimbalystMarkdown',
        text: token,
        entities: [
          {
            start: 0,
            end: new TextEncoder().encode(token).byteLength,
            kind: 'resource',
            refIndex: 0,
          },
        ],
      },
      resourceRefs: [{
        orgId: 'org-nimbalyst',
        kind: 'tracker',
        sourceId: 'itm-org-window-plan',
      }],
    });

    const chip = screen.getByTestId('tracker-reference-chip');
    expect(chip.getAttribute('data-reference-key')).toBe('itm-org-window-plan');
    expect(chip.textContent).toBe('Plan');
    expect(screen.queryByTestId('resource-pill-tracker')).toBeNull();
  });
});
