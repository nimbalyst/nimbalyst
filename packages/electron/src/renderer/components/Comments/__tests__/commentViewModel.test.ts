// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  MAX_MENTIONED_AGENTS_PER_MESSAGE,
  MAX_MENTIONED_USERS_PER_MESSAGE,
  MAX_RESOURCE_REFS_PER_MESSAGE,
  MAX_RICH_COMMENT_TEXT_BYTES,
} from '@nimbalyst/collab-protocol';

import {
  aggregateReactions,
  buildCommentView,
  describeComposerRestriction,
  mentionCandidates,
  resolveActions,
  toPillView,
  toggleReactionAggregate,
  validateDraft,
} from '../commentViewModel';
import {
  FIXTURE_REFS,
  FULL_CAPABILITIES,
  LEAK_CANARIES,
  READ_ONLY_CAPABILITIES,
  createCommentFixtures,
  createFixtureResolver,
} from '../commentFixtures';
import { messageUrn, parseResourceUrn, resourceRefToUrn } from '../resourceUrn';
import type { Comment, CommentRef, CommentView, ResourceRef } from '../commentTypes';

const NOW = Date.parse('2026-07-26T18:00:00.000Z');
const ORG = 'org-nimbalyst';

describe('resource URN round-trip', () => {
  it('round-trips every ResourceRef kind', () => {
    const refs: ResourceRef[] = [
      FIXTURE_REFS.tracker,
      FIXTURE_REFS.document,
      FIXTURE_REFS.session,
      FIXTURE_REFS.file,
      FIXTURE_REFS.commit,
      FIXTURE_REFS.pullRequest,
      FIXTURE_REFS.conversation,
    ];
    for (const ref of refs) {
      const urn = resourceRefToUrn(ref);
      expect(parseResourceUrn(urn, ORG)).toEqual(ref);
    }
  });

  it('preserves a file path with slashes through encoding', () => {
    const urn = resourceRefToUrn(FIXTURE_REFS.file);
    expect(urn).toBe('nimbalyst://project/proj-editor/file/packages%2Fcollabv3%2Fsrc%2FTeamRoom.ts');
    expect(parseResourceUrn(urn, ORG)?.sourceId).toBe('packages/collabv3/src/TeamRoom.ts');
  });

  it('rejects a malformed or foreign URN instead of guessing', () => {
    expect(parseResourceUrn('https://example.com/tracker/1', ORG)).toBeNull();
    expect(parseResourceUrn('nimbalyst://tracker', ORG)).toBeNull();
    expect(parseResourceUrn('nimbalyst://unknownkind/1', ORG)).toBeNull();
    expect(parseResourceUrn('nimbalyst://file/foo.ts', ORG)).toBeNull();
  });
});

describe('Copy link to message URN formation', () => {
  const base = { orgId: ORG, sourceId: 'conv-general', commentId: 'msg-001' };

  it('forms nimbalyst://conversation/<id>/message/<messageId> for conversation sources', () => {
    for (const sourceKind of ['roomMessage', 'documentDiscussion', 'dmMessage'] as const) {
      const ref: CommentRef = { ...base, sourceKind };
      expect(messageUrn(ref)).toBe('nimbalyst://conversation/conv-general/message/msg-001');
    }
  });

  it('returns null for sources that are not conversations', () => {
    for (const sourceKind of ['trackerComment', 'documentInlineComment'] as const) {
      expect(messageUrn({ ...base, sourceKind })).toBeNull();
    }
  });
});

