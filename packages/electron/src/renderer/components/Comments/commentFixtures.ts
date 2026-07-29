/**
 * Fixture `CommentAdapter`, directory, and preview resolver.
 *
 * THE SEAM
 *
 * Every component in this directory reads a `CommentAdapter` from
 * `@nimbalyst/collab-protocol` and a `ResourcePreviewResolver` from
 * `commentTypes.ts`. Neither is implemented here in any way the components can
 * detect -- there is no `isFixture` flag and no branch on it. Replacing the
 * fixtures with live transport means constructing the real implementations and
 * passing them to `<CommentThread adapter={...} resolver={...} />`:
 *
 *   room messages / DMs / document discussions
 *     -> a ConversationRoom-backed adapter whose `subscribe` is fed by the
 *        conversation event stream and whose `create` sends a mutation with a
 *        clientMutationId
 *   tracker comments
 *     -> an adapter over the existing tracker comment IPC, with `react` OMITTED
 *   inline document comments
 *     -> an adapter over the Y.Doc CommentPlugin threads, with `react` OMITTED
 *
 * The fixtures below deliberately include one adapter WITHOUT `react` so the
 * omit-don't-disable path is exercised by default, not only in tests.
 */

import type {
  Actor,
  AgentHandle,
  Comment,
  CommentAdapter,
  CommentCapabilities,
  CommentChange,
  CommentRef,
  ConversationContext,
  MentionDirectory,
  PersonHandle,
  ResourceCandidate,
  ResourcePreviewResolver,
  ResourcePreviewState,
  ResourceRef,
} from './commentTypes';
import { agentMentionUrn, mentionUrn, resourceRefToUrn } from './resourceUrn';

const ORG_ID = 'org-nimbalyst';
const PROJECT_ID = 'proj-editor';
const CONVERSATION_ID = 'conv-general';
const VIEWER_ID = 'user-rowan';

export const FULL_CAPABILITIES: CommentCapabilities = {
  read: true,
  comment: true,
  react: true,
  editOwn: true,
  deleteOwn: true,
  moderate: false,
  manageRoom: false,
};

export const READ_ONLY_CAPABILITIES: CommentCapabilities = {
  read: true,
  comment: false,
  react: false,
  editOwn: false,
  deleteOwn: false,
  moderate: false,
  manageRoom: false,
};

const PEOPLE: PersonHandle[] = [
  { userId: VIEWER_ID, displayName: 'Rowan Petrie', handle: 'rowan', avatarInitials: 'RP', subtitle: 'Owner' },
  { userId: 'user-dana', displayName: 'Dana Okafor', handle: 'dana', avatarInitials: 'DO', subtitle: 'Admin' },
  { userId: 'user-mira', displayName: 'Mira Lindqvist', handle: 'mira', avatarInitials: 'ML', subtitle: 'Member' },
  { userId: 'user-sam', displayName: 'Sam Whitfield', handle: 'sam', avatarInitials: 'SW', subtitle: 'Guest' },
];

const AGENTS: AgentHandle[] = [
  {
    sessionId: 'session-sync-repro',
    sessionName: 'Sync repro',
    handle: 'sync-repro',
    ownerUserId: VIEWER_ID,
    ownerDisplayName: 'Rowan Petrie',
  },
  {
    sessionId: 'session-inbox-fanout',
    sessionName: 'Inbox fanout fix',
    handle: 'inbox-fanout',
    ownerUserId: 'user-dana',
    ownerDisplayName: 'Dana Okafor',
  },
  {
    // Attached to no conversation: must never appear in the picker.
    sessionId: 'session-detached',
    sessionName: 'Unattached scratch session',
    handle: 'scratch',
    ownerUserId: 'user-mira',
    ownerDisplayName: 'Mira Lindqvist',
  },
];

export const FIXTURE_DIRECTORY: MentionDirectory = {
  people: PEOPLE,
  agents: AGENTS,
  displayNames: Object.fromEntries(PEOPLE.map((person) => [person.userId, person.displayName])),
};

