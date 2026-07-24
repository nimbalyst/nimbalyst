/**
 * PR ↔ tracker ↔ session context for the PR view.
 *
 * Resolves, for one PR (or a whole remote), the tracker items referencing it
 * and the sessions attached to those items or to the PR's worktree. All
 * tracker/session resolution is reference-based — no tracker type name is
 * privileged (see prReferences.ts).
 */

import { useEffect, useMemo, useState } from 'react';
import { useAtomValue } from 'jotai';
import type { TrackerRecord } from '@nimbalyst/runtime/core/TrackerRecord';
import { prTrackerReferencesAtom } from '@nimbalyst/runtime/plugins/TrackerPlugin/prReferences';
import { sessionRegistryAtom, type SessionMeta } from '../../store/atoms/sessions';
import { resolveLinkedSessions } from '../../utils/resolveLinkedSessions';

/** Referencing tracker items for every PR number of a remote (lowercased key). */
export function usePrTrackerReferences(remote: string | null): Map<number, TrackerRecord[]> {
  return useAtomValue(prTrackerReferencesAtom(remote ?? ''));
}

export interface PrTrackerContext {
  /** Tracker items referencing this PR, most recently updated first. */
  items: TrackerRecord[];
  /** The primary (most recently updated) referencing item, for badges. */
  primary: TrackerRecord | null;
  /** Sessions linked to any referencing item or to the PR's worktree. */
  sessions: SessionMeta[];
}

export function usePrTrackerContext(
  workspacePath: string,
  remote: string | null,
  prNumber: number,
): PrTrackerContext {
  const references = usePrTrackerReferences(remote);
  const sessionRegistry = useAtomValue(sessionRegistryAtom);
  const items = useMemo(() => references.get(prNumber) ?? [], [references, prNumber]);

  // The worktree linked to this PR (created via "Open in Worktree"). One-shot
  // lookup — worktree↔PR links only change through that action, and the panel
  // remounts per selected PR.
  const [worktreeId, setWorktreeId] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setWorktreeId(null);
    if (!remote) return;
    window.electronAPI
      .invoke('worktree:list', workspacePath)
      .then((worktrees: Array<{ id: string; prNumber?: number; prRemote?: string }>) => {
        if (cancelled || !Array.isArray(worktrees)) return;
        const match = worktrees.find(
          (w) => w.prNumber === prNumber && w.prRemote?.toLowerCase() === remote.toLowerCase(),
        );
        setWorktreeId(match?.id ?? null);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [workspacePath, remote, prNumber]);

  const sessions = useMemo(() => {
    const byId = new Map<string, SessionMeta>();
    for (const item of items) {
      for (const session of resolveLinkedSessions(item, sessionRegistry)) {
        byId.set(session.id, session);
      }
    }
    if (worktreeId) {
      sessionRegistry.forEach((session) => {
        if (session.worktreeId === worktreeId) byId.set(session.id, session);
      });
    }
    return Array.from(byId.values()).sort((a, b) => b.updatedAt - a.updatedAt);
  }, [items, sessionRegistry, worktreeId]);

  return { items, primary: items[0] ?? null, sessions };
}

/**
 * Session-link presence per tracker item id, for cheap list-row dots.
 * Counts reverse links (session → item); combine with the item's forward
 * linkedSessions when testing presence.
 */
export function useSessionCountsByTrackerItem(): Map<string, number> {
  const sessionRegistry = useAtomValue(sessionRegistryAtom);
  return useMemo(() => {
    const counts = new Map<string, number>();
    sessionRegistry.forEach((session) => {
      for (const ref of session.linkedTrackerItemIds || []) {
        counts.set(ref, (counts.get(ref) || 0) + 1);
      }
    });
    return counts;
  }, [sessionRegistry]);
}
