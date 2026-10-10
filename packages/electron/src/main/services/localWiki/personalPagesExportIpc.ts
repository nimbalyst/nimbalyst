/**
 * IPC for the database Personal pages that predate the Local wiki: the
 * read-only view of what is not exported yet, the user-initiated Export, and
 * the launch heartbeat for the rows that stay behind.
 */
import { getDatabase } from '../../database/initialize';
import { safeHandle } from '../../utils/ipcRegistry';
import { logger } from '../../utils/logger';
import { AnalyticsService } from '../analytics/AnalyticsService';
import type { PersonalPagesDb } from '../personalPages/personalPagesStore';
import type { LocalWikiService } from './LocalWikiService';
import {
  exportPersonalPages,
  legacyPersonalPagesCensus,
  legacyPersonalSnapshot,
  type ExportPhase,
} from './personalPagesExport';

function requireDb(): PersonalPagesDb {
  const db = getDatabase() as PersonalPagesDb | null;
  if (!db) throw new Error('Database not initialized');
  return db;
}

function requireWorkspace(workspacePath: unknown): string {
  if (!workspacePath || typeof workspacePath !== 'string') throw new Error('workspacePath is required');
  return workspacePath;
}

function emitExportPhase(phase: ExportPhase, details: Record<string, unknown>): void {
  if (phase === 'failed') logger.main.error('[LocalWikiExport] Export of database Personal pages failed', details);
  else logger.main.warn(`[LocalWikiExport] Export of database Personal pages ${phase}`, details);
  try {
    const { workspacePath: _ws, root: _root, error: _error, ...counts } = details;
    AnalyticsService.getInstance().sendEvent('local_wiki_export', { phase, ...counts });
  } catch (error) {
    logger.main.warn('[LocalWikiExport] Could not send the export event', { error });
  }
}

export function registerPersonalPagesExportIpc(service: LocalWikiService): void {
  safeHandle('local-wiki:legacy-snapshot', async (_event, workspacePath: string) => {
    const ws = requireWorkspace(workspacePath);
    const wiki = await service.snapshot(ws);
    return legacyPersonalSnapshot(requireDb(), ws, wiki.exists ? wiki : null);
  });

  safeHandle('local-wiki:export-personal-pages', async (_event, workspacePath: string) => {
    const ws = requireWorkspace(workspacePath);
    const report = await exportPersonalPages({
      db: requireDb(),
      workspacePath: ws,
      wiki: async () => {
        const wiki = await service.wikiFor(ws, true);
        if (!wiki) throw new Error('The local wiki folder could not be created');
        return wiki;
      },
      emit: emitExportPhase,
    });
    service.announceChange(ws);
    return report;
  });

  safeHandle('local-wiki:page-path', async (_event, workspacePath: string, id: string) =>
    service.pageFilePath(requireWorkspace(workspacePath), id));
}

/** Launch heartbeat: how many database Personal page rows are still around. Never throws. */
export async function logLegacyPersonalPagesHeartbeat(): Promise<void> {
  try {
    const db = getDatabase() as PersonalPagesDb | null;
    if (!db) return;
    const census = await legacyPersonalPagesCensus(db);
    if (census.documents === 0 && census.typePlacements === 0 && census.itemPlacements === 0) return;
    logger.main.info('[LocalWikiExport] heartbeat: database Personal pages still present (kept until a later release)', census);
  } catch (error) {
    logger.main.warn('[LocalWikiExport] heartbeat: could not count database Personal pages', { error });
  }
}
