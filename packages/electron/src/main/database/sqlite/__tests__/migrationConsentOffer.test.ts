// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest';

import {
  claimConsentPrompt,
  recordConsentOffer,
  resetConsentOfferForTests,
  type ConsentPromptFacts,
} from '../migrationConsentOffer';
import type { RolloutDecision } from '../rolloutAuthorization';

const OFFER: RolloutDecision = {
  configVersion: 'sqlite-builtin-3gib',
  evaluatedChannel: 'stable',
  sourceBytesBucket: 'lt_8gib',
  decision: 'offer_consent',
  skipReason: 'source_above_ceiling',
};

const PGLITE_IDLE: ConsentPromptFacts = {
  answered: false,
  activeBackend: 'pglite',
  operationRunning: false,
  requiresRestart: false,
};

describe('the consent prompt for databases above the automatic ceiling', () => {
  beforeEach(() => resetConsentOfferForTests());

  it('is shown once per launch, to the first window that asks, when boot offered consent', () => {
    recordConsentOffer(OFFER);

    expect(claimConsentPrompt(PGLITE_IDLE)).toEqual({ show: true, sourceBytesBucket: 'lt_8gib' });
    // A second window opening on the same launch must not ask again.
    expect(claimConsentPrompt(PGLITE_IDLE)).toEqual({ show: false });
  });

  it('is not shown when boot made any other decision', () => {
    recordConsentOffer({ ...OFFER, decision: 'attempt_auto', skipReason: 'none' });
    expect(claimConsentPrompt(PGLITE_IDLE)).toEqual({ show: false });

    resetConsentOfferForTests();
    recordConsentOffer(undefined);
    expect(claimConsentPrompt(PGLITE_IDLE)).toEqual({ show: false });
  });

  it('is never shown again once the user has answered it', () => {
    recordConsentOffer(OFFER);
    expect(claimConsentPrompt({ ...PGLITE_IDLE, answered: true })).toEqual({ show: false });
  });

  it('is not shown on SQLite, during another database operation, or while a restart is pending', () => {
    for (const facts of [
      { ...PGLITE_IDLE, activeBackend: 'sqlite' as const },
      { ...PGLITE_IDLE, operationRunning: true },
      { ...PGLITE_IDLE, requiresRestart: true },
    ]) {
      resetConsentOfferForTests();
      recordConsentOffer(OFFER);
      expect(claimConsentPrompt(facts)).toEqual({ show: false });
    }
  });
});