describe('pill redaction', () => {
  it('leaks nothing on an unavailable pill', async () => {
    const resolver = createFixtureResolver();
    const resolved = await resolver.resolve([FIXTURE_REFS.revokedDocument]);
    const urn = resourceRefToUrn(FIXTURE_REFS.revokedDocument);

    const pill = toPillView(FIXTURE_REFS.revokedDocument, resolved[urn]);

    expect(pill.availability).toBe('unavailable');
    expect(pill.label).toBe('Unavailable');
    expect(pill.secondary).toBeUndefined();
    expect(pill.state).toBeUndefined();
    expect(pill.actionable).toBe(false);

    const serialized = JSON.stringify(pill);
    for (const canary of LEAK_CANARIES) {
      expect(serialized).not.toContain(canary);
    }
  });

  it('degrades a file the reader has no checkout for to Not in your workspace', async () => {
    const resolver = createFixtureResolver();
    const resolved = await resolver.resolve([FIXTURE_REFS.foreignFile]);
    const pill = toPillView(FIXTURE_REFS.foreignFile, resolved[resourceRefToUrn(FIXTURE_REFS.foreignFile)]);

    expect(pill.availability).toBe('notInWorkspace');
    expect(pill.secondary).toBe('Not in your workspace');
    // Client-derivable identity only; the resolver title is withheld.
    expect(pill.label).toBe('App.swift');
    expect(JSON.stringify(pill)).not.toContain('App.swift on the mobile app');
  });

  it('degrades commit and pull-request refs the same way', () => {
    const commit = toPillView({ ...FIXTURE_REFS.commit, projectId: 'proj-other' }, { availability: 'notInWorkspace' });
    expect(commit.label).toBe('59ab7eaf');
    expect(commit.secondary).toBe('Not in your workspace');

    const pr = toPillView({ ...FIXTURE_REFS.pullRequest, projectId: 'proj-other' }, { availability: 'notInWorkspace' });
    expect(pr.label).toBe('#481');
  });

  it('never lets a non-workspace kind claim notInWorkspace', () => {
    // A document cannot be "not checked out"; it degrades to Unavailable.
    const pill = toPillView(FIXTURE_REFS.document, { availability: 'notInWorkspace' });
    expect(pill.availability).toBe('unavailable');
    expect(pill.label).toBe('Unavailable');
  });
});

describe('capability resolution', () => {
  it('maps the seven-field contract to the action list', () => {
    expect(
      resolveActions({ capabilities: FULL_CAPABILITIES, own: true, deleted: false, hasMessageUrn: true }),
    ).toEqual(['reply', 'edit', 'delete', 'copyLink']);

    expect(
      resolveActions({ capabilities: READ_ONLY_CAPABILITIES, own: true, deleted: false, hasMessageUrn: true }),
    ).toEqual(['copyLink']);

    expect(
      resolveActions({ capabilities: FULL_CAPABILITIES, own: true, deleted: true, hasMessageUrn: true }),
    ).toEqual([]);
  });

  it('explains a read-only surface rather than hiding the composer', () => {
    const { context } = createCommentFixtures({ now: NOW });
    const restriction = describeComposerRestriction(READ_ONLY_CAPABILITIES, context);

    expect(restriction).not.toBeNull();
    expect(restriction!.title).toContain('read-only');
    expect(restriction!.detail).toContain('comment');
    expect(restriction!.detail).toContain('General');
  });

  it('names the archive, not the permission, when the conversation is archived', () => {
    const { context } = createCommentFixtures({ now: NOW });
    const restriction = describeComposerRestriction(FULL_CAPABILITIES, { ...context, archived: true });
    expect(restriction!.title).toContain('archived');
  });

  it('returns null when the viewer may post', () => {
    const { context } = createCommentFixtures({ now: NOW });
    expect(describeComposerRestriction(FULL_CAPABILITIES, context)).toBeNull();
  });

  it('treats an agent post as own for its authorizing owner and not for anyone else', () => {
    const fixtures = createCommentFixtures({ now: NOW });
    const agentComment = fixtures.comments.find((comment) => comment.actor.kind === 'agent')!;

    const asOwner = buildCommentView(agentComment, {
      viewerUserId: 'user-rowan',
      directory: fixtures.directory,
      previews: {},
      reactionsSupported: true,
      now: NOW,
    });
    expect(asOwner.actions).toContain('edit');

    const asOther = buildCommentView(agentComment, {
      viewerUserId: 'user-mira',
      directory: fixtures.directory,
      previews: {},
      reactionsSupported: true,
      now: NOW,
    });
    expect(asOther.actions).not.toContain('edit');
  });
});

