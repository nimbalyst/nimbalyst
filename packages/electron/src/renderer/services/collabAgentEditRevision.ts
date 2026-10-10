/**
 * collabAgentEditRevision
 *
 * Record a version-history revision of a shared markdown document just before
 * an agent edits it.
 *
 * Agent edits to shared documents land directly, with no Keep/Revert (see
 * `agentEditsApplyDirectly`), so the document's history is how a person undoes
 * one. The history's own auto snapshots only fire after the document has been
 * idle with a tab open, so on their own they routinely miss the state an agent
 * edit replaced.
 *
 * One revision per burst: an agent making several edits in a row gets a single
 * restore point from before the first, rather than one per replacement.
 *
 * Best-effort. A history server that is down or slow must not stop the edit,
 * so failures are logged and the edit proceeds.
 */
import { CollabHistoryClient } from '@nimbalyst/runtime/sync/collabHistoryClient';

import { getCollabHistoryController } from '../store/atoms/collabHistoryControllers';
import {
  projectCollabDocContent,
  requireCollabCodec,
  type HeadlessCollabDocumentAcquisition,
} from './HeadlessCollabDocument';

export const AGENT_EDIT_REVISION_BURST_MS = 2 * 60_000;
const RECORD_TIMEOUT_MS = 5_000;

/** Where the pre-edit content and the history client come from. */
export interface AgentEditRevisionSource {
  createRevision: CollabHistoryClient['createRevision'];
  markdown: string;
  basisSequence: number;
}

const lastRecordedAt = new Map<string, number>();

/** Test seam. */
export function resetAgentEditRevisionBursts(): void {
  lastRecordedAt.clear();
}

/** True when this URI already has a restore point for the current burst. */
export function hasRecentAgentEditRevision(documentUri: string, now = Date.now()): boolean {
  const at = lastRecordedAt.get(documentUri);
  return at !== undefined && now - at < AGENT_EDIT_REVISION_BURST_MS;
}

/**
 * Record `source.markdown` as an `auto` revision of `documentUri`, unless the
 * current burst already has one. Never throws.
 */
export async function recordRevisionBeforeAgentEdit(
  documentUri: string,
  source: AgentEditRevisionSource,
  now = Date.now(),
): Promise<boolean> {
  if (hasRecentAgentEditRevision(documentUri, now)) return false;
  if (source.markdown.length === 0) return false;
  try {
    const created = source.createRevision({
      revisionKind: 'auto',
      editorType: 'markdown',
      contentFormat: 'markdown',
      plaintext: new TextEncoder().encode(source.markdown),
      basisSequence: source.basisSequence,
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('timed out')), RECORD_TIMEOUT_MS);
    });
    try {
      await Promise.race([created, timedOut]);
    } finally {
      clearTimeout(timer);
    }
    lastRecordedAt.set(documentUri, now);
    return true;
  } catch (error) {
    console.warn(
      `[collabAgentEditRevision] Could not record the pre-edit revision of ${documentUri}; applying the agent edit anyway.`,
      error,
    );
    return false;
  }
}

/**
 * The source for a document open in a collab tab, which publishes a history
 * controller. Null when no markdown tab has the document open.
 */
export function revisionSourceFromOpenTab(documentUri: string): AgentEditRevisionSource | null {
  const controller = getCollabHistoryController(documentUri);
  if (!controller || controller.editorType !== 'markdown' || !controller.exportSnapshot) {
    return null;
  }
  if (controller.getStatus() !== 'connected') return null;
  const snapshot = controller.exportSnapshot();
  if (!(snapshot instanceof Uint8Array)) return null;
  return {
    createRevision: (input) => controller.client.createRevision(input),
    markdown: new TextDecoder().decode(snapshot),
    basisSequence: controller.getBasisSequence(),
  };
}

/**
 * The source for a document reached through the room provider (no tab open,
 * or open only as an embed, which shares this provider). Null for non-markdown
 * documents and for a provider that cannot reach the history endpoint.
 */
export function revisionSourceFromAcquisition(
  acquisition: Pick<HeadlessCollabDocumentAcquisition, 'documentType' | 'config' | 'syncProvider' | 'yDoc'>,
): AgentEditRevisionSource | null {
  if (acquisition.documentType !== 'markdown') return null;
  const { config, syncProvider } = acquisition;
  if (!config.serverUrl || !config.getJwt || !config.documentId) return null;
  if (typeof syncProvider.getLastSeq !== 'function') return null;
  const client = new CollabHistoryClient({
    serverUrl: config.serverUrl,
    getJwt: config.getJwt,
    urlExtraQuery: config.urlExtraQuery,
    orgId: config.orgId,
    documentId: config.documentId,
  });
  return {
    createRevision: (input) => client.createRevision(input),
    markdown: projectCollabDocContent(requireCollabCodec('markdown'), acquisition.yDoc),
    basisSequence: syncProvider.getLastSeq(),
  };
}
