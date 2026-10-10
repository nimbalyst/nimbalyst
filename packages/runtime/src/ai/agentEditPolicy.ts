/**
 * Whether an agent's edit to a document lands as final text or as a pending
 * red/green diff for review.
 *
 * Shared collaborative documents (`collab://`) take the edit directly. Several
 * people and agents edit them at once, and a diff only the requester can
 * resolve leaves everyone else looking at both versions of the text. The
 * document's version history is the undo: the agent edit path records a
 * revision of the pre-edit content first.
 *
 * Personal pages (`personal-doc://`, the editor path of a `personal://` tab)
 * follow the shared pages they sit beside: agent edits to pages land directly
 * and the page's local history is the undo. A Local wiki page is a markdown
 * file inside the workspace's wiki folder, which the host registers with
 * `setLocalWikiRoot`; it is a page like any other and follows the same rule.
 *
 * Other files on disk keep the pending diff, because the person who asked for
 * the edit is the one reviewing it.
 */
import { isCollabUri } from '@nimbalyst/collab-protocol';
import { isInLocalWikiRoot } from '../core/localWikiRoots';

const PERSONAL_PAGE_EDITOR_PREFIX = 'personal-doc://';

export function agentEditsApplyDirectly(documentPath: string | null | undefined): boolean {
  return typeof documentPath === 'string'
    && (isCollabUri(documentPath) || documentPath.startsWith(PERSONAL_PAGE_EDITOR_PREFIX) || isInLocalWikiRoot(documentPath));
}