describe('reactions', () => {
  it('aggregates per emoji and marks the viewer own reaction', () => {
    const aggregates = aggregateReactions(
      [
        { emoji: '+1', userId: 'user-dana' },
        { emoji: '+1', userId: 'user-rowan' },
        { emoji: 'eyes', userId: 'user-mira' },
      ],
      'user-rowan',
    );

    expect(aggregates).toEqual([
      { emoji: '+1', count: 2, reactedByMe: true },
      { emoji: 'eyes', count: 1, reactedByMe: false },
    ]);
  });

  it('counts a duplicate user-emoji pair once', () => {
    const aggregates = aggregateReactions(
      [
        { emoji: '+1', userId: 'user-dana' },
        { emoji: '+1', userId: 'user-dana' },
        { emoji: '+1', userId: 'user-dana' },
      ],
      'user-rowan',
    );

    expect(aggregates).toEqual([{ emoji: '+1', count: 1, reactedByMe: false }]);
  });

  it('preserves first-seen emoji order', () => {
    const aggregates = aggregateReactions(
      [
        { emoji: 'rocket', userId: 'a' },
        { emoji: '+1', userId: 'b' },
        { emoji: 'rocket', userId: 'c' },
      ],
      'z',
    );
    expect(aggregates.map((aggregate) => aggregate.emoji)).toEqual(['rocket', '+1']);
  });

  it('toggles without letting one user inflate a count', () => {
    let aggregates = [{ emoji: '+1', count: 1, reactedByMe: false }];

    aggregates = toggleReactionAggregate(aggregates, '+1', true);
    expect(aggregates).toEqual([{ emoji: '+1', count: 2, reactedByMe: true }]);

    // Adding again is a no-op: one per user per emoji.
    aggregates = toggleReactionAggregate(aggregates, '+1', true);
    expect(aggregates).toEqual([{ emoji: '+1', count: 2, reactedByMe: true }]);

    aggregates = toggleReactionAggregate(aggregates, '+1', false);
    expect(aggregates).toEqual([{ emoji: '+1', count: 1, reactedByMe: false }]);
  });

  it('drops an aggregate that reaches zero', () => {
    const aggregates = toggleReactionAggregate([{ emoji: 'fire', count: 1, reactedByMe: true }], 'fire', false);
    expect(aggregates).toEqual([]);
  });

  it('adds a brand new emoji from the picker', () => {
    expect(toggleReactionAggregate([], 'tada', true)).toEqual([
      { emoji: 'tada', count: 1, reactedByMe: true },
    ]);
  });
});

describe('mention candidates', () => {
  const fixtures = createCommentFixtures({ now: NOW });

  it('returns people and attached agents in one list, people first', () => {
    const candidates = mentionCandidates(fixtures.directory, fixtures.context, '', 20);
    const kinds = candidates.map((candidate) => candidate.kind);

    expect(kinds.filter((kind) => kind === 'person').length).toBe(4);
    expect(kinds.filter((kind) => kind === 'agent').length).toBe(2);
    expect(kinds.indexOf('agent')).toBeGreaterThan(kinds.lastIndexOf('person'));
  });

  it('withholds every agent handle when agentPostingEnabled is false', () => {
    const candidates = mentionCandidates(
      fixtures.directory,
      { ...fixtures.context, agentPostingEnabled: false },
      '',
      20,
    );
    expect(candidates.every((candidate) => candidate.kind === 'person')).toBe(true);
  });

  it('never offers a session that is not attached to this conversation', () => {
    const candidates = mentionCandidates(fixtures.directory, fixtures.context, 'scratch', 20);
    expect(candidates).toEqual([]);
  });

  it('matches on handle, display name, and owner', () => {
    expect(mentionCandidates(fixtures.directory, fixtures.context, 'mira', 20)).toHaveLength(1);
    expect(mentionCandidates(fixtures.directory, fixtures.context, 'sync', 20)).toHaveLength(1);
    expect(mentionCandidates(fixtures.directory, fixtures.context, 'Dana', 20).length).toBeGreaterThan(1);
  });
});

