/**
 * Phase model for the timeline mode.
 *
 * The graph has no distinct "phase" concept — only a free-form `status` string
 * per item. We fold the well-known plan statuses and tracker statuses onto a
 * small ordered set of canonical *phases*, each with a stable color. A status we
 * don't recognise falls through to the neutral "other" phase but keeps its raw
 * label in the segment, so nothing is silently dropped.
 *
 * This module is intentionally pure (no DOM, no `Date.now()`) so it can be unit
 * tested and so `buildPhaseSegments` stays deterministic — callers inject `now`.
 */

export interface PhaseDef {
  /** Canonical phase key. */
  key: 'draft' | 'planning' | 'dev' | 'review' | 'done' | 'blocked' | 'rejected' | 'other';
  /** Human label for legends/tooltips. */
  label: string;
  /** CSS custom property holding the phase color (defined in styles.css). */
  colorVar: string;
  /** Sort order along the lifecycle (used for legends). */
  order: number;
  /** Status strings (lower-cased) that resolve to this phase. */
  match: string[];
}

export const PHASE_DEFS: PhaseDef[] = [
  {
    key: 'draft',
    label: 'Backlog / Draft',
    colorVar: '--pg-phase-draft',
    order: 0,
    match: ['draft', 'to-do', 'todo', 'backlog', 'ready-for-development', 'ready', 'open', 'new', 'idea', 'proposed', 'triage', 'outline'],
  },
  {
    key: 'planning',
    label: 'Planning',
    colorVar: '--pg-phase-planning',
    order: 1,
    // Session workflow phase; also picks up design/scoping-style statuses.
    match: ['planning', 'plan', 'scoping', 'designing', 'in-design', 'exploring'],
  },
  {
    key: 'dev',
    label: 'In development',
    colorVar: '--pg-phase-dev',
    order: 2,
    match: ['in-development', 'in-progress', 'inprogress', 'active', 'implementing', 'doing', 'started', 'in-dev', 'drafting', 'writing'],
  },
  {
    key: 'review',
    label: 'In review',
    colorVar: '--pg-phase-review',
    order: 3,
    match: ['in-review', 'review', 'validating', 'testing', 'qa', 'verifying'],
  },
  {
    key: 'done',
    label: 'Done',
    colorVar: '--pg-phase-done',
    order: 4,
    match: ['completed', 'complete', 'done', 'resolved', 'fixed', 'merged', 'shipped', 'closed', 'published', 'live'],
  },
  {
    key: 'blocked',
    label: 'Blocked',
    colorVar: '--pg-phase-blocked',
    order: 5,
    match: ['blocked', 'on-hold', 'on hold', 'waiting'],
  },
  {
    key: 'rejected',
    label: 'Rejected / Cancelled',
    colorVar: '--pg-phase-rejected',
    order: 6,
    match: ['rejected', 'cancelled', 'canceled', "won't-fix", 'wont-fix', 'wontfix', 'duplicate', 'archived'],
  },
];

const OTHER_PHASE: PhaseDef = {
  key: 'other',
  label: 'Other',
  colorVar: '--pg-phase-other',
  order: 7,
  match: [],
};

const STATUS_TO_PHASE = new Map<string, PhaseDef>();
for (const def of PHASE_DEFS) {
  for (const s of def.match) STATUS_TO_PHASE.set(s, def);
}

function normalizeStatus(status: string | undefined | null): string {
  // Collapse internal whitespace to hyphens so "In Progress" matches the
  // canonical "in-progress" key.
  return (status ?? '').trim().toLowerCase().replace(/\s+/g, '-');
}

/**
 * Resolve a status string to its canonical phase. Unknown (or empty) statuses
 * map to the neutral "other" phase.
 */
export function phaseForStatus(status: string | undefined | null): PhaseDef {
  return STATUS_TO_PHASE.get(normalizeStatus(status)) ?? OTHER_PHASE;
}

