/**
 * Session Mention Atoms
 *
 * Provides Jotai-based state management for @@ session mentions in AIInput.
 * Filters the in-memory session registry by title -- no IPC needed.
 *
 * Pattern follows fileMention.ts:
 * - sessionMentionOptionsAtom: workspace-scoped TypeaheadOption[]
 * - searchSessionMentionAtom: write-only atom that filters sessionRegistryAtom
 */

import React from 'react';
import { atom } from 'jotai';
import { ProviderIcon } from '@nimbalyst/runtime';
import { atomFamily } from '../debug/atomFamilyRegistry';
import type { TypeaheadOption } from '../../components/Typeahead/GenericTypeahead';
import { sessionRegistryAtom } from './sessions';

// ============================================================
// Base Atoms
// ============================================================

/**
 * Search results for session mentions, stored as TypeaheadOption[] ready for display.
 */
export const sessionMentionOptionsAtom = atomFamily((_workspacePath: string) =>
  atom<TypeaheadOption[]>([])
);

// ============================================================
// Helpers
// ============================================================

/**
 * Format a relative time string from a timestamp.
 */
function relativeTime(timestamp: number): string {
  const now = Date.now();
  const diffMs = now - timestamp;
  const diffMin = Math.floor(diffMs / 60_000);
  const diffHr = Math.floor(diffMs / 3_600_000);
  const diffDay = Math.floor(diffMs / 86_400_000);

  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHr < 24) return `${diffHr}h ago`;
  if (diffDay < 30) return `${diffDay}d ago`;
  return `${Math.floor(diffDay / 30)}mo ago`;
}

/**
 * Worktree icon SVG matching the one rendered in SessionListItem for sessions
 * tied to a git worktree.
 */
const WORKTREE_ICON = React.createElement(
  'svg',
  {
    width: 16,
    height: 16,
    viewBox: '0 0 16 16',
    fill: 'none',
    xmlns: 'http://www.w3.org/2000/svg',
  },
  React.createElement('rect', { x: 3, y: 2, width: 3, height: 3, rx: 0.5, stroke: 'currentColor', strokeWidth: 1.5, fill: 'none' }),
  React.createElement('rect', { x: 10, y: 2, width: 3, height: 3, rx: 0.5, stroke: 'currentColor', strokeWidth: 1.5, fill: 'none' }),
  React.createElement('rect', { x: 3, y: 11, width: 3, height: 3, rx: 0.5, stroke: 'currentColor', strokeWidth: 1.5, fill: 'none' }),
  React.createElement('path', { d: 'M4.5 5v3.5a1.5 1.5 0 0 0 1.5 1.5h4', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' }),
  React.createElement('path', { d: 'M11.5 5v5', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' })
);

/**
 * Phase styles matching SessionListItem.tsx so the typeahead is visually
 * consistent with the main session list.
 */
const PHASE_STYLES: Record<string, { label: string; color: string; bg: string }> = {
  backlog: { label: 'Backlog', color: 'var(--nim-text-faint)', bg: 'rgba(128,128,128,0.12)' },
  planning: { label: 'Planning', color: 'var(--nim-primary)', bg: 'rgba(96,165,250,0.12)' },
  implementing: { label: 'Implementing', color: 'var(--nim-warning)', bg: 'rgba(251,191,36,0.12)' },
  validating: { label: 'Validating', color: '#a78bfa', bg: 'rgba(167,139,250,0.12)' },
  complete: { label: 'Complete', color: 'var(--nim-success)', bg: 'rgba(74,222,128,0.12)' },
};

function buildDescription(updatedAt: number, phase?: string): React.ReactElement {
  const time = React.createElement(
    'span',
    { className: 'whitespace-nowrap' },
    relativeTime(updatedAt)
  );

  const style = phase ? PHASE_STYLES[phase] : undefined;
  const badge = style
    ? React.createElement(
        'span',
        {
          className: 'text-[0.5625rem] leading-tight px-1 py-px rounded font-medium whitespace-nowrap',
          style: { color: style.color, backgroundColor: style.bg },
        },
        style.label
      )
    : null;

  return React.createElement(
    'span',
    { className: 'flex items-center gap-1.5' },
    time,
    badge
  );
}

// ============================================================
// Action Atoms
// ============================================================

/**
 * Search for sessions matching a query by filtering the in-memory session registry.
 * Results are stored directly in sessionMentionOptionsAtom.
 */
export const searchSessionMentionAtom = atom(
  null,
  (get, set, { workspacePath, query, excludeSessionId }: {
    workspacePath: string;
    query: string;
    excludeSessionId?: string;
  }) => {
    const registry = get(sessionRegistryAtom);
    const lowerQuery = query.toLowerCase().trim();

    // Filter sessions: regular sessions only, exclude current
    let sessions = Array.from(registry.values()).filter(s => {
      if (s.sessionType !== 'session') return false;
      if (excludeSessionId && s.id === excludeSessionId) return false;
      if (!lowerQuery) return true;
      return (s.title || '').toLowerCase().includes(lowerQuery);
    });

    // Sort by most recently updated
    sessions.sort((a, b) => b.updatedAt - a.updatedAt);

    // Limit to 10 results
    sessions = sessions.slice(0, 10);

    const options: TypeaheadOption[] = sessions.map(s => {
      const icon = s.worktreeId
        ? WORKTREE_ICON
        : React.createElement(ProviderIcon, { provider: s.provider || 'claude', size: 16 });

      return {
        id: s.id,
        label: s.title || 'Untitled',
        description: buildDescription(s.updatedAt, s.phase),
        icon,
        data: {
          id: s.id,
          title: s.title || 'Untitled',
          shortId: s.id.substring(0, 5),
        },
      };
    });

    set(sessionMentionOptionsAtom(workspacePath), options);
  }
);
