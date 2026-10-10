/**
 * HeadlessCollabDocEdit
 *
 * Apply an agent's text replacements to a shared collaborative document that
 * nobody has open (NIM-3754, and the write half of NIM-2640).
 *
 * The durability rules here are not new. `MainBodyDocService` learned each of
 * them the hard way landing tracker bodies into live rooms, and a shared
 * document is a strictly harder case than a tracker body -- more people, real
 * concurrent editing, comment anchors:
 *
 *   1. A never-synced peer must not be written through. Its Y.Doc does not
 *      hold the content being replaced, so a clear-then-insert has nothing to
 *      clear and merges into the room as a SECOND copy of the document. The
 *      acquisition enforces this by refusing to hand back an unhydrated doc.
 *   2. Only a server `docUpdateAck` proves the write landed. `flushWithAck`,
 *      never the deprecated fire-and-forget `flushLocalState`, which is how a
 *      mindmap seed was lost.
 *   3. Failure is reported to the agent. A write that did not reach the room
 *      must never come back as success -- the agent's next action assumes its
 *      edit is visible to everyone.
 */
import type { TextReplacement } from '@nimbalyst/runtime';
// Deep path, not the `@nimbalyst/runtime/editor` barrel: the barrel drags the
// whole Lexical editor tree into every consumer and every test that touches
// this module.
import { applyTextReplacementsToString } from '@nimbalyst/runtime/editor/plugins/DiffPlugin/core/diffUtils';

import {
  acquireHeadlessCollabDocument,
  assertDecodable,
  HeadlessCollabDocumentError,
  projectCollabDocContent,
  requireCollabCodec,
  type HeadlessCollabDocumentAcquisition,
  type HeadlessCollabDocumentOptions,
} from './HeadlessCollabDocument';
import { applyMarkdownReplacementsToYDoc } from './headlessMarkdownEdit';
import {
  hasRecentAgentEditRevision,
  recordRevisionBeforeAgentEdit,
  revisionSourceFromAcquisition,
} from './collabAgentEditRevision';
import { pickCursorColor } from '../components/TabEditor/collabCursorColor';

const SERVER_ACK_TIMEOUT_MS = 5_000;

/**
 * Document types whose Y.Doc holds a Lexical tree rather than a codec-owned
 * structure. These reconcile through the editor's own diff path so an edit is a
 * minimal delta; everything else edits its serialized form.
 */
const LEXICAL_BACKED_DOCUMENT_TYPES = new Set(['markdown']);

export interface CollabDocAgentIdentity {
  sessionId: string;
  sessionName: string;
}

export interface HeadlessCollabDocEditOptions
  extends HeadlessCollabDocumentOptions {
  /** Shown to other collaborators as a participant while the edit runs. */
  agent?: CollabDocAgentIdentity;
}

/**
 * Announce the agent as a participant for the life of the edit.
 *
 * Deliberately unlike `MainBodyDocService`, which suppresses awareness: a
 * background field update is not a participant, but an agent rewriting a shared
 * document is, and teammates with the document open should see that.
 *
 * Returns the teardown, which is NOT optional -- an acquisition that dies
 * without sending its departure leaves a ghost participant in every peer's
 * presence list until their own connection recycles.
 */
function announceAgentPresence(
  acquisition: HeadlessCollabDocumentAcquisition,
  agent: CollabDocAgentIdentity | undefined,
): () => void {
  const provider = acquisition.syncProvider;
  if (!agent || typeof provider.sendAwareness !== 'function') return () => {};
  const user = {
    id: agent.sessionId,
    name: agent.sessionName,
    color: pickCursorColor(agent.sessionId),
    isAgent: true,
  };
  void provider.sendAwareness({ user });
  return () => {
    try {
      provider.sendAwarenessDeparture?.(user);
    } catch {
      // Teardown is best-effort; peers still fall back to stale-state cleanup.
    }
  };
}

/**
 * Apply `replacements` to the shared document at `documentUri`.
 *
 * Resolves only once the server has acknowledged the write. Throws otherwise --
 * see rule 3 in the module header.
 */
export async function applyHeadlessCollabDocEdit(
  documentUri: string,
  workspacePath: string,
  replacements: TextReplacement[],
  options: HeadlessCollabDocEditOptions = {},
): Promise<void> {
  if (!Array.isArray(replacements) || replacements.length === 0) {
    throw new HeadlessCollabDocumentError(
      'DOCUMENT_NOT_AVAILABLE',
      'applyCollabDocEdit requires at least one replacement.',
    );
  }

  const acquisition = await acquireHeadlessCollabDocument(
    documentUri,
    workspacePath,
    options,
  );
  const endPresence = announceAgentPresence(acquisition, options.agent);
  try {
    // Overwriting a room we cannot read is how you replace someone else's
    // document with a guess.
    assertDecodable(acquisition, documentUri);

    const codec = requireCollabCodec(acquisition.documentType);
    if (LEXICAL_BACKED_DOCUMENT_TYPES.has(acquisition.documentType)) {
      // The edit lands as final text, so history is the undo.
      if (!hasRecentAgentEditRevision(documentUri)) {
        const source = revisionSourceFromAcquisition(acquisition);
        if (source) await recordRevisionBeforeAgentEdit(documentUri, source);
      }
      applyMarkdownReplacementsToYDoc(acquisition.yDoc, replacements);
    } else {
      const original = projectCollabDocContent(codec, acquisition.yDoc);
      const next = applyTextReplacementsToString(original, replacements);
      if (next === original) return;
      codec.applyFromFile(acquisition.yDoc, next);
    }

    const acked = await acquisition.syncProvider.flushWithAck(
      SERVER_ACK_TIMEOUT_MS,
    );
    if (!acked) {
      throw new HeadlessCollabDocumentError(
        'FLUSH_TIMEOUT',
        `The edit to ${documentUri} was applied locally but the server never acknowledged it, so other collaborators may not have received it.`,
      );
    }
  } finally {
    endPresence();
    acquisition.release();
  }
}