export interface PhaseActivityEntry {
  action?: string;
  field?: string;
  oldValue?: string;
  newValue?: string;
  timestamp?: number;
}

export interface BuildPhaseSegmentsInput {
  /** Epoch ms the item appeared. */
  createdAt?: number;
  /** Epoch ms the item entered a terminal state (undefined = still open). */
  closedAt?: number;
  /** Current status string. */
  status?: string;
  /** Raw activity log (from tracker `data.activity`). */
  activity?: PhaseActivityEntry[];
  /** Injected "now" so the function is deterministic / testable. */
  now: number;
}

export interface PhaseSegment {
  phaseKey: PhaseDef['key'];
  /** Raw status string that was active during this span. */
  statusLabel: string;
  /** Human phase label. */
  phaseLabel: string;
  startMs: number;
  endMs: number;
  colorVar: string;
}

interface RawSpan {
  status: string;
  startMs: number;
  endMs: number;
}

/**
 * Compute the ordered list of colored phase segments for one item.
 *
 * - With an activity log: walk the `status_changed` entries to reconstruct the
 *   exact intervals (creation → first transition → … → close|now).
 * - Without one: a single segment from creation to close|now in the current
 *   status's color.
 *
 * Segments shorter than a tick (same-ms transitions) are dropped, and adjacent
 * segments that resolve to the same phase are merged so the bar reads cleanly.
 */
export function buildPhaseSegments(input: BuildPhaseSegmentsInput): PhaseSegment[] {
  const { createdAt, closedAt, status, activity, now } = input;

  // Status transitions, sorted by time, with timestamps clamped to >= createdAt
  // (an activity recorded slightly before the item's created date shouldn't
  // produce a negative-width span).
  const transitions = (activity ?? [])
    .filter(a => a.action === 'status_changed' && typeof a.timestamp === 'number')
    .map(a => ({ oldValue: a.oldValue, newValue: a.newValue, timestamp: a.timestamp as number }))
    .sort((a, b) => a.timestamp - b.timestamp);

  // Determine the bar's start. Prefer createdAt; fall back to the first
  // transition timestamp. With neither we have nothing to draw.
  const start = createdAt ?? transitions[0]?.timestamp;
  if (start == null) return [];

  const end = closedAt ?? now;

  // No transitions → one span in the current status.
  if (transitions.length === 0) {
    return finalize([{ status: status ?? '', startMs: start, endMs: end }]);
  }

  const spans: RawSpan[] = [];
  // The status the item was in at creation is the oldValue of the first
  // transition (best signal we have for the pre-history state).
  let cursorStatus = transitions[0]!.oldValue ?? status ?? '';
  let cursorTime = start;

  for (const t of transitions) {
    const boundary = Math.max(start, Math.min(t.timestamp, end));
    spans.push({ status: cursorStatus, startMs: cursorTime, endMs: boundary });
    cursorStatus = t.newValue ?? cursorStatus;
    cursorTime = boundary;
  }
  // Trailing span from the last transition to close|now.
  spans.push({ status: cursorStatus, startMs: cursorTime, endMs: end });

  return finalize(spans);
}

/** Drop zero/negative-width spans and merge adjacent same-phase spans. */
function finalize(spans: RawSpan[]): PhaseSegment[] {
  const out: PhaseSegment[] = [];
  for (const span of spans) {
    if (span.endMs <= span.startMs) continue;
    const phase = phaseForStatus(span.status);
    const prev = out[out.length - 1];
    if (prev && prev.phaseKey === phase.key) {
      // Same phase as the previous segment → extend it rather than emit a seam.
      prev.endMs = span.endMs;
      continue;
    }
    out.push({
      phaseKey: phase.key,
      statusLabel: span.status,
      phaseLabel: phase.label,
      startMs: span.startMs,
      endMs: span.endMs,
      colorVar: phase.colorVar,
    });
  }
  return out;
}
