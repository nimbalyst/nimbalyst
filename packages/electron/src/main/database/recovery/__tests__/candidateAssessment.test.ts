// @vitest-environment node
/**
 * The decision that says whether we may offer to replace someone's database.
 *
 * Table-driven because the interesting content is the mapping from facts to
 * verdict, and one row per case reads better than a dozen near-identical
 * tests. The rows to look at hardest are the two that differ only in
 * `configuredProjectCount`: identical databases, and the presence of the one
 * fact from outside either of them is what separates "recommend recovery" from
 * "we cannot tell".
 *
 * TWO DIFFERENT NUMBERS ARE BOTH CALLED "PROJECTS" HERE. Keep them apart:
 *
 *   - `Row.configuredProjects` -> `configuredProjectCount`, the projects this
 *     install has settings for in electron-store. It comes from OUTSIDE both
 *     databases, which is the only reason it can tell "this store is empty
 *     because the app is new" apart from "this store is empty because it was
 *     wiped". It is never part of a row count.
 *   - `db({ projectRows })` -> `indicators.projectCount`, rows in the
 *     database's own `projects` table. It IS part of the content total, and a
 *     database holding only these is not empty.
 *
 * `projectRows` defaults to 0 on purpose. It used to be hardcoded to 1, which
 * was harmless while the content total summed sessions and history only; the
 * moment projects started counting, every fixture named "empty" silently
 * stopped being empty and three rows asserted the opposite of their own names.
 */
import { describe, expect, it } from 'vitest';
import { assessRecoveryCandidate } from '../candidateAssessment';
import {
  sizeBucketFor,
  type ActiveBackend,
  type ContentIndicators,
  type DatabaseFacts,
  type IntegrityCode,
  type DatabasePathKind,
} from '../types';

interface ContentOverrides {
  sessions?: number | null;
  history?: number | null;
  /**
   * Rows in this database's `projects` table. NOT the install's configured
   * project count — see the header. Defaults to 0 so `db({ sessions: 0,
   * history: 0 })` means what it reads as.
   */
  projectRows?: number | null;
}

function db(over: Partial<DatabaseFacts> & ContentOverrides = {}): DatabaseFacts {
  const sizeBytes = over.sizeBytes ?? 500 * 1024 * 1024;
  const indicators: ContentIndicators =
    over.indicators ?? {
      sessionCount: over.sessions === undefined ? 0 : over.sessions,
      documentHistoryCount: over.history === undefined ? 0 : over.history,
      projectCount: over.projectRows === undefined ? 0 : over.projectRows,
    };
  return {
    pathKind: (over.pathKind ?? 'pglite-directory') as DatabasePathKind,
    sizeBytes,
    sizeBucket: over.sizeBucket ?? sizeBucketFor(sizeBytes),
    requiredSchemaPresent: over.requiredSchemaPresent ?? true,
    integrity: (over.integrity ?? 'not-applicable') as IntegrityCode,
    indicators,
  };
}

const MISSING = db({
  pathKind: 'missing',
  sizeBytes: 0,
  requiredSchemaPresent: null,
  integrity: 'not-checked',
  indicators: { sessionCount: null, documentHistoryCount: null, projectCount: null },
});

const UNREADABLE = db({
  requiredSchemaPresent: null,
  integrity: 'unreadable',
  indicators: { sessionCount: null, documentHistoryCount: null, projectCount: null },
});

interface Row {
  name: string;
  backend: ActiveBackend;
  live: DatabaseFacts;
  candidate: DatabaseFacts;
  /** Install fact from electron-store. Never a row count. */
  configuredProjects?: number;
  /**
   * Rows in the LIVE database's `ai_agent_messages`. `undefined` means "not
   * read", which makes the assessment fall back to counting live sessions.
   */
  liveAgentMessages?: number | null;
  resolved?: boolean;
  verdict: string;
  reason: string;
}

/** A database with nothing in it: no sessions, no history, no project rows. */
const EMPTY_LIVE = () => db({ sessions: 0, history: 0, sizeBytes: 4 * 1024 * 1024 });

/** A populated user database. Says all three counts out loud. */
const FULL = (over: Partial<DatabaseFacts> = {}) =>
  db({ sessions: 349, history: 12_000, projectRows: 4, ...over });

