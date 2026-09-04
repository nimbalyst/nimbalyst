/**
 * The promotion signal: "this has been recalled 14 times across 6 sessions and
 * has never been contradicted — promote it?"
 *
 * This computes the question, not the answer. Promotion writes a file into a
 * shared repository and is one way, so nothing here may fire automatically on a
 * threshold; the strength score exists to *order a review queue*, and the
 * headline exists to give a human the evidence in one line.
 *
 * Blockers are advisory to the caller for the same reason. A person may well
 * decide to promote a memory recalled twice because they already know it is
 * right. What they may not do is promote one without being told it was
 * contradicted last week.
 */
import type { PromotableMemory } from './types.js';

export interface PromotionThresholds {
  /** Recalls below which a memory has not yet demonstrated it is load-bearing. */
  minRecallCount: number;
  /** Distinct sessions, so one long session cannot manufacture a signal. */
  minSessionCount: number;
}

export const DEFAULT_PROMOTION_THRESHOLDS: PromotionThresholds = {
  minRecallCount: 5,
  minSessionCount: 3,
};

export interface PromotionSignal {
  /** True when the evidence clears the thresholds and nothing blocks it. */
  eligible: boolean;
  /**
   * 0–1, for ranking candidates against each other. Saturates at three times
   * the threshold so one heavily-recalled memory cannot crowd out the rest of
   * the queue, and is 0 whenever standing is in doubt.
   */
  strength: number;
  /** One line of evidence, suitable for putting in front of a human as-is. */
  headline: string;
  /** What argues for promotion. */
  reasons: string[];
  /** What argues against it. Never enforced here — surfaced. */
  blockers: string[];
}

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

const plural = (count: number, noun: string): string =>
  `${count} ${noun}${count === 1 ? '' : 's'}`;

/**
 * Reduce a memory to the promotion question. Pure: no clock, no store, no
 * filesystem, so a caller can compute this over a whole store cheaply.
 */
export function computePromotionSignal(
  memory: PromotableMemory,
  thresholds: PromotionThresholds = DEFAULT_PROMOTION_THRESHOLDS,
): PromotionSignal {
  const recallCount = Math.max(0, memory.recall?.recallCount ?? 0);
  const sessionCount = Math.max(0, memory.recall?.sessionCount ?? 0);
  const standing = memory.standing;
  const contradictedBy = standing?.contradictedBy ?? [];

  const reasons: string[] = [];
  const blockers: string[] = [];

  // Standing first: a contradicted memory that keeps being recalled looks more
  // promotable by volume alone, which is exactly the trap.
  const standingIsClean =
    contradictedBy.length === 0 && !standing?.supersededBy && !standing?.archivedAt;

  if (contradictedBy.length > 0) {
    const count = contradictedBy.length;
    blockers.push(`Contradicted by ${count} later ${count === 1 ? 'memory' : 'memories'}.`);
  }
  if (standing?.supersededBy) {
    blockers.push('Superseded by a later memory; promote that one instead.');
  }
  if (standing?.archivedAt) {
    blockers.push('Archived, so it no longer describes how the team works.');
  }
  if (!memory.body.trim()) {
    blockers.push('Has no body, so there is no rule text to write.');
  }

  if (!memory.recall) {
    blockers.push('No recall history recorded, so there is no evidence it is used.');
  } else {
    if (recallCount < thresholds.minRecallCount) {
      blockers.push(
        `Recalled ${plural(recallCount, 'time')}, under the ${thresholds.minRecallCount} needed.`,
      );
    }
    if (sessionCount < thresholds.minSessionCount) {
      blockers.push(
        `Seen in ${plural(sessionCount, 'session')}, under the ${thresholds.minSessionCount} needed.`,
      );
    }
  }

  if (recallCount >= thresholds.minRecallCount && sessionCount >= thresholds.minSessionCount) {
    reasons.push(
      `Recalled ${plural(recallCount, 'time')} across ${plural(sessionCount, 'session')}.`,
    );
  }
  if (standingIsClean && recallCount > 0) {
    reasons.push('Never contradicted or superseded.');
  }
  if ((standing?.supersedes?.length ?? 0) > 0) {
    reasons.push('Already replaced an earlier memory, so it is the settled version.');
  }

  const recallScore = clamp01(recallCount / (thresholds.minRecallCount * 3));
  const sessionScore = clamp01(sessionCount / (thresholds.minSessionCount * 3));
  const strength = standingIsClean ? (recallScore + sessionScore) / 2 : 0;

  return {
    eligible: blockers.length === 0,
    strength,
    headline: buildHeadline(recallCount, sessionCount, standingIsClean, contradictedBy.length),
    reasons,
    blockers,
  };
}

function buildHeadline(
  recallCount: number,
  sessionCount: number,
  standingIsClean: boolean,
  contradictionCount: number,
): string {
  if (recallCount === 0) {
    return 'Never recalled.';
  }
  const usage = `Recalled ${plural(recallCount, 'time')} across ${plural(sessionCount, 'session')}`;
  if (standingIsClean) {
    return `${usage} and never contradicted.`;
  }
  if (contradictionCount > 0) {
    return `${usage}, but contradicted since.`;
  }
  return `${usage}, but no longer current.`;
}
