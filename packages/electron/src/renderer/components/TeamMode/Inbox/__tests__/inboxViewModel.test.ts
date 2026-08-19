// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { asTeamMemberId } from '@nimbalyst/runtime/auth/jwtScopes';

import { createInboxFixtures } from '../inboxFixtures';
import {
  deriveScopeOptions,
  groupRows,
  openRow,
  selectRows,
  toRowView,
  toggleScopeValue,
  typeIdentity,
} from '../inboxViewModel';
import { EMPTY_INBOX_SCOPE, type HydratedInboxDelivery, type InboxRowView } from '../inboxTypes';

const NOW = Date.parse('2026-07-26T18:00:00.000Z');

function select(overrides: Partial<Parameters<typeof selectRows>[0]> = {}) {
  return selectRows({
    deliveries: createInboxFixtures({ now: NOW }),
    filter: 'all',
    scope: EMPTY_INBOX_SCOPE,
    query: '',
    now: NOW,
    ...overrides,
  });
}

/**
 * A delivery whose source access was revoked. Everything the recipient could
 * once see is still on the record (the personal room retains the encrypted
 * bounded preview); the view model is what must refuse to surface it.
 */
const revoked: HydratedInboxDelivery = {
  id: 'delivery-revoked',
  teamMemberId: asTeamMemberId('me'),
  orgId: 'org-1',
  orgName: 'Acme',
  projectId: 'proj-secret',
  projectName: 'Project Nightingale',
  source: { orgId: 'org-1', sourceKind: 'roomMessage', sourceId: 'room-exec', commentId: 'msg-9' },
  reason: 'mention',
  actor: { kind: 'user', userId: 'u-2', onBehalfOfUserId: 'u-2', displayName: 'Dana Whitfield' },
  preview: { sourceTitle: 'Exec planning', snippet: 'the acquisition closes Friday', capturedAt: NOW - 1000 },
  createdAt: NOW - 60_000,
  availability: 'accessRemoved',
  capabilities: { comment: false },
};

describe('toRowView — access removed', () => {
  it('renders nothing about the former source', () => {
    const row = toRowView(revoked, { now: NOW });

    expect(row.unavailableLabel).toBe('No longer available');
    expect(row.sourceTitle).toBeUndefined();
    expect(row.preview).toBeUndefined();
    expect(row.actor).toBeUndefined();
    expect(row.sourceKind).toBeUndefined();
    expect(row.projectName).toBeUndefined();
    expect(row.dismissible).toBe(true);
    expect(row.canReply).toBe(false);

    // Nothing the recipient lost access to may survive anywhere on the view
    // model — including the search haystack, which is built from the row.
    const serialized = JSON.stringify(row);
    for (const leak of ['Exec planning', 'acquisition closes Friday', 'Dana Whitfield', 'room-exec', 'Project Nightingale']) {
      expect(serialized).not.toContain(leak);
    }
  });

  it('keeps its former source out of the scope control too', () => {
    const options = deriveScopeOptions([revoked]);
    expect(options.projects).toEqual([]);
    expect(options.sourceKinds).toEqual([]);
    // The org is not a secret — the delivery was addressed to a member of it.
    expect(options.orgs).toEqual([{ id: 'org-1', name: 'Acme' }]);
  });

  it('keeps a deleted source attributable, since the reader was authorized', () => {
    const row = toRowView({ ...revoked, id: 'deleted', availability: 'deletedSource' }, { now: NOW });
    expect(row.unavailableLabel).toBe('Deleted or unavailable');
    expect(row.actor?.displayName).toBe('Dana Whitfield');
    expect(row.sourceKind).toBe('roomMessage');
    // The body can no longer be re-read to confirm it, so it is not shown.
    expect(row.preview).toBeUndefined();
    expect(row.sourceTitle).toBeUndefined();
  });
});