const ROWS: Row[] = [
  // --- recovery_recommended: #1347's fingerprint, on both backends ----------
  {
    name: 'established install, live empty, candidate full (PGLite active)',
    backend: 'pglite',
    live: EMPTY_LIVE(),
    candidate: FULL(),
    configuredProjects: 6,
    verdict: 'recovery_recommended',
    reason: 'live_empty_on_established_install',
  },
  {
    name: 'established install, live missing entirely (SQLite active)',
    backend: 'sqlite',
    live: MISSING,
    candidate: db({ sessions: 30, history: 400, projectRows: 2 }),
    configuredProjects: 2,
    verdict: 'recovery_recommended',
    reason: 'live_empty_on_established_install',
  },
  {
    // Someone on a team whose data is shared projects rather than AI sessions.
    // Summing sessions and history only called this `candidate_empty` and
    // refused to recover it.
    name: 'candidate holds only project rows and live holds nothing',
    backend: 'sqlite',
    live: EMPTY_LIVE(),
    candidate: db({ sessions: 0, history: 0, projectRows: 12 }),
    configuredProjects: 6,
    verdict: 'recovery_recommended',
    reason: 'live_empty_on_established_install',
  },
  // --- needs_review: real ambiguity, never a proactive offer ---------------
  {
    // Same two databases as the first row. Only the fact from outside them
    // differs, and it is the whole difference between offering and not.
    name: 'same facts but no configured projects: cannot tell a wipe from a new install',
    backend: 'pglite',
    live: EMPTY_LIVE(),
    candidate: FULL(),
    configuredProjects: 0,
    verdict: 'needs_review',
    reason: 'live_empty_but_install_looks_new',
  },
  {
    name: 'both databases hold real data',
    backend: 'sqlite',
    live: db({ pathKind: 'sqlite-file', integrity: 'ok', sessions: 30, history: 900, projectRows: 2 }),
    candidate: FULL(),
    configuredProjects: 6,
    verdict: 'needs_review',
    reason: 'both_databases_have_content',
  },
  {
    // The mirror of the project-only candidate: a live database with no
    // sessions but real project rows is not empty, so replacing it is a choice
    // between two populated databases and not ours to make.
    name: 'live holds only project rows, which is still content',
    backend: 'sqlite',
    live: db({ pathKind: 'sqlite-file', integrity: 'ok', sessions: 0, history: 0, projectRows: 3 }),
    candidate: FULL(),
    configuredProjects: 6,
    verdict: 'needs_review',
    reason: 'both_databases_have_content',
  },
  // --- not_actionable -------------------------------------------------------
  {
    name: 'candidate is empty',
    backend: 'pglite',
    live: EMPTY_LIVE(),
    candidate: db({ sessions: 0, history: 0, projectRows: 0 }),
    configuredProjects: 6,
    verdict: 'not_actionable',
    reason: 'candidate_empty',
  },
  {
    name: 'candidate holds less than live',
    backend: 'sqlite',
    live: db({ pathKind: 'sqlite-file', integrity: 'ok', sessions: 349, history: 12_000, projectRows: 4 }),
    candidate: db({ sessions: 5, history: 20, projectRows: 1 }),
    configuredProjects: 6,
    verdict: 'not_actionable',
    reason: 'candidate_not_materially_richer',
  },
  {
    name: 'candidate fails its integrity check',
    backend: 'sqlite',
    live: db({ pathKind: 'sqlite-file', integrity: 'ok', sessions: 0, history: 0 }),
    candidate: FULL({ integrity: 'failed' }),
    configuredProjects: 6,
    verdict: 'not_actionable',
    reason: 'candidate_invalid',
  },
  {
    name: 'candidate is not a Nimbalyst database',
    backend: 'pglite',
    live: EMPTY_LIVE(),
    candidate: FULL({ requiredSchemaPresent: false }),
    configuredProjects: 6,
    verdict: 'not_actionable',
    reason: 'candidate_invalid',
  },
  {
    name: 'the user already dealt with this artifact',
    backend: 'pglite',
    live: EMPTY_LIVE(),
    candidate: FULL(),
    configuredProjects: 6,
    resolved: true,
    verdict: 'not_actionable',
    reason: 'already_resolved',
  },
  // --- assessment_blocked: ambiguity never resolves toward acting -----------
  {
    name: 'candidate cannot be read',
    backend: 'pglite',
    live: EMPTY_LIVE(),
    candidate: UNREADABLE,
    configuredProjects: 6,
    verdict: 'assessment_blocked',
    reason: 'candidate_unreadable',
  },
  {
    name: 'live database cannot be read, so there is nothing to compare against',
    backend: 'sqlite',
    live: UNREADABLE,
    candidate: FULL(),
    configuredProjects: 6,
    verdict: 'assessment_blocked',
    reason: 'live_unreadable',
  },
  // --- the session row the app writes for itself ---------------------------
  //
  // An install that came up on an empty database has an `ai_sessions` row in it
  // before the user has typed anything: the app creates one when a window
  // opens. Counting that as content meant #1347's population -- the one this
  // whole feature exists for -- could only reach `recovery_recommended` in a
  // window that closes within a second of the launch that discovers the
  // problem. Observed directly in `e2e/core/database-recovery.spec.ts`, where
  // the live store reports one session, no history and no projects.
  {
    name: 'live holds only the session the app auto-created, and no messages in it',
    backend: 'pglite',
    live: db({ sessions: 1, history: 0, sizeBytes: 4 * 1024 * 1024 }),
    candidate: FULL(),
    configuredProjects: 6,
    liveAgentMessages: 0,
    verdict: 'recovery_recommended',
    reason: 'live_empty_on_established_install',
  },
  {
    // The same shape, one message in. Somebody used this database, so which
    // copy they want is not ours to decide.
    name: 'live holds one session that has been talked to',
    backend: 'pglite',
    live: db({ sessions: 1, history: 0, sizeBytes: 4 * 1024 * 1024 }),
    candidate: FULL(),
    configuredProjects: 6,
    liveAgentMessages: 1,
    verdict: 'needs_review',
    reason: 'both_databases_have_content',
  },
  {
    // Document history is user work whether or not an agent was involved.
    name: 'live holds no messages but does hold document history',
    backend: 'pglite',
    live: db({ sessions: 1, history: 5, sizeBytes: 4 * 1024 * 1024 }),
    candidate: FULL(),
    configuredProjects: 6,
    liveAgentMessages: 0,
    verdict: 'needs_review',
    reason: 'both_databases_have_content',
  },
  {
    // Unreadable is never zero, and never widens the offer: with no message
    // count the stricter session-based rule applies and this stays ambiguous.
    name: 'live message count could not be read, and live has a session',
    backend: 'pglite',
    live: db({ sessions: 1, history: 0, sizeBytes: 4 * 1024 * 1024 }),
    candidate: FULL(),
    configuredProjects: 6,
    liveAgentMessages: null,
    verdict: 'needs_review',
    reason: 'both_databases_have_content',
  },
];

