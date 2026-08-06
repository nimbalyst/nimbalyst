import React, { useEffect, useState } from 'react';
import { MaterialSymbol } from '@nimbalyst/runtime/ui/icons/MaterialSymbol';

import type { PersonalAccountSummary } from '../../store/atoms/settingsDomains';

export type AccountLoginMode =
  | 'first-sign-in'
  | 'org-onboarding'
  | 'add-account'
  | 'reauth';

interface SignInAttempt {
  method: 'google' | 'magicLink';
  /** Known for a magic link; empty for OAuth, where the browser collects it. */
  email: string;
}

export interface AccountLoginFormProps {
  mode: AccountLoginMode;
  account?: PersonalAccountSummary;
}

const COPY: Record<AccountLoginMode, { title: string; description: string }> = {
  'first-sign-in': {
    title: 'Sign in to get started',
    description: 'Sign in to sync sessions, drafts, and settings across your devices, and to collaborate with your team.',
  },
  // Deliberately not "sign in": the same two buttons create an account, and a
  // first-time user must not be told to sign in to one they do not have.
  'org-onboarding': {
    title: 'Sign in, or create your account',
    description: 'An organization belongs to a Nimbalyst account — either method works, new or existing.',
  },
  'add-account': {
    title: 'Add another account',
    description: "This account will be available on this device. It won't change your sync account or affect any workspace's team access.",
  },
  reauth: {
    title: 'Reconnect this account',
    description: 'Your other accounts stay signed in while this account reconnects.',
  },
};

type AuthFlowOptions = {
  intent: 'sign-in' | 'add-account' | 'reauth';
  targetPersonalOrgId?: string;
};

/**
 * Main validates intent strictly — `sign-in` throws once any account is stored,
 * `add-account` throws when none is, `reauth` needs its target — so the intent
 * is resolved at click time against the live accounts list rather than guessed
 * from the mode alone. The primary modes render whenever the *singleton* auth
 * state is signed out, which is also true when the sync account's session has
 * merely expired; those users are adding/refreshing an account, not signing in
 * for the first time.
 */
async function resolveFlowOptions(
  mode: AccountLoginMode,
  account: PersonalAccountSummary | undefined,
): Promise<AuthFlowOptions> {
  if (mode === 'add-account') return { intent: 'add-account' };
  if (mode === 'reauth') {
    if (!account?.personalOrgId) {
      throw new Error('Reconnecting an account requires the account to reconnect.');
    }
    return { intent: 'reauth', targetPersonalOrgId: account.personalOrgId };
  }
  const accounts = await window.electronAPI.stytch.getAccounts();
  return { intent: accounts?.length ? 'add-account' : 'sign-in' };
}