export const FIXTURE_CONTEXT: ConversationContext = {
  conversationId: CONVERSATION_ID,
  conversationTitle: 'General',
  agentPostingEnabled: true,
  attachedAgentSessionIds: ['session-sync-repro', 'session-inbox-fanout'],
  surfaceLabel: 'General',
};

/* -------------------------------------------------------------------------- */
/* Resource references                                                         */
/* -------------------------------------------------------------------------- */

export const FIXTURE_REFS = {
  tracker: { orgId: ORG_ID, kind: 'tracker', sourceId: 'itm-2212' } as ResourceRef,
  document: { orgId: ORG_ID, kind: 'document', sourceId: 'doc-messaging-plan' } as ResourceRef,
  session: { orgId: ORG_ID, kind: 'session', sourceId: 'session-sync-repro' } as ResourceRef,
  file: { orgId: ORG_ID, kind: 'file', sourceId: 'packages/collabv3/src/TeamRoom.ts', projectId: PROJECT_ID } as ResourceRef,
  commit: { orgId: ORG_ID, kind: 'commit', sourceId: '59ab7eaf8c1d40b2', projectId: PROJECT_ID } as ResourceRef,
  pullRequest: { orgId: ORG_ID, kind: 'pullRequest', sourceId: '481', projectId: PROJECT_ID } as ResourceRef,
  conversation: { orgId: ORG_ID, kind: 'conversation', sourceId: 'conv-release', messageId: 'msg-77' } as ResourceRef,
  /** Reader lost access to this one; it must degrade with nothing leaked. */
  revokedDocument: { orgId: ORG_ID, kind: 'document', sourceId: 'doc-comp-review' } as ResourceRef,
  /** Reader does not have this project checked out. */
  foreignFile: { orgId: ORG_ID, kind: 'file', sourceId: 'apps/mobile/App.swift', projectId: 'proj-mobile' } as ResourceRef,
} as const;

/**
 * Fixture previews.
 *
 * `revokedDocument` and `foreignFile` carry titles here ON PURPOSE: the
 * resolver is the thing that knows the secret, and the test asserts that no
 * component ever renders it. If redaction regressed, this fixture is what
 * catches it.
 */
const SECRET_TITLES = {
  revoked: 'Compensation review Q3',
  foreignFile: 'App.swift on the mobile app',
} as const;

export const LEAK_CANARIES: readonly string[] = [
  SECRET_TITLES.revoked,
  SECRET_TITLES.foreignFile,
  'Dana Okafor, Mira Lindqvist',
  'Archived',
];

export function createFixtureResolver(options: { latencyMs?: number } = {}): ResourcePreviewResolver {
  const table: Record<string, ResourcePreviewState> = {
    [resourceRefToUrn(FIXTURE_REFS.tracker)]: {
      availability: 'available',
      title: 'Inbox fanout targets the wrong member id',
      secondary: 'NIM-2212',
      state: 'In review',
    },
    [resourceRefToUrn(FIXTURE_REFS.document)]: {
      availability: 'available',
      title: 'Teams Messaging Subsystem',
      secondary: 'Shared document',
    },
    [resourceRefToUrn(FIXTURE_REFS.session)]: {
      availability: 'available',
      title: 'Sync repro',
      secondary: 'Agent session',
      state: 'Running',
    },
    [resourceRefToUrn(FIXTURE_REFS.file)]: {
      availability: 'available',
      title: 'TeamRoom.ts',
      secondary: 'packages/collabv3/src',
    },
    [resourceRefToUrn(FIXTURE_REFS.commit)]: {
      availability: 'available',
      title: 'Release v0.71.2',
      secondary: '59ab7ea',
    },
    [resourceRefToUrn(FIXTURE_REFS.pullRequest)]: {
      availability: 'available',
      title: 'Add capability resolver matrix',
      secondary: '#481',
      state: 'Merged',
    },
    [resourceRefToUrn(FIXTURE_REFS.conversation)]: {
      availability: 'available',
      title: 'Release coordination',
      secondary: 'Message from Dana Okafor',
    },
    // The resolver knows the title. The renderer must never receive it.
    [resourceRefToUrn(FIXTURE_REFS.revokedDocument)]: { availability: 'unavailable' },
    [resourceRefToUrn(FIXTURE_REFS.foreignFile)]: { availability: 'notInWorkspace' },
  };

  return {
    async resolve(refs) {
      if (options.latencyMs) await new Promise((resolve) => setTimeout(resolve, options.latencyMs));
      const out: Record<string, ResourcePreviewState> = {};
      for (const ref of refs) {
        const urn = resourceRefToUrn(ref);
        out[urn] = table[urn] ?? { availability: 'unavailable' };
      }
      return out;
    },
  };
}

