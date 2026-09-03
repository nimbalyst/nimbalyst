/**
 * Should we offer to recover from this artifact?
 *
 * A `pglite-db.backup-*` directory at the userData root means the worker once
 * decided the database was corrupt and renamed it aside. That is evidence
 * something happened. It is NOT evidence the live database is empty, and the
 * distinction is the whole point of this module: #1347's fingerprint (a large
 * artifact next to a near-empty live store) is also what a legitimate cleanup
 * looks like from ten thousand feet, and we do not get to guess.
 *
 * So the recommendation gate never looks at bytes. It requires all three of:
 *
 *   - the candidate holds content we can count,
 *   - the live database holds none, and
 *   - the install has projects configured in electron-store.
 *
 * That last fact comes from OUTSIDE both databases, which is what makes it
 * worth anything. A check that reads only the thing it is validating cannot
 * distinguish "this store is empty because the app is new" from "this store is
 * empty because it was wiped" — the exact hole that let an emptied source
 * migrate cleanly and reported success.
 *
 * Pure by construction, per `.claude/rules/destructive-data-paths.md`: facts in,
 * plan out, no filesystem and no PGLite. `migrationSourcePlausibility.ts` and
 * `pgliteInitRecovery.js` are the same pattern.
 */

import { createHash } from 'crypto';
import type {
  CandidateAssessment,
  CandidateAssessmentFacts,
  ContentIndicators,
  DatabaseFacts,
} from './types';

/**
 * A database whose row counts we could not read is unassessable, not empty.
 * A `pathKind` of `missing` is different: nothing there is a fact, not a gap.
 *
 * Projects are part of the count. Summing only sessions and history rejected
 * an artifact holding real projects as `candidate_empty`, so a user whose data
 * is shared projects rather than AI sessions was told there was nothing to
 * recover. `projectCount` is allowed to be `null` on its own -- a backend that
 * cannot report it (an older PGLite worker) should not make the whole database
 * unassessable -- but sessions and history unreadable still means unreadable.
 */
function contentRowsOf(facts: DatabaseFacts): number | null {
  if (facts.pathKind === 'missing') return 0;
  const { sessionCount, documentHistoryCount, projectCount } = facts.indicators;
  if (sessionCount === null || documentHistoryCount === null) return null;
  return sessionCount + documentHistoryCount + (projectCount ?? 0);
}

/**
 * Rows in the live database that only exist because a person did something.
 *
 * Distinct from `contentRowsOf`, which answers "is there anything here worth
 * restoring?" for the candidate. This answers "did this install lose the
 * user's work?", and the difference is `ai_sessions`: the app writes a session
 * row when a window opens, so an install that came up on an empty database has
 * one before the user has typed anything. Counting it meant the live store was
 * never "empty" past the first second of the launch that discovered the
 * problem, and #1347's population could never reach `recovery_recommended`.
 *
 * Agent messages and document-history snapshots are only written by use. When
 * the message count cannot be read we fall back to counting sessions, which is
 * the stricter answer -- an unreadable count must never widen the offer.
 */
function liveUserWorkRowsOf(facts: DatabaseFacts, agentMessageCount: number | null): number {
  if (facts.pathKind === 'missing') return 0;
  const { sessionCount, documentHistoryCount, projectCount } = facts.indicators;
  // `ai_sessions` is the ONLY substitution. Document history and project rows
  // still count exactly as they do for the candidate: a project row can be a
  // shared team project, which is real data, and the two are indistinguishable
  // from here.
  const sessionsOrMessages = agentMessageCount ?? sessionCount ?? 0;
  return sessionsOrMessages + (documentHistoryCount ?? 0) + (projectCount ?? 0);
}

/** Assessable at all? Anything unreadable, unrecognised, or moving is not. */
function blockingReason(
  which: 'candidate' | 'live',
  facts: DatabaseFacts,
): CandidateAssessment['reasonCode'] | null {
  if (facts.pathKind === 'unrecognized') {
    return which === 'candidate' ? 'candidate_unreadable' : 'live_unreadable';
  }
  if (facts.pathKind === 'missing') return null;
  if (facts.integrity === 'unreadable' || facts.requiredSchemaPresent === null) {
    return which === 'candidate' ? 'candidate_unreadable' : 'live_unreadable';
  }
  if (contentRowsOf(facts) === null) {
    return which === 'candidate' ? 'candidate_unreadable' : 'live_unreadable';
  }
  return null;
}

