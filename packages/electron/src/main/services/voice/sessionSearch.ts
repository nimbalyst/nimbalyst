/**
 * Shared voice session search.
 *
 * Used by BOTH the local desktop voice agent (VoiceModeService.setOnListSessions)
 * and the mobile voice-tool proxy (mobileVoiceToolHandler), so the iOS agent gets
 * the exact same semantic, memory-backed session lookup the desktop agent has:
 * the memory engine's hybrid dense+BM25 retrieval (restricted to the 'sessions'
 * source class) matches a session by what it was working on even when the title
 * doesn't contain the words, then full-text search over titles + transcripts is
 * merged so nothing regresses when the engine is unavailable or a session was
 * created since the last index backfill. No query => most recent sessions.
 */

import { AISessionsRepository, type SessionMeta } from '@nimbalyst/runtime';
import { SemanticCatalogService } from '../SemanticCatalogService';
import { getDatabase } from '../../database/initialize';

export interface VoiceSessionResult {
  id: string;
  title: string;
  status: string;
  lastActive: string;
}

export interface VoiceSessionSearchResult {
  success: boolean;
  sessions?: VoiceSessionResult[];
  error?: string;
}

/** Human-friendly "last active" string for a session timestamp (ms). */
function formatRelativeTime(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 0) return 'just now';
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} day${days === 1 ? '' : 's'} ago`;
  const months = Math.floor(days / 30);
  return `${months} month${months === 1 ? '' : 's'} ago`;
}

/**
 * Find sessions in a workspace for the voice agent.
 * @param workspacePath The workspace to search within.
 * @param query Optional topic; when present, semantic + FTS. When empty, recent.
 */
export async function searchSessionsForVoice(
  workspacePath: string,
  query?: string,
): Promise<VoiceSessionSearchResult> {
  try {
    const trimmed = query?.trim() ?? '';

    // All sessions, keyed by id, so semantic hits can be enriched with
    // title + last-active time regardless of which search path produced them.
    const all = await AISessionsRepository.list(workspacePath);
    const metaById = new Map(all.map((s) => [s.id, s]));

    const ordered: SessionMeta[] = [];
    const seen = new Set<string>();
    const push = (meta?: SessionMeta): void => {
      if (meta && !seen.has(meta.id)) {
        seen.add(meta.id);
        ordered.push(meta);
      }
    };

    if (trimmed) {
      // Session-scoped semantic search first (conceptual recall).
      if (SemanticCatalogService.getInstance().isAvailable(workspacePath)) {
        const hits = await SemanticCatalogService.getInstance().query(workspacePath, trimmed, 20, [
          'sessions',
        ]);
        for (const hit of hits) {
          if (hit.refType === 'session') push(metaById.get(hit.refId));
        }
      }
      // Merge FTS over titles + transcripts (exact terms + freshly created
      // sessions not yet indexed).
      try {
        for (const s of await AISessionsRepository.search(workspacePath, trimmed)) {
          push(metaById.get(s.id) ?? s);
        }
      } catch {
        // FTS is a best-effort supplement.
      }
    } else {
      // No query: most recent sessions.
      for (const s of all) push(s);
    }

    const top = ordered.slice(0, 20);

    // Running status from the database.
    const ids = top.map((s) => s.id);
    const statusMap = new Map<string, string>();
    if (ids.length > 0) {
      try {
        const db = getDatabase();
        const { rows } = await db.query<{ id: string; status: string }>(
          `SELECT id, status FROM ai_sessions WHERE id = ANY($1)`,
          [ids],
        );
        for (const row of rows) {
          statusMap.set(row.id, row.status);
        }
      } catch {
        // Non-critical.
      }
    }

    const sessions = top.map((s) => ({
      id: s.id,
      title: s.title,
      status: statusMap.get(s.id) || 'idle',
      lastActive: formatRelativeTime(s.updatedAt),
    }));

    return { success: true, sessions };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}