export const FIXTURE_RESOURCE_CANDIDATES: ResourceCandidate[] = [
  { ref: FIXTURE_REFS.tracker, label: 'NIM-2212', secondary: 'Inbox fanout targets the wrong member id' },
  { ref: FIXTURE_REFS.document, label: 'Teams Messaging Subsystem', secondary: 'Shared document' },
  { ref: FIXTURE_REFS.file, label: 'TeamRoom.ts', secondary: 'packages/collabv3/src' },
  { ref: FIXTURE_REFS.commit, label: '59ab7ea', secondary: 'Release v0.71.2' },
  { ref: FIXTURE_REFS.pullRequest, label: '#481', secondary: 'Add capability resolver matrix' },
  { ref: FIXTURE_REFS.conversation, label: 'Release coordination', secondary: 'Deep link to a message' },
  { ref: FIXTURE_REFS.foreignFile, label: 'App.swift', secondary: 'Project you do not have open' },
  { ref: FIXTURE_REFS.revokedDocument, label: 'A document you cannot read', secondary: 'Degrades to Unavailable' },
];

/* -------------------------------------------------------------------------- */
/* Comments                                                                    */
/* -------------------------------------------------------------------------- */

function ref(commentId: string, sourceKind: CommentRef['sourceKind'] = 'roomMessage', sourceId = CONVERSATION_ID): CommentRef {
  return { orgId: ORG_ID, sourceKind, sourceId, commentId };
}

function userActor(userId: string): Actor {
  return { kind: 'user', userId, onBehalfOfUserId: userId };
}

function agentActor(sessionId: string, sessionName: string, ownerUserId: string): Actor {
  return { kind: 'agent', sessionId, sessionName, onBehalfOfUserId: ownerUserId };
}

export interface CommentFixtureOptions {
  now?: number;
  capabilities?: CommentCapabilities;
  /** Overrides `FIXTURE_CONTEXT`, e.g. to turn agent posting off. */
  context?: Partial<ConversationContext>;
  sourceKind?: CommentRef['sourceKind'];
}

export interface CommentFixtures {
  viewerUserId: string;
  orgId: string;
  directory: MentionDirectory;
  context: ConversationContext;
  comments: Comment[];
  candidates: ResourceCandidate[];
}