describe('draft bound enforcement at the validator limits', () => {
  const body = (text: string) => ({
    version: 1 as const,
    format: 'nimbalystMarkdown' as const,
    text,
  });
  const emptyBody = body('');

  function draft(overrides: Partial<Parameters<typeof validateDraft>[0]> = {}) {
    return validateDraft({
      body: emptyBody,
      resourceRefs: [],
      mentionedUserIds: [],
      mentionedAgentSessionIds: [],
      ...overrides,
    });
  }

  it('accepts a body exactly at the byte limit and rejects one byte more', () => {
    const atLimit = 'a'.repeat(MAX_RICH_COMMENT_TEXT_BYTES);

    const ok = draft({ body: body(atLimit) });
    expect(ok.bodyBytes).toBe(MAX_RICH_COMMENT_TEXT_BYTES);
    expect(ok.errors).toEqual([]);
    expect(ok.canSend).toBe(true);

    const over = draft({ body: body(`${atLimit}a`) });
    expect(over.errors.map((error) => error.code)).toContain('richBodyTooLarge');
    expect(over.canSend).toBe(false);
  });

  it('accepts the maximum resource refs and rejects one more', () => {
    const refs = (count: number): ResourceRef[] =>
      Array.from({ length: count }, (_, index) => ({ orgId: ORG, kind: 'tracker' as const, sourceId: `itm-${index}` }));

    expect(draft({ body: body('x'), resourceRefs: refs(MAX_RESOURCE_REFS_PER_MESSAGE) }).errors).toEqual([]);

    const over = draft({ body: body('x'), resourceRefs: refs(MAX_RESOURCE_REFS_PER_MESSAGE + 1) });
    expect(over.errors.map((error) => error.code)).toContain('tooManyResourceRefs');
  });

  it('rejects a project-scoped ref with no projectId', () => {
    const bad = draft({
      body: body('x'),
      resourceRefs: [{ orgId: ORG, kind: 'file', sourceId: 'a.ts' }],
    });
    expect(bad.errors.map((error) => error.code)).toContain('resourceRefProjectIdRequired');
  });

  it('rejects messageId on a non-conversation ref', () => {
    const bad = draft({
      body: body('x'),
      resourceRefs: [{ orgId: ORG, kind: 'tracker', sourceId: 'itm-1', messageId: 'msg-1' }],
    });
    expect(bad.errors.map((error) => error.code)).toContain('resourceRefMessageIdNotAllowed');
  });

  it('accepts the maximum distinct user mentions and rejects one more', () => {
    const users = (count: number) => Array.from({ length: count }, (_, index) => `user-${index}`);

    expect(draft({ body: body('x'), mentionedUserIds: users(MAX_MENTIONED_USERS_PER_MESSAGE) }).errors).toEqual([]);

    const over = draft({ body: body('x'), mentionedUserIds: users(MAX_MENTIONED_USERS_PER_MESSAGE + 1) });
    expect(over.errors.map((error) => error.code)).toContain('tooManyMentionedUsers');
    expect(over.mentionedUserCount).toBe(MAX_MENTIONED_USERS_PER_MESSAGE + 1);
  });

  it('counts mentions distinctly, so repeating one person does not consume the budget', () => {
    const repeated = Array.from({ length: MAX_MENTIONED_USERS_PER_MESSAGE + 10 }, () => 'user-dana');
    const result = draft({ body: body('x'), mentionedUserIds: repeated });
    expect(result.mentionedUserCount).toBe(1);
    expect(result.errors).toEqual([]);
  });

  it('accepts the maximum distinct agent mentions and rejects one more', () => {
    const agents = (count: number) => Array.from({ length: count }, (_, index) => `session-${index}`);

    expect(draft({ body: body('x'), mentionedAgentSessionIds: agents(MAX_MENTIONED_AGENTS_PER_MESSAGE) }).errors).toEqual([]);

    const over = draft({ body: body('x'), mentionedAgentSessionIds: agents(MAX_MENTIONED_AGENTS_PER_MESSAGE + 1) });
    expect(over.errors.map((error) => error.code)).toContain('tooManyMentionedAgents');
  });

  it('treats an empty draft as unsendable without inventing an error', () => {
    const result = draft();
    expect(result.isEmpty).toBe(true);
    expect(result.canSend).toBe(false);
    expect(result.errors).toEqual([]);
  });

  it('lets a reference-only message send with no text', () => {
    const result = draft({ resourceRefs: [FIXTURE_REFS.tracker] });
    expect(result.isEmpty).toBe(false);
    expect(result.canSend).toBe(true);
  });
});

describe('attachments in the comment view', () => {
  const ATTACHMENT = {
    assetId: 'asset-1',
    fileName: 'screenshot.png',
    mimeType: 'image/png',
    byteSize: 2048,
  };

  function viewOf(overrides: Partial<Comment> = {}): CommentView {
    const fixtures = createCommentFixtures({ now: NOW });
    const base = fixtures.comments[0];
    return buildCommentView(
      {
        ...base,
        body: {
          version: 1,
          format: 'nimbalystMarkdown',
          text: 'see this',
          attachments: [ATTACHMENT],
        },
        ...overrides,
      },
      {
        viewerUserId: fixtures.viewerUserId,
        directory: fixtures.directory,
        previews: {},
        reactionsSupported: true,
        now: NOW,
      },
    );
  }

  it('addresses an attachment against the message source, not a guess', () => {
    const view = viewOf();
    const segment = view.segments.find((entry) => entry.type === 'attachments');

    expect(segment).toBeDefined();
    expect(segment?.type === 'attachments' && segment.attachments[0].src)
      .toBe(`collab-asset://doc/${encodeURIComponent(view.ref.sourceId)}/asset/asset-1`);
  });

  it('shows nothing for a deleted message, attachments included', () => {
    expect(viewOf({ deletedAt: NOW }).segments).toEqual([]);
  });
});
