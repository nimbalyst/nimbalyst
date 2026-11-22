/**
 * The launch-time prompt for databases above the automatic ceiling.
 *
 * Boot decides `offer_consent` for a PGLite source larger than the built-in
 * ceiling (`autoMigrate.ts`). Before this module that decision was only an
 * analytics label: the only way to act on it was the Database settings
 * panel, which ordinary users cannot see, and none of the 101 installs offered
 * consent between 2026-11-03 and 2026-11-17 migrated.
 *
 * Boot records the decision here; the renderer claims the prompt once per
 * launch through `db:migration:claim-consent-prompt`. The user's answer is
 * persisted by the caller (app store), and a recorded answer means the prompt
 * never shows again.
 */

import type { SizeBucket } from './migrationOutcome';
import type { RolloutDecision } from './rolloutAuthorization';

export interface ConsentPromptFacts {
  /** The user has already answered the prompt on some earlier launch. */
  answered: boolean;
  activeBackend: 'pglite' | 'sqlite';
  /** A migration, dry run, recovery or rollback is in progress. */
  operationRunning: boolean;
  /** A cutover is waiting for the restart that finishes it. */
  requiresRestart: boolean;
}

export type ConsentPromptClaim = { show: true; sourceBytesBucket: SizeBucket } | { show: false };

let offeredBucket: SizeBucket | null = null;
let claimed = false;

/** Called by boot with this launch's rollout decision, whatever it was. */
export function recordConsentOffer(decision: RolloutDecision | undefined): void {
  offeredBucket = decision?.decision === 'offer_consent' ? decision.sourceBytesBucket : null;
}

/**
 * Whether the calling window should show the prompt. The first window that
 * asks on a launch gets it; every later call that launch is told no, so a
 * user with three project windows sees one dialog.
 */
export function claimConsentPrompt(facts: ConsentPromptFacts): ConsentPromptClaim {
  if (
    offeredBucket === null
    || claimed
    || facts.answered
    || facts.activeBackend !== 'pglite'
    || facts.operationRunning
    || facts.requiresRestart
  ) {
    return { show: false };
  }
  claimed = true;
  return { show: true, sourceBytesBucket: offeredBucket };
}

export function resetConsentOfferForTests(): void {
  offeredBucket = null;
  claimed = false;
}