export function createCommentFixtures(options: CommentFixtureOptions = {}): CommentFixtures {
  const now = options.now ?? Date.now();
  const caps = options.capabilities ?? FULL_CAPABILITIES;
  const sourceKind = options.sourceKind ?? 'roomMessage';
  const minutes = (count: number) => now - count * 60_000;

  const comments: Comment[] = [
    {
      ref: ref('msg-001', sourceKind),
      actor: userActor('user-dana'),
      body: {
        version: 1,
        format: 'nimbalystMarkdown',
        text: `Fanout is landing on the wrong member id. Trace is in [NIM-2212](${resourceRefToUrn(FIXTURE_REFS.tracker)}) and the failing line is [TeamRoom.ts](${resourceRefToUrn(FIXTURE_REFS.file)}). [@Rowan Petrie](${mentionUrn(VIEWER_ID)}) can you confirm before we cut?`,
      },
      createdAt: minutes(180),
      resourceRefs: [FIXTURE_REFS.tracker, FIXTURE_REFS.file],
      reactions: [
        { emoji: 'eyes', count: 2, reactedByMe: true },
        { emoji: '+1', count: 1, reactedByMe: false },
      ],
      capabilities: caps,
      deliveryHints: { mentionedUserIds: [VIEWER_ID], mentionedAgentSessionIds: [], assignedUserIds: [] },
    },
    {
      ref: ref('msg-002', sourceKind),
      actor: userActor(VIEWER_ID),
      body: {
        version: 1,
        format: 'nimbalystMarkdown',
        text: `Confirmed. Handing it to [@Sync repro](${agentMentionUrn('session-sync-repro')}) to reproduce against the worker.`,
      },
      createdAt: minutes(174),
      editedAt: minutes(172),
      replyToCommentId: 'msg-001',
      resourceRefs: [FIXTURE_REFS.session],
      reactions: [],
      capabilities: caps,
      deliveryHints: { mentionedUserIds: [], mentionedAgentSessionIds: ['session-sync-repro'], assignedUserIds: [] },
    },
    {
      ref: ref('msg-003', sourceKind),
      actor: agentActor('session-sync-repro', 'Sync repro', VIEWER_ID),
      body: {
        version: 1,
        format: 'nimbalystMarkdown',
        text: `Reproduced through Wrangler. The team member id and the personal member id differ, so \`user:<id>:index\` never matches. Fix is on [#481](${resourceRefToUrn(FIXTURE_REFS.pullRequest)}), commit [59ab7ea](${resourceRefToUrn(FIXTURE_REFS.commit)}). :white_check_mark:`,
      },
      createdAt: minutes(96),
      resourceRefs: [FIXTURE_REFS.pullRequest, FIXTURE_REFS.commit],
      reactions: [
        { emoji: 'rocket', count: 3, reactedByMe: false },
        { emoji: 'white_check_mark', count: 1, reactedByMe: true },
      ],
      capabilities: caps,
      deliveryHints: { mentionedUserIds: [], mentionedAgentSessionIds: [], assignedUserIds: [] },
    },
    {
      ref: ref('msg-004', sourceKind),
      actor: userActor('user-mira'),
      body: {
        version: 1,
        format: 'nimbalystMarkdown',
        text: `Context lives in [Teams Messaging Subsystem](${resourceRefToUrn(FIXTURE_REFS.document)}), and the earlier decision is at [this message](${resourceRefToUrn(FIXTURE_REFS.conversation)}). Related notes: [A document you cannot read](${resourceRefToUrn(FIXTURE_REFS.revokedDocument)}) and [App.swift](${resourceRefToUrn(FIXTURE_REFS.foreignFile)}).`,
      },
      createdAt: minutes(40),
      resourceRefs: [
        FIXTURE_REFS.document,
        FIXTURE_REFS.conversation,
        FIXTURE_REFS.revokedDocument,
        FIXTURE_REFS.foreignFile,
      ],
      reactions: [],
      capabilities: caps,
      deliveryHints: { mentionedUserIds: [], mentionedAgentSessionIds: [], assignedUserIds: [] },
    },
    {
      ref: ref('msg-005', sourceKind),
      actor: userActor('user-sam'),
      body: { version: 1, format: 'plainText', text: 'Never mind, wrong room.' },
      createdAt: minutes(22),
      deletedAt: minutes(21),
      resourceRefs: [],
      capabilities: caps,
      deliveryHints: { mentionedUserIds: [], mentionedAgentSessionIds: [], assignedUserIds: [] },
    },
  ];

  return {
    viewerUserId: VIEWER_ID,
    orgId: ORG_ID,
    directory: FIXTURE_DIRECTORY,
    context: { ...FIXTURE_CONTEXT, ...options.context },
    comments,
    candidates: FIXTURE_RESOURCE_CANDIDATES,
  };
}

