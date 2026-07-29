/**
 * Fixture deliveries for the Inbox surface.
 *
 * These exist so the surface can be designed, reviewed, and tested before the
 * `PersonalIndexRoom` listener and atoms land. The set deliberately covers every
 * per-row state in the plan's "Client States" table: available, access removed,
 * deleted source, read-only, agent pending, muted, following, read, unread, and
 * a followed conversation whose watermark advanced without its own delivery.
 *
 * Timestamps are relative to a `now` passed in, so grouping and relative labels
 * are deterministic in tests.
 */

import type { HydratedInboxDelivery } from './inboxTypes';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export interface FixtureOptions {
  now: number;
}

export function createInboxFixtures({ now }: FixtureOptions): HydratedInboxDelivery[] {
  return [
    {
      id: 'delivery-mention-room',
      recipientUserId: 'me',
      orgId: 'org-acme',
      orgName: 'Acme',
      projectId: 'proj-editor',
      projectName: 'Editor',
      source: { orgId: 'org-acme', sourceKind: 'roomMessage', sourceId: 'room-general', commentId: 'msg-1041' },
      reason: 'mention',
      actor: { kind: 'user', userId: 'u-priya', onBehalfOfUserId: 'u-priya', displayName: 'Priya Raman' },
      preview: {
        sourceTitle: 'General',
        snippet: 'can you take the sync regression before the alpha cut? I have the repro in NIM-2101 but no idea where the watermark is dropped.',
        capturedAt: now - 12 * MINUTE,
      },
      createdAt: now - 12 * MINUTE,
      availability: 'available',
      subscription: 'following',
      capabilities: { comment: true },
    },
    {
      id: 'delivery-agent-mention',
      recipientUserId: 'me',
      orgId: 'org-acme',
      orgName: 'Acme',
      projectId: 'proj-editor',
      projectName: 'Editor',
      source: { orgId: 'org-acme', sourceKind: 'roomMessage', sourceId: 'room-release', commentId: 'msg-2210' },
      reason: 'agentMention',
      actor: {
        kind: 'user',
        userId: 'u-marcus',
        onBehalfOfUserId: 'u-marcus',
        displayName: 'Marcus Lee',
      },
      preview: {
        sourceTitle: 'Release train',
        snippet: '@inbox-surface can you summarize what changed in the packaging path since 0.71.0?',
        capturedAt: now - 40 * MINUTE,
      },
      createdAt: now - 40 * MINUTE,
      availability: 'available',
      subscription: 'following',
      agentDispatch: 'pending',
      capabilities: { comment: true },
    },
    {
      id: 'delivery-agent-reply',
      recipientUserId: 'me',
      orgId: 'org-acme',
      orgName: 'Acme',
      projectId: 'proj-editor',
      projectName: 'Editor',
      source: { orgId: 'org-acme', sourceKind: 'roomMessage', sourceId: 'room-release', commentId: 'msg-2211' },
      reason: 'reply',
      actor: {
        kind: 'agent',
        sessionId: 'sess-7c2',
        sessionName: 'packaging-audit',
        onBehalfOfUserId: 'u-marcus',
        displayName: 'packaging-audit',
        onBehalfOfDisplayName: 'Marcus Lee',
      },
      preview: {
        sourceTitle: 'Release train',
        snippet: 'Three changes touch packaging since 0.71.0: the asar file glob, the minimatch pin, and extraResources for the arm64 helper.',
        capturedAt: now - 32 * MINUTE,
      },
      createdAt: now - 32 * MINUTE,
      availability: 'available',
      subscription: 'following',
      agentDispatch: 'dispatched',
      capabilities: { comment: true },
    },
    {
      id: 'delivery-assignment',
      recipientUserId: 'me',
      orgId: 'org-acme',
      orgName: 'Acme',
      projectId: 'proj-editor',
      projectName: 'Editor',
      source: { orgId: 'org-acme', sourceKind: 'trackerComment', sourceId: 'NIM-2101', commentId: 'cmt-88' },
      reason: 'assignment',
      actor: { kind: 'user', userId: 'u-priya', onBehalfOfUserId: 'u-priya', displayName: 'Priya Raman' },
      preview: {
        sourceTitle: 'NIM-2101 Unread watermark never advances for followed rooms',
        snippet: 'Assigned to you — reproduced on two clients, only the follower path is affected.',
        capturedAt: now - 3 * HOUR,
      },
      createdAt: now - 3 * HOUR,
      availability: 'available',
      capabilities: { comment: true },
    },
    {
      id: 'delivery-dm',
      recipientUserId: 'me',
      orgId: 'org-acme',
      orgName: 'Acme',
      source: { orgId: 'org-acme', sourceKind: 'dmMessage', sourceId: 'dm-4471', commentId: 'msg-3' },
      reason: 'dm',
      actor: { kind: 'user', userId: 'u-dana', onBehalfOfUserId: 'u-dana', displayName: 'Dana Whitfield' },
      preview: { sourceTitle: 'Dana Whitfield', snippet: 'Do you have five minutes before standup?', capturedAt: now - 5 * HOUR },
      createdAt: now - 5 * HOUR,
      readAt: now - 4 * HOUR,
      availability: 'available',
      subscription: 'following',
      capabilities: { comment: true },
    },
    {
      id: 'delivery-doc-discussion',
      recipientUserId: 'me',
      orgId: 'org-acme',
      orgName: 'Acme',
      projectId: 'proj-docs',
      projectName: 'Docs',
      source: { orgId: 'org-acme', sourceKind: 'documentDiscussion', sourceId: 'doc-onboarding', commentId: 'msg-51' },
      reason: 'mention',
      actor: { kind: 'user', userId: 'u-sam', onBehalfOfUserId: 'u-sam', displayName: 'Sam Ortega' },
      preview: {
        sourceTitle: 'Onboarding checklist',
        snippet: 'flagging you on the account-provisioning step — it still points at the old console URL.',
        capturedAt: now - 26 * HOUR,
      },
      createdAt: now - 26 * HOUR,
      availability: 'available',
      subscription: 'muted',
      capabilities: { comment: true },
    },
    {
      id: 'delivery-read-only',
      recipientUserId: 'me',
      orgId: 'org-northwind',
      orgName: 'Northwind',
      projectId: 'proj-platform',
      projectName: 'Platform',
      source: { orgId: 'org-northwind', sourceKind: 'documentInlineComment', sourceId: 'doc-arch', commentId: 'cmt-12' },
      reason: 'mention',
      actor: { kind: 'user', userId: 'u-jo', onBehalfOfUserId: 'u-jo', displayName: 'Jo Bakker' },
      preview: {
        sourceTitle: 'Platform architecture review',
        snippet: 'noting your objection to the shared cache here so it is on the record.',
        capturedAt: now - 2 * DAY,
      },
      createdAt: now - 2 * DAY,
      availability: 'available',
      subscription: 'following',
      capabilities: { comment: false },
      readOnlyReason: 'You have viewer access to this document. Ask an editor for comment access to reply.',
    },
    {
      id: 'delivery-follow-watermark',
      recipientUserId: 'me',
      orgId: 'org-acme',
      orgName: 'Acme',
      source: { orgId: 'org-acme', sourceKind: 'roomMessage', sourceId: 'room-design', commentId: 'msg-990' },
      reason: 'follow',
      actor: { kind: 'user', userId: 'u-sam', onBehalfOfUserId: 'u-sam', displayName: 'Sam Ortega' },
      preview: { sourceTitle: 'Design', snippet: '4 new messages since you last read this room.', capturedAt: now - 3 * DAY },
      createdAt: now - 3 * DAY,
      readAt: now - 3 * DAY,
      hasUnreadActivity: true,
      availability: 'available',
      subscription: 'following',
      capabilities: { comment: true },
    },
    {
      id: 'delivery-access-removed',
      recipientUserId: 'me',
      orgId: 'org-northwind',
      orgName: 'Northwind',
      projectId: 'proj-corp-dev',
      projectName: 'Corp Dev',
      source: { orgId: 'org-northwind', sourceKind: 'roomMessage', sourceId: 'room-corp-dev', commentId: 'msg-7' },
      reason: 'mention',
      actor: { kind: 'user', userId: 'u-hidden', onBehalfOfUserId: 'u-hidden', displayName: 'Alex Fenn' },
      // Retained on the record and deliberately never rendered — `toRowView`
      // drops all of it once availability is `accessRemoved`.
      preview: { sourceTitle: 'Corp dev', snippet: 'the term sheet lands Thursday', capturedAt: now - 4 * DAY },
      createdAt: now - 4 * DAY,
      availability: 'accessRemoved',
      capabilities: { comment: false },
    },
    {
      id: 'delivery-deleted-source',
      recipientUserId: 'me',
      orgId: 'org-acme',
      orgName: 'Acme',
      projectId: 'proj-editor',
      projectName: 'Editor',
      source: { orgId: 'org-acme', sourceKind: 'trackerComment', sourceId: 'NIM-1998', commentId: 'cmt-4' },
      reason: 'reply',
      actor: { kind: 'user', userId: 'u-marcus', onBehalfOfUserId: 'u-marcus', displayName: 'Marcus Lee' },
      preview: { sourceTitle: 'NIM-1998', snippet: 'closing this as a duplicate', capturedAt: now - 9 * DAY },
      createdAt: now - 9 * DAY,
      readAt: now - 9 * DAY,
      availability: 'deletedSource',
      capabilities: { comment: false },
    },
  ];
}
