/**
 * IPC for a page's Links section (body links and relationship fields, both
 * directions), the cross-page marks list, plus the remote-body indexer that
 * keeps teammates' links current.
 */

import { globalRegistry } from '@nimbalyst/tracker-schema';
import { database } from '../database/PGLiteDatabaseWorker';
import { getTrackerItemLinks } from '../services/tracker/trackerPageLinks';
import { safeHandle } from '../utils/ipcRegistry';
import { onTrackerItemApplied } from '../services/TrackerSyncManager';
import { readHeadlessBodyMarkdown } from '../services/MainBodyDocService';
import { startRemoteBodyLinkIndexing } from '../services/tracker/trackerRemoteBodyLinks';
import { queryPageMarks } from '../services/pageMarks/pageMarksQuery';
import { getLocalWikiService } from '../services/localWiki/LocalWikiService';
import { localWikiPageMarks } from '../services/localWiki/localWikiPageMarks';
import type { PageMarksQuery } from '@nimbalyst/collab-client/pages';

export function registerTrackerPageLinkHandlers(): void {
  // Workspace-scoped: `workspacePath` is required and every read is constrained
  // to it, so an id from another workspace cannot surface that workspace's pages.
  safeHandle('document-service:tracker-item-links', async (_event, payload: { workspacePath?: unknown; itemId?: unknown }) => {
    if (typeof payload?.workspacePath !== 'string' || !payload.workspacePath) {
      return { success: false, error: 'workspacePath is required' };
    }
    if (typeof payload.itemId !== 'string' || !payload.itemId) {
      return { success: false, error: 'itemId is required' };
    }
    try {
      const links = await getTrackerItemLinks(
        payload.workspacePath,
        payload.itemId,
        (type) => globalRegistry.get(type)?.fields ?? [],
        database as any,
      );
      return { success: true, links };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  // Decision and open-question marks across the pages readable locally.
  safeHandle('page-marks:list', async (_event, payload: { workspacePath?: unknown; query?: PageMarksQuery }) => {
    if (typeof payload?.workspacePath !== 'string' || !payload.workspacePath) {
      return { success: false, error: 'workspacePath is required' };
    }
    try {
      const workspacePath = payload.workspacePath;
      const marks = await queryPageMarks(database as any, workspacePath, payload.query ?? {},
        async () => localWikiPageMarks(await getLocalWikiService().wikiFor(workspacePath)));
      return { success: true, marks };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  // A teammate's body edit arrives as a bodyVersion bump only; fetch the room
  // body so their links show up here without a local save.
  startRemoteBodyLinkIndexing({
    onItemApplied: onTrackerItemApplied,
    readBody: readHeadlessBodyMarkdown,
    db: database as any,
  });
}