/* -------------------------------------------------------------------------- */
/* Adapter                                                                     */
/* -------------------------------------------------------------------------- */

export interface FixtureAdapterOptions extends CommentFixtureOptions {
  /**
   * Omit `react` from the adapter, as tracker comments and inline document
   * comments do in V1. The renderer must show no reaction affordance at all.
   */
  supportsReactions?: boolean;
  /** Fail every create, to exercise the failed-send state. */
  failCreate?: boolean;
}

export interface FixtureCommentAdapter extends CommentAdapter {
  /** Present only on the fixture. Disappears with it. */
  snapshot(): Comment[];
}

export function createFixtureCommentAdapter(options: FixtureAdapterOptions = {}): FixtureCommentAdapter {
  const fixtures = createCommentFixtures(options);
  const caps = options.capabilities ?? FULL_CAPABILITIES;
  let comments = [...fixtures.comments];
  const listeners = new Set<(change: CommentChange) => void>();
  let counter = 0;

  const emit = (change: CommentChange) => listeners.forEach((listener) => listener(change));
  const find = (target: CommentRef) => comments.find((comment) => comment.ref.commentId === target.commentId);

  const adapter: FixtureCommentAdapter = {
    snapshot: () => comments,
    async list() {
      return { comments: [...comments] };
    },
    async create(input) {
      if (options.failCreate) throw new Error('Fixture create failure');
      counter += 1;
      const created: Comment = {
        ref: {
          orgId: fixtures.orgId,
          sourceKind: options.sourceKind ?? 'roomMessage',
          sourceId: fixtures.context.conversationId ?? CONVERSATION_ID,
          commentId: `msg-local-${counter}`,
        },
        actor: input.actor,
        body: input.body,
        createdAt: Date.now(),
        replyToCommentId: input.replyToCommentId,
        resourceRefs: input.resourceRefs ?? [],
        reactions: [],
        capabilities: caps,
        deliveryHints: input.deliveryHints,
      };
      comments = [...comments, created];
      emit({ type: 'created', comment: created });
      return created;
    },
    async edit(target, body) {
      const existing = find(target);
      if (!existing) throw new Error(`Unknown comment ${target.commentId}`);
      const updated: Comment = { ...existing, body, editedAt: Date.now() };
      comments = comments.map((comment) => (comment.ref.commentId === target.commentId ? updated : comment));
      emit({ type: 'updated', comment: updated });
      return updated;
    },
    async remove(target) {
      const existing = find(target);
      if (!existing) return;
      const updated: Comment = { ...existing, deletedAt: Date.now() };
      comments = comments.map((comment) => (comment.ref.commentId === target.commentId ? updated : comment));
      emit({ type: 'updated', comment: updated });
    },
    subscribe(onChange) {
      listeners.add(onChange);
      return () => {
        listeners.delete(onChange);
      };
    },
  };

  if (options.supportsReactions !== false) {
    adapter.react = async (target, emoji, on) => {
      const existing = find(target);
      if (!existing) return;
      const current = existing.reactions ?? [];
      const found = current.find((reaction) => reaction.emoji === emoji);
      let next = current;
      if (!found) {
        next = on ? [...current, { emoji, count: 1, reactedByMe: true }] : current;
      } else if (found.reactedByMe !== on) {
        next = current
          .map((reaction) =>
            reaction.emoji === emoji
              ? { ...reaction, count: reaction.count + (on ? 1 : -1), reactedByMe: on }
              : reaction,
          )
          .filter((reaction) => reaction.count > 0);
      }
      const updated: Comment = { ...existing, reactions: next };
      comments = comments.map((comment) => (comment.ref.commentId === target.commentId ? updated : comment));
      emit({ type: 'updated', comment: updated });
    };
  }

  return adapter;
}