describe('type identity', () => {
  it('resolves a tracker delivery down to its item type', () => {
    const bug = toRowView(
      {
        ...revoked,
        availability: 'available',
        capabilities: { comment: true },
        source: { orgId: 'org-1', sourceKind: 'trackerComment', sourceId: 'NIM-1', commentId: 'c-1' },
        preview: { sourceTitle: 'Barrel import cost', itemType: 'bug', capturedAt: NOW },
      },
      { now: NOW },
    );

    expect(bug.type.label).toBe('bug');
    expect(bug.type.icon).toBe('bug_report');
    // Not the generic tracker accent — the bug's own.
    expect(bug.type.accent).not.toBe(typeIdentity('trackerComment').accent);
  });

  it('falls back to the generic tracker identity rather than guessing', () => {
    // The item may live in a project this client has never synced, so an absent
    // type is genuinely unknown, not an invitation to infer one.
    expect(typeIdentity('trackerComment').label).toBe('Tracker');
    expect(typeIdentity('trackerComment', { itemType: 'not-a-registered-type' }).icon).toBe('label');
  });

  it('shows a document delivery the document’s own icon, not a speech bubble', () => {
    const inline = toRowView(
      {
        ...revoked,
        availability: 'available',
        capabilities: { comment: true },
        source: { orgId: 'org-1', sourceKind: 'documentInlineComment', sourceId: 'doc-1', commentId: 'c-1' },
        preview: { sourceTitle: 'shared-documents-mvp-plan.md', capturedAt: NOW },
      },
      { now: NOW },
    );

    expect(inline.type.label).toBe('Doc');
    expect(inline.type.icon).toBe('description');

    const drawing = toRowView(
      {
        ...revoked,
        availability: 'available',
        capabilities: { comment: true },
        source: { orgId: 'org-1', sourceKind: 'documentDiscussion', sourceId: 'doc-2', commentId: 'c-2' },
        preview: { sourceTitle: 'quarterly-metrics.csv', capturedAt: NOW },
      },
      { now: NOW },
    );

    // The file's own icon, the same one the file tree shows.
    expect(drawing.type.icon).toBe('table_chart');
  });

  it('reveals no item type once access is removed', () => {
    const row = toRowView(
      {
        ...revoked,
        source: { orgId: 'org-1', sourceKind: 'trackerComment', sourceId: 'NIM-1', commentId: 'c-1' },
        preview: { sourceTitle: 'Exec planning', itemType: 'decision', capturedAt: NOW },
      },
      { now: NOW },
    );

    expect(row.itemType).toBeUndefined();
    expect(row.type.icon).toBe('block');
    expect(JSON.stringify(row)).not.toContain('decision');
  });
});

describe('a request rather than a statement', () => {
  const feedback: HydratedInboxDelivery = {
    ...revoked,
    availability: 'available',
    capabilities: { comment: true },
    source: {
      orgId: 'org-1',
      sourceKind: 'feedbackRequest',
      sourceId: 'req-1',
      commentId: 'ask-1',
    },
  };

  it('marks a feedback request as awaiting an answer, and a comment as not', () => {
    expect(toRowView(feedback, { now: NOW }).awaitsResponse).toBe(true);
    expect(
      toRowView({ ...feedback, source: { ...feedback.source, sourceKind: 'roomMessage' } }, { now: NOW })
        .awaitsResponse,
    ).toBe(false);
  });

  it('stops claiming an answer is owed once access is removed', () => {
    // The row keeps nothing about a revoked source, and "someone is waiting on
    // you" is itself something about it.
    const row = toRowView({ ...feedback, availability: 'accessRemoved' }, { now: NOW });
    expect(row.awaitsResponse).toBe(false);
  });
});

