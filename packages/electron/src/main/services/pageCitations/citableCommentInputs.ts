/**
 * Comments on shared pages as citable inputs: every live comment a person (not
 * an agent) wrote, from the comment list a page's controller returns
 * (`readCollabDocComments`). The key names the document, thread and comment,
 * which together identify a comment for as long as the page exists.
 */

import type { TeamMemberId } from '@nimbalyst/runtime/auth/jwtScopes';
import { citationMarkdown } from './citationMarkdown';
import { shortenQuote, type CitableInput } from './citableRawRows';

interface ListedComment {
  actor?: CommentActor & { kind?: string };
  body?: string;
  createdAt?: number;
  deleted?: boolean;
  id?: string;
}

interface ListedThread {
  id?: string;
  quote?: string;
  comments?: ListedComment[];
}

export interface CommentListResult {
  document?: { title?: string; uri?: string };
  threads?: ListedThread[];
}

/** `collab://org:<org>:doc:<id>` and `collab://tracker-content/<id>` -> the room's document id. */
export function documentIdFromPageUri(uri: string): string {
  const docMatch = /^collab:\/\/org:[^:]+:doc:(.+)$/.exec(uri);
  if (docMatch) return docMatch[1]!;
  return uri.replace(/^collab:\/\//, '');
}

export function commentInputKey(documentId: string, threadId: string, commentId: string): string {
  return `${documentId}~${threadId}~${commentId}`;
}

/** A comment's author: `userId` is the author's member id in the page's team. */
type CommentActor = { userId?: TeamMemberId; displayName?: string };

export interface TeamMemberIdentity {
  memberId: TeamMemberId;
  name: string;
  email: string;
}

/**
 * A commenter's email, from the team roster: by member id, else by a display
 * name only one member has. A comment stores no email of its own.
 */
export function commenterEmailLookup(members: readonly TeamMemberIdentity[]): (actor: CommentActor) => string | undefined {
  const byId = new Map(members.map((member) => [member.memberId, member.email]));
  const byName = new Map<string, string | null>();
  for (const member of members) {
    const name = member.name.trim().toLowerCase();
    if (name) byName.set(name, byName.has(name) ? null : member.email);
  }
  return (actor) => (actor.userId ? byId.get(actor.userId) : undefined)
    ?? byName.get(actor.displayName?.trim().toLowerCase() ?? '')
    ?? undefined;
}

export function citableCommentInputs(
  pageUri: string,
  list: CommentListResult,
  sessionId: string,
  emailFor: (actor: CommentActor) => string | undefined = () => undefined,
): CitableInput[] {
  const documentId = documentIdFromPageUri(list.document?.uri ?? pageUri);
  const pageTitle = list.document?.title?.trim() || 'Shared page';
  const inputs: CitableInput[] = [];
  for (const thread of list.threads ?? []) {
    if (!thread?.id) continue;
    const passage = thread.quote?.trim();
    const context = passage ? `${pageTitle}: "${shortenQuote(passage, 120)}"` : pageTitle;
    for (const comment of thread.comments ?? []) {
      if (!comment?.id || comment.deleted || comment.actor?.kind !== 'user') continue;
      const body = comment.body?.trim();
      const by = comment.actor.displayName?.trim();
      if (!body || !by || typeof comment.createdAt !== 'number') continue;
      const key = commentInputKey(documentId, thread.id, comment.id);
      const at = new Date(comment.createdAt).toISOString();
      const quote = shortenQuote(body);
      const email = emailFor(comment.actor);
      inputs.push({
        kind: 'comment',
        key,
        sessionId,
        by,
        ...(email ? { email } : {}),
        at,
        context,
        quote,
        citation: citationMarkdown({ sessionId, kind: 'comment', key, by, email, at, context: `comment on ${pageTitle}`, quote }),
      });
    }
  }
  return inputs;
}