describe('assessRecoveryCandidate', () => {
  it.each(ROWS)('$name -> $verdict', (row) => {
    const result = assessRecoveryCandidate({
      activeBackend: row.backend,
      live: row.live,
      candidate: row.candidate,
      configuredProjectCount: row.configuredProjects ?? 0,
      liveAgentMessageCount: row.liveAgentMessages ?? null,
      alreadyResolved: row.resolved ?? false,
    });
    expect(result.verdict).toBe(row.verdict);
    expect(result.reasonCode).toBe(row.reason);
    // Invariant, not an incidental property of these rows: nothing but a
    // recommendation may interrupt the user at launch.
    expect(result.mayOfferProactively).toBe(row.verdict === 'recovery_recommended');
  });

  // A directory being large is the single fact we are forbidden to act on --
  // it is what the old plausibility heuristic keyed off, and it is equally
  // consistent with a legitimate cleanup.
  it('never recommends on size alone when the live database still has content', () => {
    const result = assessRecoveryCandidate({
      activeBackend: 'sqlite',
      live: db({ pathKind: 'sqlite-file', integrity: 'ok', sessions: 1, history: 0, sizeBytes: 4 * 1024 * 1024 }),
      candidate: FULL({ sizeBytes: 6 * 1024 * 1024 * 1024 }),
      configuredProjectCount: 6,
      liveAgentMessageCount: 40,
      alreadyResolved: false,
    });
    expect(result.verdict).toBe('needs_review');
  });

  it('fingerprints the facts it decided from, and changes when they do', () => {
    const facts = {
      activeBackend: 'pglite' as const,
      live: EMPTY_LIVE(),
      candidate: FULL(),
      configuredProjectCount: 6,
      liveAgentMessageCount: 0,
      alreadyResolved: false,
    };
    const first = assessRecoveryCandidate(facts).factsFingerprint;
    expect(assessRecoveryCandidate({ ...facts }).factsFingerprint).toBe(first);
    const moved = assessRecoveryCandidate({
      ...facts,
      candidate: FULL({ indicators: { sessionCount: 350, documentHistoryCount: 12_000, projectCount: 4 } }),
    }).factsFingerprint;
    expect(moved).not.toBe(first);
  });

  // Project rows are part of the content total now, so they have to be part of
  // the fingerprint too -- otherwise a candidate that gained or lost projects
  // between the assessment and the click would be acted on under a stale
  // verdict, which is exactly what the fingerprint exists to prevent.
  it('changes its fingerprint when only the project row count moves', () => {
    const base = {
      activeBackend: 'sqlite' as const,
      live: EMPTY_LIVE(),
      configuredProjectCount: 6,
      liveAgentMessageCount: 0,
      alreadyResolved: false,
    };
    const before = assessRecoveryCandidate({
      ...base,
      candidate: db({ sessions: 0, history: 0, projectRows: 3 }),
    });
    const after = assessRecoveryCandidate({
      ...base,
      candidate: db({ sessions: 0, history: 0, projectRows: 9 }),
    });
    expect(after.factsFingerprint).not.toBe(before.factsFingerprint);
  });
});