describe('filters', () => {
  it('Mentions admits human and agent mentions and nothing else', () => {
    const { rows } = select({ filter: 'mentions' });
    expect(rows.map((row) => row.id).sort()).toEqual([
      'delivery-access-removed',
      'delivery-agent-mention',
      'delivery-doc-discussion',
      'delivery-mention-room',
      'delivery-read-only',
    ]);
    expect(rows.every((row) => row.reason === 'mention' || row.reason === 'agentMention')).toBe(true);
  });

  it('Assigned admits only assignment deliveries', () => {
    const { rows } = select({ filter: 'assigned' });
    expect(rows.map((row) => row.id)).toEqual(['delivery-assignment']);
  });

  it('Follows admits followed conversations regardless of reason', () => {
    const { rows } = select({ filter: 'follows' });
    expect(rows.every((row) => row.subscription === 'following')).toBe(true);
    expect(rows.map((row) => row.id)).toContain('delivery-dm'); // read, but still followed
    expect(rows.map((row) => row.id)).not.toContain('delivery-doc-discussion'); // muted
  });

  it('unreadOnly admits unread deliveries plus followed rooms whose watermark advanced', () => {
    const { rows } = select({ unreadOnly: true });
    const ids = rows.map((row) => row.id);
    // Already-read delivery with no new activity.
    expect(ids).not.toContain('delivery-dm');
    // Read, but the conversation advanced past the local receipt.
    expect(ids).toContain('delivery-follow-watermark');
    expect(rows.every((row) => row.unread)).toBe(true);
  });

  it('composes unreadOnly with the reason filter instead of replacing it', () => {
    const mentions = select({ filter: 'mentions' });
    const unreadMentions = select({ filter: 'mentions', unreadOnly: true });

    // The whole point of splitting the axis: this query was unexpressible when
    // unread was itself a reason chip.
    expect(unreadMentions.rows.every((row) => row.unread)).toBe(true);
    expect(unreadMentions.rows.every((row) => row.reason === 'mention' || row.reason === 'agentMention')).toBe(true);
    expect(unreadMentions.rows.length).toBeLessThanOrEqual(mentions.rows.length);
  });

  it('drops dismissed deliveries from every filter', () => {
    const deliveries = createInboxFixtures({ now: NOW }).map((delivery) =>
      delivery.id === 'delivery-mention-room' ? { ...delivery, dismissedAt: NOW } : delivery);
    const { rows } = select({ deliveries });
    expect(rows.map((row) => row.id)).not.toContain('delivery-mention-room');
  });
});

describe('counts', () => {
  it('counts unread within each filter, from the same rows the list renders', () => {
    const { counts, rows } = select({ filter: 'all' });
    const unreadRows = rows.filter((row) => row.unread);

    expect(counts.all).toBe(unreadRows.length);
    expect(counts.mentions).toBe(unreadRows.filter((row) => row.reason === 'mention' || row.reason === 'agentMention').length);
    expect(counts.assigned).toBe(1);
    expect(counts.follows).toBe(unreadRows.filter((row) => row.subscription === 'following').length);
  });

  it('leaves the reason counts alone when the unread toggle is on', () => {
    // The toggle refines what the list shows; it must not restate the badges as
    // "unread among the unread", which would make every badge equal its filter.
    expect(select({ unreadOnly: true }).counts).toEqual(select().counts);
  });

  it('narrows counts with the scope but not with the search query', () => {
    const scoped = select({ scope: { ...EMPTY_INBOX_SCOPE, orgIds: ['org-acme'] } });
    const searched = select({ query: 'zzz-no-match' });
    const unscoped = select();

    expect(scoped.counts.all).toBeLessThan(unscoped.counts.all);
    expect(searched.rows).toHaveLength(0);
    // Search refines a filter; it does not redefine how much is waiting in it.
    expect(searched.counts).toEqual(unscoped.counts);
  });

  it('marks the followed-watermark row unread even though it has a read receipt', () => {
    const { rows } = select();
    const row = rows.find((entry) => entry.id === 'delivery-follow-watermark');
    expect(row?.unread).toBe(true);
  });
});

