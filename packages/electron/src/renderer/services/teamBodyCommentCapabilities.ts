/**
 * Comment capabilities for a collaborative body (a team page or a typed page /
 * tracker item body) opened in the desktop app, derived from the viewer's
 * project role.
 *
 * Only a resolved `project-commenter` changes the answer: it reads and
 * comments but never writes the body, so the editor gets
 * `{ read: true, comment: true, editBody: false }` (commenter mode). Every
 * other outcome keeps the long-standing open answer, because reaching a
 * mounted collaborative editor already implies the sync lifecycle authorized
 * the user, and a stale or missing local projection (no roster yet, db not
 * ready) must not lock an editor out of a document the server lets them edit.
 * The server stays authoritative: it refuses any commenter update that changes
 * more than the `comments` array.
 */
import { useEffect, useRef, useState } from 'react';
import type { CommentCapabilities } from '@nimbalyst/runtime/editor/commenting/types';
import type { DocumentAccessVerdict, DocumentSyncProvider } from '@nimbalyst/runtime/sync/DocumentSync';

export type TeamBodyAccessCheck = (input: {
  orgId?: string | null;
  projectId?: string | null;
  action: 'view' | 'comment' | 'edit' | 'admin';
}) => Promise<{ allowed: boolean; projectRole?: string | null }>;

export const OPEN_BODY_COMMENT_CAPABILITIES: CommentCapabilities = Object.freeze({
  read: true,
  comment: true,
});

export const COMMENTER_BODY_COMMENT_CAPABILITIES: CommentCapabilities = Object.freeze({
  read: true,
  comment: true,
  editBody: false,
});

export async function resolveTeamBodyCommentCapabilities(
  canAccess: TeamBodyAccessCheck,
  input: { orgId: string | null | undefined; projectId: string | null | undefined },
): Promise<CommentCapabilities> {
  // Org-level content has no project role, so there is no commenter tier.
  if (!input.projectId) return OPEN_BODY_COMMENT_CAPABILITIES;
  try {
    const access = await canAccess({ orgId: input.orgId, projectId: input.projectId, action: 'view' });
    if (access.allowed && access.projectRole === 'project-commenter') {
      return COMMENTER_BODY_COMMENT_CAPABILITIES;
    }
  } catch (error) {
    console.warn('[teamBodyCommentCapabilities] canAccess failed; keeping the open answer', error);
  }
  return OPEN_BODY_COMMENT_CAPABILITIES;
}

function getAccessCheck(): TeamBodyAccessCheck | undefined {
  const org = (window.electronAPI as unknown as { org?: { canAccess?: TeamBodyAccessCheck } } | undefined)?.org;
  return typeof org?.canAccess === 'function' ? org.canAccess : undefined;
}

/**
 * Resolve once per (org, project) and hold the answer in state so a change
 * re-renders the editor with a new comments config. Request/response IPC
 * only; no listener is subscribed.
 */
export function useTeamBodyCommentCapabilities(
  orgId: string | null | undefined,
  projectId: string | null | undefined,
): CommentCapabilities {
  const [capabilities, setCapabilities] = useState<CommentCapabilities>(OPEN_BODY_COMMENT_CAPABILITIES);
  useEffect(() => {
    const canAccess = getAccessCheck();
    if (!canAccess || !projectId) {
      setCapabilities(OPEN_BODY_COMMENT_CAPABILITIES);
      return;
    }
    let cancelled = false;
    void resolveTeamBodyCommentCapabilities(canAccess, { orgId, projectId }).then((next) => {
      if (!cancelled) setCapabilities(next);
    });
    return () => {
      cancelled = true;
    };
  }, [orgId, projectId]);
  return capabilities;
}

export const READ_ONLY_BODY_COMMENT_CAPABILITIES: CommentCapabilities = Object.freeze({
  read: true,
  comment: false,
  editBody: false,
});

/**
 * The room's `docSyncResponse` verdict outranks the local projection: the
 * server is the authority, and a stale or missing projection must not leave a
 * commenter with an editable body whose first write the room refuses (close
 * 4009, terminal for the Y.Doc). Without a verdict yet, the projection answers.
 */
export function bodyCommentCapabilitiesWithVerdict(
  projection: CommentCapabilities,
  verdict: DocumentAccessVerdict | null,
): CommentCapabilities {
  if (!verdict) return projection;
  if (verdict.canWrite) return OPEN_BODY_COMMENT_CAPABILITIES;
  // canComment null: a server that predates the comment tier, where a
  // non-writer is a read-only viewer.
  return verdict.canComment === true ? COMMENTER_BODY_COMMENT_CAPABILITIES : READ_ONLY_BODY_COMMENT_CAPABILITIES;
}

/**
 * Reloads in a row after a refused commenter update before the surface stops.
 * A correct client never trips the refusal; one that trips it on every fresh
 * mount must not reload forever. Matches the web console.
 */
export const MAX_COMMENT_REFUSAL_RELOADS = 2;

export const COMMENT_NOT_SAVED_TITLE = 'Your last comment was not saved';
export const COMMENT_NOT_SAVED_MESSAGE =
  'The page was reloaded from the server; add the comment again.';
export const COMMENT_REFUSAL_STOPPED_MESSAGE =
  'Comments on this page could not be saved. Close the page and open it again later.';

export type CommentRefusalPlan = 'reload' | 'stop';

/** What to do with the refusal that just arrived, given how many reloads it already caused. */
export function commentRefusalPlan(reloadsSoFar: number): CommentRefusalPlan {
  return reloadsSoFar < MAX_COMMENT_REFUSAL_RELOADS ? 'reload' : 'stop';
}

/**
 * Follow a provider's room verdict and its terminal comment refusal. Pass the
 * current provider (it changes on every reopen). `onRefused` is read through a
 * ref so a new closure does not resubscribe.
 */
export function useDocumentServerAccess(
  syncProvider: Pick<DocumentSyncProvider, 'getServerAccessVerdict' | 'onAccessVerdict' | 'onCommentUpdateRefused'> | null,
  onRefused: () => void,
): DocumentAccessVerdict | null {
  const [verdict, setVerdict] = useState<DocumentAccessVerdict | null>(null);
  const onRefusedRef = useRef(onRefused);
  onRefusedRef.current = onRefused;
  useEffect(() => {
    if (!syncProvider) {
      setVerdict(null);
      return;
    }
    setVerdict(syncProvider.getServerAccessVerdict());
    const unsubscribeVerdict = syncProvider.onAccessVerdict(setVerdict);
    const unsubscribeRefusal = syncProvider.onCommentUpdateRefused(() => onRefusedRef.current());
    return () => {
      unsubscribeVerdict();
      unsubscribeRefusal();
    };
  }, [syncProvider]);
  return verdict;
}

/**
 * Comment capabilities for a non-markdown (extension editor) page. In v1 a
 * user who cannot write the body gets read-only, no-comment access there: an
 * extension's comment anchors (mockup pins) live outside `comments`, so a
 * commenter's thread would be refused and end the session.
 */
export function extensionCommentCapabilities(
  base: CommentCapabilities,
  body: CommentCapabilities,
): CommentCapabilities {
  if (body.editBody === false) return { read: base.read, comment: false, editBody: false };
  return { read: base.read, comment: base.comment && body.comment };
}
