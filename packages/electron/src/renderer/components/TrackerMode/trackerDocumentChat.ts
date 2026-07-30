/**
 * The tracker document view's chat is the ordinary chat panel, exactly as a
 * collaborative document's is: opening it does NOT mint a chat "about" the
 * item, and the item is not a conversation of its own.
 *
 * The connected item is *selection state* -- it rides along as document
 * context and is handed to the model when a command is sent, the same way
 * `CollabMode` passes the open document's path. A file-backed item contributes
 * its real path so the agent can read it; a database-only item has no file, so
 * it contributes a context chip telling the agent to read it with the tracker
 * tools. Either way the user can dismiss it, and the session they were already
 * in is the session they stay in.
 */

import type { TrackerRecord } from '@nimbalyst/runtime/core/TrackerRecord';
import {
  getRecordPriority,
  getRecordStatus,
  getRecordTitle,
} from '@nimbalyst/runtime/plugins/TrackerPlugin/trackerRecordAccessors';
import type { SessionMeta } from '../../store/atoms/sessions';
import type { SerializableDocumentContext } from '../../hooks/useDocumentContext';

/**
 * Which session the panel shows. Only an explicit choice counts -- the session
 * the user opened from this item's session list, if it still exists. Anything
 * else is left to the standard sidebar, so the panel behaves like every other
 * chat surface rather than pairing a conversation to the item.
 */
export function resolveTrackerChatSessionId(params: {
  /** Session the user opened for this item, remembered in the tracker layout. */
  pairedSessionId: string | null | undefined;
  sessionRegistry: Map<string, SessionMeta>;
}): string | null {
  const { pairedSessionId, sessionRegistry } = params;
  if (pairedSessionId && sessionRegistry.has(pairedSessionId)) return pairedSessionId;
  return null;
}

/** Stable context-item id, so re-selecting the same item doesn't stack chips. */
export function trackerContextItemId(itemId: string): string {
  return `tracker:${itemId}`;
}

export function buildTrackerDocumentContext(
  itemId: string,
  item?: TrackerRecord | null,
): SerializableDocumentContext {
  const title = item ? getRecordTitle(item) : itemId;
  const key = item?.issueKey || itemId;
  const documentPath = item?.system.documentPath;

  const details: string[] = [];
  if (item?.primaryType) details.push(`type: ${item.primaryType}`);
  const status = item ? getRecordStatus(item) : null;
  if (status) details.push(`status: ${status}`);
  const priority = item ? getRecordPriority(item) : null;
  if (priority) details.push(`priority: ${priority}`);

  // Before the record loads, key and title are both the raw id -- don't
  // render "item-1 item-1" on the chip.
  const label = key === title ? key : `${key} ${title}`.trim();

  const lines = [key === title ? `Tracker item ${key}` : `Tracker item ${key}: ${title}`];
  if (details.length > 0) lines.push(details.join(', '));
  lines.push(documentPath
    // A real file: name it so the agent reads the document directly.
    ? `Document: ${documentPath}`
    // No file to read -- the record's body lives in the tracker store.
    : `Read this item's document with tracker_get id "${key}".`);

  return {
    // Mirrors CollabMode: the open document's path is the context.
    ...(documentPath ? { filePath: documentPath } : {}),
    editorContextItems: [{
      id: trackerContextItemId(itemId),
      label,
      icon: 'label',
      description: lines.join('\n'),
    }],
  };
}