describe('search', () => {
  it('composes with the active filter rather than replacing it', () => {
    // "Priya" authored both a room mention and the tracker assignment.
    const withinAll = select({ query: 'priya' }).rows.map((row) => row.id);
    expect(withinAll).toEqual(expect.arrayContaining(['delivery-mention-room', 'delivery-assignment']));

    const withinMentions = select({ filter: 'mentions', query: 'priya' }).rows.map((row) => row.id);
    expect(withinMentions).toEqual(['delivery-mention-room']);
    expect(withinMentions).not.toContain('delivery-assignment');
  });

  it('matches actor, conversation title, reason, and preview text', () => {
    expect(select({ query: 'Marcus' }).rows.length).toBeGreaterThan(0);          // actor
    expect(select({ query: 'Release train' }).rows.length).toBeGreaterThan(0);   // conversation title
    expect(select({ query: 'assigned to you' }).rows.length).toBeGreaterThan(0); // reason
    expect(select({ query: 'watermark' }).rows.length).toBeGreaterThan(0);       // preview text
  });

  it('requires every term, so typing narrows rather than widens', () => {
    const one = select({ query: 'release' }).rows.length;
    const two = select({ query: 'release packaging' }).rows.length;
    expect(two).toBeLessThanOrEqual(one);
    expect(two).toBeGreaterThan(0);
  });

  it('cannot reach content behind a revoked delivery', () => {
    const deliveries = [...createInboxFixtures({ now: NOW }), revoked];
    expect(select({ deliveries, query: 'acquisition' }).rows).toHaveLength(0);
    expect(select({ deliveries, query: 'Exec planning' }).rows).toHaveLength(0);
    // It still matches on the metadata it is allowed to keep.
    expect(select({ deliveries, query: 'mentioned you' }).rows.map((row) => row.id)).toContain('delivery-revoked');
  });

  it('composes with the scope as well as the filter', () => {
    const rows = select({
      query: 'mentioned',
      scope: { ...EMPTY_INBOX_SCOPE, orgIds: ['org-northwind'] },
    }).rows;
    expect(rows.every((row) => row.orgId === 'org-northwind')).toBe(true);
    expect(rows.length).toBeGreaterThan(0);
  });
});

describe('toggleScopeValue', () => {
  const all = ['a', 'b', 'c'] as const;

  it('unchecks one value out of an unrestricted axis rather than selecting it alone', () => {
    expect(toggleScopeValue<'a' | 'b' | 'c'>(null, 'a', all)).toEqual(['b', 'c']);
  });

  it('collapses back to unrestricted once everything is selected again', () => {
    expect(toggleScopeValue<'a' | 'b' | 'c'>(['b', 'c'], 'a', all)).toBeNull();
  });

  it('collapses to unrestricted rather than leaving an unexplainable empty list', () => {
    expect(toggleScopeValue<'a' | 'b' | 'c'>(['a'], 'a', all)).toBeNull();
  });
});

describe('grouping', () => {
  it('buckets rows chronologically and drops empty buckets', () => {
    const { rows } = select();
    const groups = groupRows(rows, NOW);
    expect(groups.map((group) => group.id)).toEqual(['today', 'yesterday', 'this-week', 'older']);
    expect(groups.every((group) => group.rows.length > 0)).toBe(true);
    // Newest first, within and across groups.
    const flat = groups.flatMap((group) => group.rows.map((row) => row.createdAt));
    expect([...flat].sort((a, b) => b - a)).toEqual(flat);
  });
});

describe('openRow', () => {
  const row = { id: 'd-1', availability: 'available', unread: true } as InboxRowView;

  it('marks read only after navigation succeeds', async () => {
    const markRead = vi.fn().mockResolvedValue(undefined);
    const result = await openRow(row, { navigate: async () => true, markRead });
    expect(result).toEqual({ outcome: 'opened', markedRead: true });
    expect(markRead).toHaveBeenCalledWith('d-1');
  });

  it('leaves the delivery unread when navigation fails', async () => {
    const markRead = vi.fn();
    const result = await openRow(row, { navigate: async () => false, markRead });
    expect(result).toEqual({ outcome: 'navigationFailed', markedRead: false });
    expect(markRead).not.toHaveBeenCalled();
  });

  it('leaves the delivery unread when navigation throws', async () => {
    const markRead = vi.fn();
    const result = await openRow(row, { navigate: async () => { throw new Error('offline'); }, markRead });
    expect(result.outcome).toBe('navigationFailed');
    expect(markRead).not.toHaveBeenCalled();
  });

  it('does not navigate an unavailable row at all', async () => {
    const navigate = vi.fn();
    const markRead = vi.fn();
    const result = await openRow({ ...row, availability: 'accessRemoved' }, { navigate, markRead });
    expect(result).toEqual({ outcome: 'unavailable', markedRead: false });
    expect(navigate).not.toHaveBeenCalled();
    expect(markRead).not.toHaveBeenCalled();
  });

  it('does not re-mark an already-read row', async () => {
    const markRead = vi.fn();
    const result = await openRow({ ...row, unread: false }, { navigate: async () => true, markRead });
    expect(result).toEqual({ outcome: 'opened', markedRead: false });
    expect(markRead).not.toHaveBeenCalled();
  });
});
