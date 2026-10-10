/**
 * Reads a member's chapters, workstream, and delegated sessions out of the
 * host's owned-session list. Pure: the runtime passes in `listOwned` rows.
 *
 * Everything Crew knows about its sessions lives in each session's owner
 * metadata, written when the session is created and on each shift:
 *
 *   workstream  { kind: 'workstream' }
 *   chapter     { kind: 'chapter', chapterIndex, startedAt, definitionHash,
 *                 shiftStarts[], lastShiftStartedAt, endedAt?, endReason?,
 *                 handoffSummary? }
 *
 * Any other owned session is delegated work (spawn_session inherits the
 * owner, not the metadata). `lastRunAt` is the latest chapter's last shift and
 * shifts-per-day counts `shiftStarts`, so no table is needed for either.
 */

import type { CrewChapterSummary, CrewDelegatedSession } from '../shared/types';
import type { OwnedSession } from './hostSessions';

/** Enough history to count today's shifts against any sane shiftsPerDay. */
export const MAX_RECORDED_SHIFT_STARTS = 64;

export interface ChapterMeta {
  kind: 'chapter';
  chapterIndex: number;
  startedAt: string;
  definitionHash?: string;
  shiftStarts?: string[];
  lastShiftStartedAt?: string;
  endedAt?: string;
  endReason?: string;
  handoffSummary?: string;
}

export interface ChapterRow {
  session: OwnedSession;
  meta: ChapterMeta;
}

export interface MemberSessions {
  workstreamId?: string;
  /** Oldest first. */
  chapters: ChapterRow[];
  /** The newest chapter that has not been closed. */
  current?: ChapterRow;
  delegated: OwnedSession[];
  lastRunAtMs: number | null;
  shiftStartsMs: number[];
}

function toChapterMeta(metadata: Record<string, unknown>): ChapterMeta | null {
  if (metadata.kind !== 'chapter') return null;
  const index = metadata.chapterIndex;
  const startedAt = metadata.startedAt;
  if (typeof index !== 'number' || !Number.isInteger(index) || typeof startedAt !== 'string') return null;
  const str = (key: string) => (typeof metadata[key] === 'string' ? (metadata[key] as string) : undefined);
  const starts = Array.isArray(metadata.shiftStarts)
    ? metadata.shiftStarts.filter((value): value is string => typeof value === 'string')
    : [];
  return {
    kind: 'chapter',
    chapterIndex: index,
    startedAt,
    shiftStarts: starts,
    ...(str('definitionHash') ? { definitionHash: str('definitionHash') } : {}),
    ...(str('lastShiftStartedAt') ? { lastShiftStartedAt: str('lastShiftStartedAt') } : {}),
    ...(str('endedAt') ? { endedAt: str('endedAt') } : {}),
    ...(str('endReason') ? { endReason: str('endReason') } : {}),
    ...(str('handoffSummary') ? { handoffSummary: str('handoffSummary') } : {}),
  };
}

export function indexMemberSessions(sessions: readonly OwnedSession[]): MemberSessions {
  const chapters: ChapterRow[] = [];
  const delegated: OwnedSession[] = [];
  let workstreamId: string | undefined;
  for (const session of sessions) {
    const metadata = session.ownerMetadata ?? {};
    if (metadata.kind === 'workstream' || session.sessionType === 'workstream') {
      workstreamId ??= session.sessionId;
      continue;
    }
    const meta = toChapterMeta(metadata);
    if (meta) chapters.push({ session, meta });
    else if (metadata.kind === undefined) delegated.push(session);
  }
  chapters.sort((a, b) => a.meta.chapterIndex - b.meta.chapterIndex);
  const open = chapters.filter((chapter) => !chapter.meta.endedAt);
  const shiftStartsMs = chapters
    .flatMap((chapter) => chapter.meta.shiftStarts ?? [])
    .map((iso) => Date.parse(iso))
    .filter((ms) => Number.isFinite(ms));
  const lastRuns = chapters
    .map((chapter) => Date.parse(chapter.meta.lastShiftStartedAt ?? ''))
    .filter((ms) => Number.isFinite(ms));
  return {
    ...(workstreamId ? { workstreamId } : {}),
    chapters,
    ...(open.length > 0 ? { current: open[open.length - 1] } : {}),
    delegated,
    lastRunAtMs: lastRuns.length > 0 ? Math.max(...lastRuns) : null,
    shiftStartsMs,
  };
}

export function nextChapterIndex(index: MemberSessions): number {
  return index.chapters.reduce((max, chapter) => Math.max(max, chapter.meta.chapterIndex), 0) + 1;
}

/** The metadata patch that records a shift starting in `chapter`. */
export function shiftStartPatch(meta: Pick<ChapterMeta, 'shiftStarts'>, atIso: string): Partial<ChapterMeta> {
  const starts = [...(meta.shiftStarts ?? []), atIso].slice(-MAX_RECORDED_SHIFT_STARTS);
  return { shiftStarts: starts, lastShiftStartedAt: atIso };
}

export function countSince(instantsMs: readonly number[], sinceMs: number): number {
  return instantsMs.filter((ms) => ms >= sinceMs).length;
}

export function chapterSummaries(index: MemberSessions): CrewChapterSummary[] {
  return index.chapters.map(({ session, meta }) => ({
    sessionId: session.sessionId,
    chapterIndex: meta.chapterIndex,
    startedAt: meta.startedAt,
    ...(meta.endedAt ? { endedAt: meta.endedAt } : {}),
    ...(meta.endReason ? { endReason: meta.endReason } : {}),
    ...(meta.handoffSummary ? { handoffSummary: meta.handoffSummary } : {}),
    isCurrent: index.current?.session.sessionId === session.sessionId,
  }));
}

export function delegatedSummaries(index: MemberSessions): CrewDelegatedSession[] {
  return index.delegated.map((session) => ({
    sessionId: session.sessionId,
    name: session.title,
    status: session.status,
    ...(session.createdBySessionId ? { parentSessionId: session.createdBySessionId } : {}),
    ...(session.createdAt ? { createdAt: new Date(session.createdAt).toISOString() } : {}),
    hasPendingPrompt: session.hasPendingPrompt,
  }));
}
