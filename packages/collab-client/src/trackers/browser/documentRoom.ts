/**
 * A document room opened headlessly in a browser, and its text read back as
 * markdown: what Set type needs to copy a page and to check the typed page's
 * body afterwards, with no editor mounted. Same room and codec as
 * `seedTrackerBody`, which writes the other half.
 */
import { decodeStateVector, encodeStateAsUpdate, encodeStateVector } from 'yjs';
import type { TeamJwt, TeamMemberId } from '@nimbalyst/runtime/auth/jwtScopes';
import { DocumentSyncProvider } from '@nimbalyst/runtime/sync/DocumentSync';
import { lexicalYDocToMarkdown } from '@nimbalyst/runtime/sync/markdownYDoc';
import type { TrackerBodyRoom } from './trackerBodyRoom';

export interface BrowserDocumentRoomOptions {
  serverUrl: string;
  orgId: string;
  documentId: string;
  teamMemberId: TeamMemberId;
  getTeamJwt: () => Promise<TeamJwt>;
  createWebSocket?: (url: string) => WebSocket;
}

export function openBrowserDocumentRoom(options: BrowserDocumentRoomOptions): TrackerBodyRoom {
  return new DocumentSyncProvider({
    serverUrl: options.serverUrl,
    orgId: options.orgId,
    documentId: options.documentId,
    teamMemberId: options.teamMemberId,
    getJwt: () => options.getTeamJwt(),
    ...(options.createWebSocket ? { createWebSocket: options.createWebSocket } : {}),
  });
}

const SYNC_TIMEOUT_MS = 10_000;

function waitForSync(room: TrackerBodyRoom, timeoutMs: number): Promise<void> {
  if (room.isSynced()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error('the document did not finish loading'));
    }, timeoutMs);
    const unsubscribe = room.onStatusChange((status) => {
      if (!room.isSynced() && status !== 'error') return;
      clearTimeout(timer);
      unsubscribe();
      if (room.isSynced()) resolve();
      else reject(new Error('the document could not be opened'));
    });
  });
}

/**
 * The room's text as markdown, once it has synced; '' for a room with no
 * history. Throws when the room cannot be read, never guesses. Closes the room.
 */
export async function readDocumentRoomMarkdown(room: TrackerBodyRoom, timeoutMs = SYNC_TIMEOUT_MS): Promise<string> {
  try {
    void room.connect();
    await waitForSync(room, timeoutMs);
    if (room.hasUndecodedContent()) throw new Error('the document has content this browser cannot read');
    const doc = room.getYDoc();
    if (decodeStateVector(encodeStateVector(doc)).size === 0) return '';
    return lexicalYDocToMarkdown(encodeStateAsUpdate(doc));
  } finally {
    room.destroy();
  }
}
