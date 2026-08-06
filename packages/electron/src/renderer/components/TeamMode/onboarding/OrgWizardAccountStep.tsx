/**
 * Step 1 of the organization wizard: sign in, or create an account.
 *
 * `AccountLoginForm` owns the whole sign-in interaction — method picker,
 * waiting state, resend. This wrapper only watches auth and advances the
 * wizard the moment a signed-in identity lands.
 */

import React, { useEffect, useRef } from 'react';
import { useAtomValue } from 'jotai';

import { AccountLoginForm } from '../../Accounts/AccountLoginForm';
import {
  stytchAuthAtom,
  type StytchAuthSnapshot,
} from '../../../store/atoms/stytchAuth';
import type { PersonalAccountSummary } from '../../../store/atoms/settingsDomains';

export interface OrgWizardAccountStepProps {
  onAuthenticated: (email: string) => void;
}

function authenticatedEmail(
  user: StytchAuthSnapshot['user'],
): string {
  return user?.emails?.find((entry) => entry.verified)?.email
    ?? user?.emails?.[0]?.email
    ?? '';
}

export function OrgWizardAccountStep({
  onAuthenticated,
}: OrgWizardAccountStepProps) {
  const auth = useAtomValue(stytchAuthAtom);
  const deliveredIdentityRef = useRef<string | null>(null);
  /**
   * Set once the first auth snapshot has been seen. Everything after it is a
   * broadcast from main, which is what distinguishes "a flow just finished"
   * from "this is what the device already looked like".
   */
  const sawInitialSnapshotRef = useRef(false);

  useEffect(() => {
    // Null is "not loaded yet", not "signed out".
    if (!auth) return;

    if (auth.isAuthenticated && auth.user) {
      sawInitialSnapshotRef.current = true;
      const email = authenticatedEmail(auth.user);
      const identity = `${auth.user.user_id}:${email}`;
      if (deliveredIdentityRef.current === identity) return;
      deliveredIdentityRef.current = identity;
      onAuthenticated(email);
      return;
    }

    if (!sawInitialSnapshotRef.current) {
      sawInitialSnapshotRef.current = true;
      return;
    }

    /**
     * Adding an account that is not the sync account leaves the singleton auth
     * state signed out — main only refreshes it for the sync account — so the
     * branch above never fires and the step would sit on "waiting" forever.
     * Main does broadcast an auth-state change for the add, so a fresh snapshot
     * that is still signed out means a flow completed: re-read the stored
     * accounts and advance on any usable one.
     */
    let cancelled = false;
    void Promise.resolve(window.electronAPI?.stytch?.getAccounts?.())
      .then((result) => {
        if (cancelled) return;
        const rows: PersonalAccountSummary[] = Array.isArray(result) ? result : [];
        const usable = rows.find((account) => account.sessionStatus === 'active');
        if (!usable) return;
        const email = usable.email ?? '';
        const identity = `${usable.personalUserId ?? usable.personalOrgId}:${email}`;
        if (deliveredIdentityRef.current === identity) return;
        deliveredIdentityRef.current = identity;
        onAuthenticated(email);
      })
      .catch(() => {
        // The signed-in path above still covers the sync account.
      });
    return () => { cancelled = true; };
  }, [auth, onAuthenticated]);

  return (
    <section
      className="org-wizard-account-step mt-4"
      data-component="OrgWizardAccountStep"
      data-testid="org-wizard-account-step"
    >
      <AccountLoginForm mode="org-onboarding" />
    </section>
  );
}
