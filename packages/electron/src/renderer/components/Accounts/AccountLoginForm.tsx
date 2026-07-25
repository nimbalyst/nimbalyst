import React, { useEffect, useState } from 'react';
import { MaterialSymbol } from '@nimbalyst/runtime';

import type { PersonalAccountSummary } from '../../store/atoms/settingsDomains';

export type AccountLoginMode = 'first-sign-in' | 'add-account' | 'reauth';

export interface AccountLoginFormProps {
  mode: AccountLoginMode;
  account?: PersonalAccountSummary;
}

const COPY: Record<AccountLoginMode, { title: string; description: string }> = {
  'first-sign-in': {
    title: 'Sign in to get started',
    description: 'Sign in to sync sessions, drafts, and settings across your devices, and to collaborate with your team.',
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

export function AccountLoginForm({ mode, account }: AccountLoginFormProps) {
  const scopedEmail = mode === 'reauth' ? account?.email ?? '' : '';
  const [email, setEmail] = useState(scopedEmail);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [magicLinkSent, setMagicLinkSent] = useState(false);

  useEffect(() => {
    setEmail(scopedEmail);
    setError(null);
    setMagicLinkSent(false);
  }, [scopedEmail]);

  const handleGoogle = async () => {
    setLoading(true);
    setError(null);
    try {
      const result = mode === 'first-sign-in'
        ? await window.electronAPI.stytch.signInWithGoogle()
        : await window.electronAPI.stytch.addAccount();
      if (!result?.success) setError(result?.error ?? 'Could not start sign-in.');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  };

  const handleMagicLink = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!email.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const result = await window.electronAPI.stytch.sendMagicLink(email.trim());
      if (!result?.success) setError(result?.error ?? 'Could not send the sign-in link.');
      else setMagicLinkSent(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  };

  const copy = COPY[mode];
  return (
    <section
      className="account-login-form w-full rounded-xl border border-[var(--nim-border)] bg-[var(--nim-bg)] p-6 text-[var(--nim-text)] shadow-2xl"
      data-component="AccountLoginForm"
      data-testid={`account-login-${mode}`}
    >
      <div className="account-login-brand mb-5 flex items-center gap-2">
        <span className="flex h-7 w-7 items-center justify-center rounded-md bg-[var(--nim-primary)] text-sm font-bold text-white">N</span>
        <span className="text-sm font-semibold">Nimbalyst</span>
      </div>

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

      <h2 className="m-0 text-lg font-semibold">{copy.title}</h2>
      <p className="mb-5 mt-1 text-xs leading-relaxed text-[var(--nim-text-muted)]">{copy.description}</p>

      {!magicLinkSent ? (
        <>
          <button
            type="button"
            className="account-login-oauth mb-4 flex w-full items-center justify-center gap-2 rounded-md border border-[var(--nim-border)] bg-white px-4 py-2.5 text-sm font-semibold text-neutral-900 disabled:opacity-60"
            disabled={loading}
            onClick={() => void handleGoogle()}
          >
            <MaterialSymbol icon="login" size={18} />
            {mode === 'reauth' && account?.email ? `Continue as ${account.email}` : 'Continue with Google'}
          </button>

          <div className="account-login-divider mb-4 flex items-center gap-3 text-[10px] uppercase tracking-wide text-[var(--nim-text-faint)] before:h-px before:flex-1 before:bg-[var(--nim-border)] after:h-px after:flex-1 after:bg-[var(--nim-border)]">or</div>
          <form className="account-login-magic-link" onSubmit={handleMagicLink}>
            <label className="mb-1.5 block text-xs font-semibold text-[var(--nim-text-muted)]" htmlFor="account-login-email">Email</label>
            <input
              id="account-login-email"
              className="mb-3 w-full rounded-md border border-[var(--nim-border)] bg-[var(--nim-bg-secondary)] px-3 py-2.5 text-sm text-[var(--nim-text)] disabled:opacity-70"
              type="email"
              value={email}
              disabled={loading || mode === 'reauth'}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="you@example.com"
            />
            <button
              type="submit"
              className="w-full rounded-md border border-[var(--nim-border)] bg-[var(--nim-bg-tertiary)] px-4 py-2.5 text-sm font-medium text-[var(--nim-text)] disabled:opacity-50"
              disabled={loading || !email.trim()}
            >
              {loading ? 'Sending…' : mode === 'reauth' ? `Send magic link to ${account?.email}` : 'Send magic link'}
            </button>
          </form>
        </>
      ) : (
        <div className="account-login-sent rounded-md border border-[var(--nim-success)] bg-[color-mix(in_srgb,var(--nim-success)_8%,transparent)] p-4 text-center">
          <MaterialSymbol icon="mark_email_read" size={24} className="mx-auto text-[var(--nim-success)]" />
          <p className="mb-0 mt-2 select-text text-sm">Check {email} for the sign-in link.</p>
        </div>
      )}

      {error && <p className="mb-0 mt-3 select-text text-xs text-[var(--nim-error)]">{error}</p>}
      <div className="account-login-security mt-5 flex items-start gap-2 text-[11px] leading-relaxed text-[var(--nim-text-faint)]">
        <MaterialSymbol icon="lock" size={14} className="shrink-0 text-[var(--nim-success)]" />
        Personal sync is end-to-end encrypted with keys that never leave your devices.
      </div>
    </section>
  );
}
