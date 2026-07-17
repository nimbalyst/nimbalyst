/**
 * Canonical session phase presentation.
 *
 * Single source of truth for session workflow-phase keys, labels, and
 * canonical colors. Consumed by Electron session surfaces (board, list,
 * mention, kanban) and by runtime chat metadata widgets so every surface
 * uses the same mapping.
 *
 * The colors below are the authoritative values; CSS variable fallbacks
 * (`--nim-session-phase-*`) allow theme overrides but must never silently
 * change a phase's meaning.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** All valid workflow-phase keys. */
export type SessionPhase = 'backlog' | 'planning' | 'implementing' | 'validating' | 'complete';

// ---------------------------------------------------------------------------
// Phase presentation map
// ---------------------------------------------------------------------------

export interface SessionPhasePresentation {
  label: string;
  /** Canonical 6-char hex color (no CSS var). */
  color: string;
  /** CSS custom-property name that may override the canonical color. */
  cssVar: string;
}

const PHASE_MAP: Record<SessionPhase, SessionPhasePresentation> = {
  backlog: {
    label: 'Backlog',
    color: '#6b7280',
    cssVar: '--nim-session-phase-backlog',
  },
  planning: {
    label: 'Planning',
    color: '#60a5fa',
    cssVar: '--nim-session-phase-planning',
  },
  implementing: {
    label: 'Implementing',
    color: '#eab308',
    cssVar: '--nim-session-phase-implementing',
  },
  validating: {
    label: 'Validating',
    color: '#a78bfa',
    cssVar: '--nim-session-phase-validating',
  },
  complete: {
    label: 'Complete',
    color: '#4ade80',
    cssVar: '--nim-session-phase-complete',
  },
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** All valid phase keys in the canonical display order. */
export const SESSION_PHASES: readonly SessionPhase[] = [
  'backlog',
  'planning',
  'implementing',
  'validating',
  'complete',
] as const;

/** Ordered array of phase presentation objects (suitable for dropdowns/columns). */
export const SESSION_PHASE_COLUMNS: readonly (SessionPhasePresentation & { value: SessionPhase })[] =
  SESSION_PHASES.map((value) => ({ value, ...PHASE_MAP[value] }));

/** Look up a phase's presentation (returns null for unknown/null keys — never silently maps to backlog). */
export function getPhasePresentation(
  phase: string | null | undefined,
): SessionPhasePresentation | null {
  if (!phase || !Object.prototype.hasOwnProperty.call(PHASE_MAP, phase)) return null;
  return PHASE_MAP[phase as SessionPhase];
}

/** Resolve the effective color: try the CSS var first, fall back to the canonical hex. */
export function resolvePhaseColor(
  phase: string | null | undefined,
): string | null {
  const pres = getPhasePresentation(phase);
  if (!pres) return null;
  return `var(${pres.cssVar}, ${pres.color})`;
}

/** Type guard for valid phase keys. */
export function isValidSessionPhase(value: string): value is SessionPhase {
  return Object.prototype.hasOwnProperty.call(PHASE_MAP, value);
}