export function AccountLoginForm({ mode, account }: AccountLoginFormProps) {
  /**
   * The org wizard renders this inside its own dialog, which already carries the
   * card, the product identity and its own scale. Standing alone the form is the
   * whole surface — nested in the wizard the same chrome reads as a box in a box,
   * and panel-width controls balloon at dialog width.
   */
  const embedded = mode === 'org-onboarding';
  const scopedEmail = mode === 'reauth' ? account?.email ?? '' : '';
  const [email, setEmail] = useState(scopedEmail);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * Set once a method has been handed off to the browser or a mail client.
   * Both round trips leave the app; embedded mode shows an explicit waiting
   * state with a way back, so a lost email is not a dead end.
   */
  const [attempt, setAttempt] = useState<SignInAttempt | null>(null);
  const [resendNotice, setResendNotice] = useState<string | null>(null);

  useEffect(() => {
    setEmail(scopedEmail);
    setError(null);
    setAttempt(null);
    setResendNotice(null);
  }, [scopedEmail]);

  const beginSignIn = async (
    method: SignInAttempt['method'],
    targetEmail: string,
  ): Promise<boolean> => {
    setLoading(true);
    setError(null);
    try {
      const options = await resolveFlowOptions(mode, account);
      const result = method === 'google'
        ? await window.electronAPI.stytch.signInWithGoogle(options)
        : await window.electronAPI.stytch.sendMagicLink(targetEmail, options);
      if (!result?.success) {
        setError(result?.error ?? (
          method === 'google' ? 'Could not start sign-in.' : 'Could not send the sign-in link.'
        ));
        return false;
      }
      return true;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      return false;
    } finally {
      setLoading(false);
    }
  };

  const handleGoogle = async () => {
    const started = await beginSignIn('google', '');
    // Non-embedded surfaces keep the picker visible during the OAuth round
    // trip, matching their pre-waiting-state behavior.
    if (started && embedded) setAttempt({ method: 'google', email: '' });
  };

  const handleMagicLink = async (event: React.FormEvent) => {
    event.preventDefault();
    const target = email.trim();
    if (!target) return;
    if (await beginSignIn('magicLink', target)) {
      setAttempt({ method: 'magicLink', email: target });
    }
  };

  const handleResend = async () => {
    if (!attempt || loading) return;
    setResendNotice(null);
    if (await beginSignIn(attempt.method, attempt.email)) {
      setResendNotice(
        attempt.method === 'magicLink'
          ? `Another sign-in link is on its way to ${attempt.email}.`
          : 'Sign-in reopened in your browser.',
      );
    }
  };

  const handleRestart = () => {
    setAttempt(null);
    setError(null);
    setResendNotice(null);
  };

  const copy = COPY[mode];
  const waiting = embedded && attempt !== null;
  return (
    <section
      className={`account-login-form w-full text-[var(--nim-text)] ${
        embedded
          ? 'account-login-form-embedded'
          : 'rounded-xl border border-[var(--nim-border)] bg-[var(--nim-bg)] p-6 shadow-2xl'
      }`}
      data-component="AccountLoginForm"
      data-testid={`account-login-${mode}`}
      data-waiting={waiting}
    >
      {!embedded && (
        <div className="account-login-brand mb-5 flex items-center gap-2">
          <span className="flex h-7 w-7 items-center justify-center rounded-md bg-[var(--nim-primary)] text-sm font-bold text-white">N</span>
          <span className="text-sm font-semibold">Nimbalyst</span>
        </div>
      )}

      {mode === 'reauth' && account && (
        <div className="account-login-context mb-4 flex items-center gap-3 rounded-md border border-[var(--nim-warning)] bg-[color-mix(in_srgb,var(--nim-warning)_8%,transparent)] p-3">
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[var(--nim-bg-tertiary)] text-xs font-semibold">
            {(account.email?.[0] ?? '?').toUpperCase()}
          </span>
          <p className="m-0 select-text text-xs text-[var(--nim-text-muted)]">
            Signing back in for <strong className="text-[var(--nim-warning)]">{account.email}</strong>.
          </p>
        </div>
      )}

      {waiting && attempt ? (
        <div
          className="account-login-waiting"
          data-testid="account-login-waiting"
        >
          <div className="account-login-waiting-callout flex items-start gap-2 rounded-md border border-[var(--nim-success)] bg-[color-mix(in_srgb,var(--nim-success)_8%,transparent)] p-3">
            <MaterialSymbol
              icon={attempt.method === 'magicLink' ? 'mark_email_read' : 'open_in_new'}
              size={16}
              className="mt-0.5 shrink-0 text-[var(--nim-success)]"
            />
            <p className="m-0 select-text text-[12px] leading-relaxed text-[var(--nim-text)]">
              {attempt.method === 'magicLink' ? (
                <>
                  <strong>Check {attempt.email}</strong> — we sent a sign-in link. Open it on
                  this device and you will come straight back here.
                </>
              ) : (
                <>Finish signing in with Google in your browser. You will come straight back here.</>
              )}
            </p>
          </div>

          <div className="account-login-waiting-status mt-3 flex items-center gap-3">
            <span
              className="account-login-waiting-spinner h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-[var(--nim-border)] border-t-[var(--nim-primary)]"
              aria-hidden="true"
            />
            <span>
              <span className="block text-[13px] font-medium text-[var(--nim-text)]">
                Waiting for you to finish…
              </span>
              <span className="block text-[11px] text-[var(--nim-text-muted)]">
                This step continues on its own.
              </span>
            </span>
          </div>

          {resendNotice && (
            <p
              className="m-0 mt-3 select-text text-[11px] text-[var(--nim-success)]"
              data-testid="account-login-resend-notice"
            >
              {resendNotice}
            </p>
          )}

          <div className="account-login-waiting-actions mt-4 flex items-center justify-between gap-2">
            <button
              type="button"
              className="account-login-restart rounded-md px-3 py-1.5 text-[12px] text-[var(--nim-text-muted)] hover:bg-[var(--nim-bg-hover)] hover:text-[var(--nim-text)]"
              data-testid="account-login-restart"
              onClick={handleRestart}
            >
              Use a different method
            </button>
            <button
              type="button"
              disabled={loading}
              className="account-login-resend rounded-md border border-[var(--nim-border)] px-3 py-1.5 text-[12px] text-[var(--nim-text)] hover:bg-[var(--nim-bg-hover)] disabled:opacity-50"
              data-testid="account-login-resend"
              onClick={() => void handleResend()}
            >
              {attempt.method === 'magicLink' ? 'Resend link' : 'Open sign-in again'}
            </button>
          </div>
        </div>
      ) : (
        <>
          <h2 className={`m-0 font-semibold ${embedded ? 'text-base' : 'text-lg'}`}>{copy.title}</h2>
          <p
            className={`mt-1 leading-relaxed text-[var(--nim-text-muted)] ${
              embedded ? 'mb-4 text-[12px]' : 'mb-5 text-xs'
            }`}
          >
            {copy.description}
          </p>

          <div className={`account-login-methods ${embedded ? 'max-w-[320px]' : ''}`}>
            {attempt?.method !== 'magicLink' ? (
              <>
                <button
                  type="button"
                  className={`account-login-oauth flex w-full items-center justify-center gap-2 rounded-md font-semibold disabled:opacity-60 ${
                    embedded
                      ? 'mb-3 bg-[var(--nim-primary)] px-4 py-2 text-[13px] text-[var(--nim-on-primary)]'
                      : 'mb-4 border border-[var(--nim-border)] bg-white px-4 py-2.5 text-sm text-neutral-900'
                  }`}
                  disabled={loading}
                  onClick={() => void handleGoogle()}
                >
                  <MaterialSymbol icon="login" size={embedded ? 16 : 18} />
                  {mode === 'reauth' && account?.email ? `Continue as ${account.email}` : 'Continue with Google'}
                </button>

                <div
                  className={`account-login-divider flex items-center gap-3 text-[10px] uppercase tracking-wide text-[var(--nim-text-faint)] before:h-px before:flex-1 before:bg-[var(--nim-border)] after:h-px after:flex-1 after:bg-[var(--nim-border)] ${
                    embedded ? 'mb-3' : 'mb-4'
                  }`}
                >
                  or
                </div>
                <form className="account-login-magic-link" onSubmit={handleMagicLink}>
                  <label
                    className={`block text-[var(--nim-text-muted)] ${
                      embedded ? 'mb-1 text-[11px] font-medium' : 'mb-1.5 text-xs font-semibold'
                    }`}
                    htmlFor="account-login-email"
                  >
                    Email
                  </label>
                  <input
                    id="account-login-email"
                    className={`w-full rounded-md border border-[var(--nim-border)] bg-[var(--nim-bg-secondary)] text-[var(--nim-text)] disabled:opacity-70 ${
                      embedded
                        ? 'mb-2 px-3 py-2 text-[13px] outline-none focus:border-[var(--nim-primary)]'
                        : 'mb-3 px-3 py-2.5 text-sm'
                    }`}
                    type="email"
                    value={email}
                    disabled={loading || mode === 'reauth'}
                    onChange={(event) => setEmail(event.target.value)}
                    placeholder="you@example.com"
                  />
                  <button
                    type="submit"
                    className={`w-full rounded-md border border-[var(--nim-border)] font-medium text-[var(--nim-text)] disabled:opacity-50 ${
                      embedded
                        ? 'bg-[var(--nim-bg-secondary)] px-4 py-1.5 text-[12px] hover:bg-[var(--nim-bg-hover)]'
                        : 'bg-[var(--nim-bg-tertiary)] px-4 py-2.5 text-sm'
                    }`}
                    disabled={loading || !email.trim()}
                  >
                    {loading ? 'Sending…' : mode === 'reauth' ? `Send magic link to ${account?.email}` : 'Send magic link'}
                  </button>
                </form>
              </>
            ) : (
              <div className="account-login-sent rounded-md border border-[var(--nim-success)] bg-[color-mix(in_srgb,var(--nim-success)_8%,transparent)] p-4 text-center">
                <MaterialSymbol icon="mark_email_read" size={24} className="mx-auto text-[var(--nim-success)]" />
                <p className="mb-0 mt-2 select-text text-sm">Check {attempt.email} for the sign-in link.</p>
              </div>
            )}
          </div>
        </>
      )}

      {error && <p className="mb-0 mt-3 select-text text-xs text-[var(--nim-error)]">{error}</p>}
      {/* Account & Sync copy: inside the org wizard the user is not choosing a
          sync posture, so the note is noise there. */}
      {!embedded && (
        <div className="account-login-security mt-5 flex items-start gap-2 text-[11px] leading-relaxed text-[var(--nim-text-faint)]">
          <MaterialSymbol icon="lock" size={14} className="shrink-0 text-[var(--nim-success)]" />
          Personal sync is end-to-end encrypted with keys that never leave your devices.
        </div>
      )}
    </section>
  );
}