export function assessRecoveryCandidate(
  facts: CandidateAssessmentFacts,
): CandidateAssessment {
  const { candidate, live, activeBackend, configuredProjectCount, alreadyResolved } = facts;

  const base = {
    activeBackend,
    candidateSizeBucket: candidate.sizeBucket,
    liveSizeBucket: live.sizeBucket,
    factsFingerprint: fingerprintAssessmentFacts(facts),
  };
  const settle = (
    verdict: CandidateAssessment['verdict'],
    reasonCode: CandidateAssessment['reasonCode'],
  ): CandidateAssessment => ({
    ...base,
    verdict,
    reasonCode,
    mayOfferProactively: verdict === 'recovery_recommended',
  });

  // Resolved and absent artifacts are answered first: neither is worth
  // reporting as ambiguous, and an absent one has no facts to be blocked on.
  if (alreadyResolved) return settle('not_actionable', 'already_resolved');
  if (candidate.pathKind === 'missing') return settle('not_actionable', 'candidate_missing');

  // Damage we can positively identify makes the candidate useless, not
  // ambiguous. Distinguished from "we could not look", below.
  if (candidate.integrity === 'failed' || candidate.requiredSchemaPresent === false) {
    return settle('not_actionable', 'candidate_invalid');
  }

  // Anything we could not read, or that moved while we read it, stops here.
  // Ambiguity is never resolved in favour of acting.
  const candidateBlocked = blockingReason('candidate', candidate);
  if (candidateBlocked) return settle('assessment_blocked', candidateBlocked);
  const liveBlocked = blockingReason('live', live);
  if (liveBlocked) return settle('assessment_blocked', liveBlocked);

  const candidateRows = contentRowsOf(candidate) ?? 0;
  const liveRows = contentRowsOf(live) ?? 0;

  // Restoring nothing over something is the failure we are here to prevent.
  if (candidateRows === 0) return settle('not_actionable', 'candidate_empty');
  if (candidateRows <= liveRows) {
    return settle('not_actionable', 'candidate_not_materially_richer');
  }

  if (liveUserWorkRowsOf(live, facts.liveAgentMessageCount) > 0) {
    // Both hold real data. Which one the user wants is not ours to decide.
    return settle('needs_review', 'both_databases_have_content');
  }

  // Live holds no user work and the candidate does. Only an install that was
  // actually being used turns that into a recommendation; without configured
  // projects this is indistinguishable from a fresh install next to an old
  // artifact.
  if (configuredProjectCount > 0) {
    return settle('recovery_recommended', 'live_empty_on_established_install');
  }
  return settle('needs_review', 'live_empty_but_install_looks_new');
}

/**
 * Digest of every fact the verdict was computed from, plus the bytes and
 * counts underneath them. Recovery re-gathers facts immediately before acting
 * and refuses when this changed, so a candidate that is still being written --
 * or a live database that gained rows while the user read the dialog -- cannot
 * be acted on under a stale verdict.
 */
export function fingerprintAssessmentFacts(facts: CandidateAssessmentFacts): string {
  const shape = (f: DatabaseFacts) => [
    f.pathKind,
    f.sizeBytes,
    f.requiredSchemaPresent,
    f.integrity,
    indicatorShape(f.indicators),
  ];
  return createHash('sha256')
    .update(
      JSON.stringify([
        facts.activeBackend,
        facts.configuredProjectCount,
        facts.liveAgentMessageCount,
        facts.alreadyResolved,
        shape(facts.live),
        shape(facts.candidate),
      ]),
    )
    .digest('hex')
    .slice(0, 32);
}

function indicatorShape(i: ContentIndicators): unknown[] {
  return [i.sessionCount, i.documentHistoryCount, i.projectCount];
}
