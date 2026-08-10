/**
 * Organization creation wizard.
 *
 * All four steps — account, name, invite, done — run in a single
 * main-window dialog. The wizard never opens the organization window itself;
 * it only queues the "land on #general" route for whenever the user opens it.
 * Everything stateful lives in `orgWizardModel.ts` and every remote side effect
 * in `orgWizardRunner.ts`; this file renders the dialog.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MaterialSymbol } from '@nimbalyst/runtime/ui/icons/MaterialSymbol';
import { useAtomValue } from 'jotai';

import { AlphaBadge } from '../../common/AlphaBadge';
import { TEAM_BETA_TOOLTIP, TeamBetaNotice } from '../../common/TeamBetaNotice';
import {
  bucketMemberCount,
  categorizeTeamAnalyticsError,
} from '../../../../shared/analytics/teamAnalytics';
import { trackTeamAnalyticsEvent } from '../../../utils/teamAnalytics';
import {
  clearOrgWizardDraft,
  markOrgWelcomeDismissed,
  persistOrgWizardDraft,
  queueOrgWindowGeneralRoute,
  readOrgWizardDraft,
} from './orgOnboardingStorage';
import {
  ORG_WIZARD_STEP_LABELS,
  addEmails,
  advance,
  canAdvance,
  canSkip,
  createOrgWizardState,
  defaultSourcePersonalOrgId,
  normalizeOwnerId,
  orgAvatarColor,
  orgAvatarInitials,
  orgWizardSteps,
  removeEmail,
  resolveAuthenticatedAccount,
  resolveSourcePersonalOrgId,
  stepStatus,
  type OrgWizardPersonalAccount,
  type OrgWizardState,
} from './orgWizardModel';
import { createOrgWizardApi } from './orgWizardApi';
import { OrgWizardAccountStep } from './OrgWizardAccountStep';
import { stytchAuthAtom, type StytchAuthSnapshot } from '../../../store/atoms/stytchAuth';
import {
  runCreateOrganization,
  runSendInvites,
  type OrgWizardApi,
} from './orgWizardRunner';

interface PersonalAccount extends OrgWizardPersonalAccount {
  personalOrgId: string;
  email: string | null;
}

/**
 * Which identity a draft belongs to. The verified address is what the invite
 * lookup keys on, so the same value doubles as the auth-race guard below.
 */
function authIdentity(auth: StytchAuthSnapshot | null): string | null {
  if (!auth?.isAuthenticated || !auth.user) return null;
  return normalizeOwnerId(authenticatedEmail(auth.user) || auth.user.user_id);
}

function authenticatedEmail(user: StytchAuthSnapshot['user']): string {
  return user?.emails?.find((entry) => entry.verified)?.email
    ?? user?.emails?.[0]?.email
    ?? '';
}

export interface OrgCreationWizardProps {
  isOpen: boolean;
  onClose: () => void;
  initialState?: OrgWizardState;
  /**
   * Project the new organization adopts on creation. Supplied by the Sharing
   * settings entry point, which is the only one opened from inside a project.
   */
  workspacePath?: string;
  /** Pre-fills the name field, e.g. with the project's folder name. */
  suggestedName?: string;
  /** Which surface opened the wizard; reported on every analytics event. */
  entryPoint?: 'organization_manager' | 'project_sharing';
  /** Called once the organization exists, so lists behind the dialog refresh. */
  onOrganizationCreated?: (orgId: string) => void;
  /** Injected in tests; defaults to the live IPC-backed implementation. */
  api?: OrgWizardApi;
}

/**
 * Every keystroke in the name field commits state, and every commit used to be
 * an app-settings IPC write. The draft only has to survive losing the window,
 * so writes coalesce — and flush on anything that can precede that loss.
 */
const DRAFT_PERSIST_DELAY_MS = 500;

function StepIndicator({
  state,
  isAuthenticated,
}: {
  state: OrgWizardState;
  isAuthenticated: boolean;
}) {
  const steps = orgWizardSteps(isAuthenticated);
  return (
    <ol className="org-wizard-steps m-0 flex list-none items-center gap-1 p-0" data-testid="org-wizard-steps">
      {steps.map((step, index) => {
        const status = stepStatus(state, step);
        return (
          <li
            key={step}
            className="org-wizard-step flex items-center gap-1"
            data-testid={`org-wizard-step-${step}`}
            data-status={status}
          >
            <span
              className={`org-wizard-step-dot flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-semibold ${
                status === 'active'
                  ? 'bg-[var(--nim-primary)] text-[var(--nim-on-primary)]'
                  : status === 'completed'
                    ? 'bg-[color-mix(in_srgb,var(--nim-success)_22%,transparent)] text-[var(--nim-success)]'
                    : 'bg-[var(--nim-bg-tertiary)] text-[var(--nim-text-muted)]'
              }`}
            >
              {status === 'completed' ? <MaterialSymbol icon="check" size={12} /> : index + 1}
            </span>
            <span
              className={`org-wizard-step-label whitespace-nowrap text-[11px] ${
                status === 'upcoming' ? 'text-[var(--nim-text-disabled)]' : 'text-[var(--nim-text)]'
              }`}
            >
              {ORG_WIZARD_STEP_LABELS[step]}
            </span>
            {index < steps.length - 1 && (
              <span className="org-wizard-step-connector mx-1 h-px w-5 bg-[var(--nim-border)]" />
            )}
          </li>
        );
      })}
    </ol>
  );
}

export function OrgCreationWizard({
  isOpen,
  onClose,
  initialState,
  workspacePath,
  suggestedName,
  entryPoint = 'organization_manager',
  onOrganizationCreated,
  api,
}: OrgCreationWizardProps) {
  const auth = useAtomValue(stytchAuthAtom);
  const wizardApi = useMemo(() => api ?? createOrgWizardApi(), [api]);
  const [state, setState] = useState<OrgWizardState>(() => (
    initialState
      ?? createOrgWizardState({
        isAuthenticated: auth?.isAuthenticated === true,
        workspacePath: workspacePath ?? null,
        orgName: suggestedName ?? '',
      })
  ));
  const [hydrated, setHydrated] = useState(initialState !== undefined);
  const [accounts, setAccounts] = useState<PersonalAccount[]>([]);
  const [emailDraft, setEmailDraft] = useState('');
  const [invalidEmails, setInvalidEmails] = useState<string[]>([]);

  const identity = authIdentity(auth);
  // The async steps need the state as it is right now, and React's updater form
  // cannot carry a value out of itself, so writes go through this ref as well.
  const stateRef = useRef(state);
  // Assigned during render, not from an effect: child effects (the account
  // step's auto-advance) run before the parent's, so an effect here would still
  // be holding the previous identity when the lookup below starts.
  const identityRef = useRef(identity);
  identityRef.current = identity;
  // A dismissed wizard must not be resurrected by a mutation that was already
  // in flight when it closed.
  const dismissedRef = useRef(false);
  // Only the newest invitation lookup may write the lookup state.
  const lookupRef = useRef(0);
  const pendingDraftRef = useRef<OrgWizardState | null>(null);
  const draftTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /**
   * Drop a scheduled write. Every path that clears the stored draft has to do
   * this first, or the trailing write lands afterwards and resurrects it.
   */
  const cancelDraft = useCallback(() => {
    if (draftTimerRef.current !== null) {
      clearTimeout(draftTimerRef.current);
      draftTimerRef.current = null;
    }
    pendingDraftRef.current = null;
  }, []);

  const flushDraft = useCallback(() => {
    const pending = pendingDraftRef.current;
    cancelDraft();
    if (pending) void persistOrgWizardDraft(pending);
  }, [cancelDraft]);

  const commit = useCallback((next: OrgWizardState) => {
    const stepChanged = stateRef.current.step !== next.step;
    stateRef.current = next;
    setState(next);
    pendingDraftRef.current = next;
    // A step change is a decision worth keeping even if the window dies in the
    // next millisecond; typing inside a step can wait for the trailing edge.
    if (stepChanged) {
      flushDraft();
      return;
    }
    if (draftTimerRef.current !== null) clearTimeout(draftTimerRef.current);
    draftTimerRef.current = setTimeout(flushDraft, DRAFT_PERSIST_DELAY_MS);
  }, [flushDraft]);

  // A re-opened wizard is a fresh journey, so nothing from the previous one is
  // still "dismissed".
  useEffect(() => {
    if (isOpen) dismissedRef.current = false;
  }, [isOpen]);

  // Both sign-in methods take the user out of the app, and a browser or mail
  // client stealing focus is the last thing that happens before the round trip.
  useEffect(() => {
    if (!isOpen) return;
    window.addEventListener('blur', flushDraft);
    return () => {
      window.removeEventListener('blur', flushDraft);
      flushDraft();
    };
  }, [flushDraft, isOpen]);

  const update = useCallback((
    change: (current: OrgWizardState) => OrgWizardState,
  ) => {
    commit(change(stateRef.current));
  }, [commit]);

  useEffect(() => {
    // `auth === null` is "not loaded yet", not "signed out". Hydrating then
    // would read the draft as nobody and discard a signed-in user's own work.
    if (!isOpen || initialState || hydrated || auth === null) return;
    let cancelled = false;
    void readOrgWizardDraft(identity).then((draft) => {
      if (cancelled) return;
      const restored = draft ?? createOrgWizardState({
        isAuthenticated: auth?.isAuthenticated === true,
      });
      let next = restored;
      if (identity && next.owner !== identity) {
        next = { ...next, owner: identity };
      }
      if (restored.createdOrgId === null) {
        if (auth?.isAuthenticated !== true && restored.step !== 'account') {
          next = { ...next, step: 'account' };
        }
        // This opening decides which project (if any) the org adopts — a draft
        // left by another entry point must not carry a stale one in.
        next = { ...next, workspacePath: workspacePath ?? null };
        if (!next.orgName.trim() && suggestedName) {
          next = { ...next, orgName: suggestedName };
        }
      }
      stateRef.current = next;
      setState(next);
      setHydrated(true);
    });
    return () => { cancelled = true; };
  }, [
    auth,
    hydrated,
    identity,
    initialState,
    isOpen,
    suggestedName,
    workspacePath,
  ]);

  /**
   * Keep the draft attributed to whoever is signed in now.
   *
   * A change of identity also invalidates the invitation branch: it was
   * resolved for the previous account, and the lookup has to run again for the
   * new one (or not at all, once nobody is signed in).
   */
  const lastIdentityRef = useRef<string | null>(null);
  useEffect(() => {
    if (!isOpen || !hydrated) return;
    const previous = lastIdentityRef.current;
    if (previous === identity) return;
    lastIdentityRef.current = identity;
    update((current) => {
      let next = current;
      if (identity && current.owner !== identity) {
        next = { ...next, owner: identity };
      }
      // Only while the branch is still live: once the organization exists the
      // invitation choice is behind us, and clearing the lookup would leave the
      // identity step with nothing to render.
      if (previous !== null && !current.createdOrgId) {
        next = { ...next, pendingInvitation: null, inviteLookupStatus: 'idle' };
      }
      return next;
    });
  }, [hydrated, identity, isOpen, update]);

  useEffect(() => {
    if (!isOpen || !hydrated || !auth?.isAuthenticated) return;
    let cancelled = false;
    void Promise.resolve(window.electronAPI?.stytch?.getAccounts?.())
      .then((result) => {
        if (cancelled) return;
        const rows: PersonalAccount[] = Array.isArray(result) ? result : [];
        setAccounts(rows);
        // The stored draft may name an account that has since been removed or
        // signed out, and an unset choice defaults to the sync account rather
        // than whichever row the directory happened to return first.
        update((current) => {
          const resolved = current.sourcePersonalOrgId
            ? resolveSourcePersonalOrgId(current.sourcePersonalOrgId, rows)
            : defaultSourcePersonalOrgId(rows);
          return resolved === current.sourcePersonalOrgId
            ? current
            : { ...current, sourcePersonalOrgId: resolved };
        });
      })
      .catch(() => { /* The picker is optional; a single account needs none. */ });
    return () => { cancelled = true; };
  }, [auth?.isAuthenticated, hydrated, isOpen, update]);

  const handleAuthenticatedAccount = useCallback(async (email: string) => {
    const current = stateRef.current;
    if (current.inviteLookupStatus !== 'idle') return;
    // The answer is only about the account it was asked for. Signing out, or
    // switching accounts, mid-flight would otherwise commit one user's pending
    // invitation into another user's wizard.
    const requestIdentity = identityRef.current;
    const token = lookupRef.current + 1;
    lookupRef.current = token;
    commit({ ...current, inviteLookupStatus: 'checking', error: null });
    let invitation = null;
    try {
      invitation = email
        ? await wizardApi.findPendingInvitation(email)
        : null;
    } catch {
      // Invitation discovery is optional. A transient directory failure must
      // not block a signed-in user from creating an organization.
    }
    // A newer lookup already owns the state; this one has nothing left to say.
    if (lookupRef.current !== token) return;
    if (identityRef.current !== requestIdentity) {
      commit({
        ...stateRef.current,
        pendingInvitation: null,
        inviteLookupStatus: 'idle',
      });
      return;
    }
    commit(resolveAuthenticatedAccount(stateRef.current, invitation));
  }, [commit, wizardApi]);

  // A user who was already signed in skips the account screen, but still runs
  // the invitation branch before the name form is exposed.
  useEffect(() => {
    if (
      !isOpen
      || !hydrated
      || !auth?.isAuthenticated
      || state.step !== 'identity'
      || state.inviteLookupStatus !== 'idle'
      || state.createdOrgId
    ) {
      return;
    }
    void handleAuthenticatedAccount(authenticatedEmail(auth.user));
  }, [
    auth,
    handleAuthenticatedAccount,
    hydrated,
    isOpen,
    state.createdOrgId,
    state.inviteLookupStatus,
    state.step,
  ]);

  const commitEmailDraft = useCallback((raw: string) => {
    if (!raw.trim()) return;
    const { state: next, invalid } = addEmails(stateRef.current, raw);
    setInvalidEmails(invalid);
    commit(next);
    setEmailDraft('');
  }, [commit]);

  const runStep = useCallback(async (
    step: (current: OrgWizardState) => Promise<OrgWizardState>,
  ) => {
    const before = stateRef.current;
    if (before.busy) return;
    const busy: OrgWizardState = { ...before, busy: true, error: null };
    commit(busy);
    const result = await step(busy);
    commit({ ...result, busy: false });
  }, [commit]);

  const handleCreateOrganization = useCallback(async () => {
    await runStep(async (current) => {
      const next = await runCreateOrganization(current, wizardApi);
      if (!next.createdOrgId) {
        trackTeamAnalyticsEvent('team_operation_failed', {
          surface: 'desktop',
          operation: 'create_organization',
          entryPoint,
          errorCategory: categorizeTeamAnalyticsError('organization', next.error),
        });
        return next;
      }
      if (!current.createdOrgId) {
        trackTeamAnalyticsEvent('team_organization_created', {
          surface: 'desktop',
          entryPoint,
          projectAttached: current.workspacePath !== null,
          encryptionMode: 'server_managed',
          memberCountBucket: bucketMemberCount(1),
        });
        onOrganizationCreated?.(next.createdOrgId);
      }
      return advance(next);
    });
  }, [
    entryPoint,
    onOrganizationCreated,
    runStep,
    wizardApi,
  ]);

  const handleAcceptInvitation = useCallback(async () => {
    const invitation = stateRef.current.pendingInvitation;
    if (!invitation || stateRef.current.busy) return;
    update((current) => ({ ...current, busy: true, error: null }));
    try {
      const { orgId } = await wizardApi.acceptInvitation(invitation.orgId);
      if (dismissedRef.current) return;
      cancelDraft();
      // Queued, not opened: the org window stays closed until the user opens it
      // themselves, and then lands on #general.
      await Promise.all([
        queueOrgWindowGeneralRoute(orgId),
        clearOrgWizardDraft(),
      ]);
      onClose();
    } catch (reason) {
      update((current) => ({
        ...current,
        busy: false,
        error: reason instanceof Error ? reason.message : String(reason),
      }));
    }
  }, [cancelDraft, onClose, update, wizardApi]);

  const handleSendInvites = useCallback(async () => {
    const pendingDraft = emailDraft;
    setEmailDraft('');
    await runStep(async (current) => {
      const staged = pendingDraft.trim() ? addEmails(current, pendingDraft).state : current;
      const next = await runSendInvites(staged, wizardApi);
      const sent = next.invitedEmails.length - current.invitedEmails.length;
      if (sent > 0) {
        trackTeamAnalyticsEvent('team_invitation_sent', {
          surface: 'desktop',
          entryPoint,
          memberCountBucket: bucketMemberCount(sent + 1),
        });
      }
      return next.error ? next : advance(next);
    });
  }, [emailDraft, entryPoint, runStep, wizardApi]);

  const handleSkip = useCallback(() => {
    update((current) => advance(current));
  }, [update]);

  /**
   * Two ways out, and they mean different things.
   *
   * `later` — Escape, the scrim, Cancel — keeps the draft, so the next open
   * resumes exactly here. That resume is intended, but on its own it leaves no
   * way to stop the wizard reappearing; `discard` (the header close) is that
   * way out, and throws the in-flight setup away. An organization already
   * created is never undone by either. Reaching the last step is finishing,
   * whichever affordance closes it.
   *
   * Neither is available while a mutation is in flight: the create, join,
   * invite and room calls all finish by writing state, opening a window or
   * rewriting the hand-off, and a discard that lands mid-call is undone by
   * whichever of those returns last.
   */
  const dismiss = useCallback(async (intent: 'later' | 'discard') => {
    const current = stateRef.current;
    if (current.busy) return;
    dismissedRef.current = true;
    if (intent === 'discard' || current.step === 'done') {
      cancelDraft();
      await clearOrgWizardDraft();
    } else {
      flushDraft();
    }
    onClose();
  }, [cancelDraft, flushDraft, onClose]);

  const handleFinish = useCallback(async () => {
    cancelDraft();
    const orgId = state.createdOrgId;
    if (!orgId) {
      onClose();
      return;
    }
    // The creator just walked the wizard, so the invited-member welcome card is
    // noise for them — recording the dismissal up front suppresses it. The org
    // window is not opened here: it waits for the user, and lands on #general.
    await Promise.all([
      markOrgWelcomeDismissed(orgId),
      queueOrgWindowGeneralRoute(orgId),
      clearOrgWizardDraft(),
    ]);
    onClose();
  }, [cancelDraft, onClose, state.createdOrgId]);

  // Escape closes the wizard from anywhere in it. A handler on the card only
  // fires while focus is inside it, and the later steps autofocus nothing.
  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      void dismiss('later');
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [dismiss, isOpen]);

  if (!isOpen || !hydrated) return null;

  const namedOrg = state.orgName.trim().length > 0;
  const avatarColor = orgAvatarColor(state.orgName || 'organization');
  const showAccountPicker = accounts.length > 1;
  const ownerEmail = accounts.find(
    (account) => account.personalOrgId === state.sourcePersonalOrgId,
  )?.email ?? accounts[0]?.email ?? null;
  const isAuthenticated = state.step !== 'account';
  const visibleSteps = orgWizardSteps(isAuthenticated);
  // Guard rather than expectation: an unknown step must not render "Step 0".
  const stepPosition = visibleSteps.indexOf(state.step);

  return (
    <div
      className="org-creation-wizard-overlay fixed inset-0 z-[10000] flex items-center justify-center bg-black/60"
      data-testid="org-creation-wizard-overlay"
      onClick={(event) => {
        if (event.target === event.currentTarget) void dismiss('later');
      }}
    >
      <div
        className="org-creation-wizard w-[520px] max-w-[92vw] overflow-hidden rounded-xl border border-[var(--nim-border)] bg-[var(--nim-bg)] shadow-2xl"
        data-testid="org-creation-wizard"
        data-component="OrgCreationWizard"
        data-step={state.step}
        role="dialog"
        aria-modal="true"
        aria-label="Create an organization"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="org-creation-wizard-header flex items-center gap-2 border-b border-[var(--nim-border)] px-5 py-3">
          {/* Before a name exists there are no initials to show, and a "?" reads
              as something having gone wrong rather than as a step not yet taken. */}
          {namedOrg ? (
            <span
              className="org-wizard-avatar flex h-7 w-7 items-center justify-center rounded-md text-[11px] font-semibold text-white"
              style={{ backgroundColor: avatarColor }}
              data-testid="org-wizard-avatar"
            >
              {orgAvatarInitials(state.orgName)}
            </span>
          ) : (
            <span
              className="org-wizard-avatar org-wizard-avatar-placeholder flex h-7 w-7 items-center justify-center rounded-md bg-[var(--nim-bg-tertiary)] text-[var(--nim-text-muted)]"
              data-testid="org-wizard-avatar"
              aria-hidden="true"
            >
              <MaterialSymbol icon="group_add" size={16} />
            </span>
          )}
          <span className="min-w-0 flex-1 truncate text-sm font-semibold text-[var(--nim-text)]">
            {state.orgName.trim() || 'New organization'}
          </span>
          <AlphaBadge size="xs" stage="beta" tooltip={TEAM_BETA_TOOLTIP} />
          <button
            type="button"
            disabled={state.busy}
            className="org-wizard-close flex h-6 w-6 items-center justify-center rounded text-[var(--nim-text-muted)] hover:bg-[var(--nim-bg-hover)] hover:text-[var(--nim-text)] disabled:pointer-events-none disabled:opacity-40"
            data-testid="org-wizard-close"
            aria-label="Close setup and discard it"
            title={
              state.busy
                ? 'Finishing the current step…'
                : state.createdOrgId
                  ? 'Close setup — the organization stays, and you can invite people any time'
                  : 'Close and discard this setup'
            }
            onClick={() => void dismiss('discard')}
          >
            <MaterialSymbol icon="close" size={14} />
          </button>
        </header>

        <div className="org-creation-wizard-body px-5 py-4">
          <StepIndicator state={state} isAuthenticated={isAuthenticated} />

          {state.step === 'account' && (
            <OrgWizardAccountStep onAuthenticated={handleAuthenticatedAccount} />
          )}

          {state.step === 'identity' && state.pendingInvitation && (
            <section
              className="org-wizard-pending-invitation mt-4"
              data-testid="org-wizard-pending-invitation"
            >
              <h2 className="m-0 text-base font-semibold text-[var(--nim-text)]">
                You have been invited
              </h2>
              <p className="m-0 mt-1 text-[12px] text-[var(--nim-text-muted)]">
                Signed in as{' '}
                <span className="select-text text-[var(--nim-text)]">
                  {state.pendingInvitation.email}
                </span>
                . There is already an organization waiting for you.
              </p>

              {/* Joining is the recommended action: a second organization is
                  almost never what an invited user actually wants. */}
              <button
                type="button"
                className="org-wizard-accept-invitation mt-3 flex w-full items-center gap-3 rounded-lg border border-[var(--nim-primary)] bg-[color-mix(in_srgb,var(--nim-primary)_10%,transparent)] p-3 text-left disabled:opacity-50"
                data-testid="org-wizard-accept-invitation"
                disabled={state.busy}
                onClick={() => void handleAcceptInvitation()}
              >
                <span
                  className="org-wizard-invitation-avatar flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-[11px] font-semibold text-white"
                  style={{ backgroundColor: orgAvatarColor(state.pendingInvitation.name) }}
                >
                  {orgAvatarInitials(state.pendingInvitation.name)}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-semibold text-[var(--nim-text)]">
                    Join {state.pendingInvitation.name}
                  </span>
                  <span className="block text-[11px] text-[var(--nim-text-muted)]">
                    Recommended — you already have access
                  </span>
                </span>
                <span className="shrink-0 text-[12px] font-semibold text-[var(--nim-primary)]">
                  {state.busy ? 'Joining…' : 'Join'}
                </span>
              </button>

              <button
                type="button"
                className="org-wizard-create-instead mt-2 flex w-full items-center gap-3 rounded-lg border border-[var(--nim-border)] bg-[var(--nim-bg-secondary)] p-3 text-left disabled:opacity-50"
                data-testid="org-wizard-create-instead"
                disabled={state.busy}
                onClick={() => update((current) => ({
                  ...current,
                  pendingInvitation: null,
                }))}
              >
                <span className="org-wizard-invitation-avatar flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-[var(--nim-bg-tertiary)] text-[var(--nim-text-muted)]">
                  <MaterialSymbol icon="add" size={16} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-medium text-[var(--nim-text)]">
                    Create a new organization instead
                  </span>
                  <span className="block text-[11px] text-[var(--nim-text-muted)]">
                    Start your own team — the invitation stays available
                  </span>
                </span>
                <span className="shrink-0 text-[12px] text-[var(--nim-text-muted)]">Continue</span>
              </button>

              <p className="m-0 mt-3 text-[11px] text-[var(--nim-text-muted)]">
                Joining skips the rest of the setup. Open the organization from the org switcher whenever you like — it starts on #general.
              </p>
            </section>
          )}

          {state.step === 'identity'
            && !state.pendingInvitation
            && state.inviteLookupStatus === 'complete' && (
            <section className="org-wizard-identity-step mt-4" data-testid="org-wizard-identity-step">
              <h2 className="m-0 text-base font-semibold text-[var(--nim-text)]">Name your organization</h2>
              <p className="m-0 mt-1 text-[12px] text-[var(--nim-text-muted)]">
                Everyone you invite sees this name. You can change it later.
              </p>
              <TeamBetaNotice className="mt-3" />
              <label className="mt-3 block text-[11px] font-medium text-[var(--nim-text-muted)]">
                Organization name
                <input
                  className="org-wizard-name-input mt-1 w-full rounded-md border border-[var(--nim-border)] bg-[var(--nim-bg-secondary)] px-3 py-2 text-[13px] text-[var(--nim-text)] outline-none focus:border-[var(--nim-primary)]"
                  data-testid="org-wizard-name-input"
                  value={state.orgName}
                  autoFocus
                  onChange={(event) => update((current) => ({ ...current, orgName: event.target.value }))}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && canAdvance(state)) void handleCreateOrganization();
                  }}
                  placeholder="Acme Research"
                />
              </label>
              {/* With one account there is no choice to make, but the user
                  should still know which one is about to own the org. */}
              {!showAccountPicker && ownerEmail && (
                <p
                  className="org-wizard-owner-hint m-0 mt-1.5 text-[11px] text-[var(--nim-text-muted)]"
                  data-testid="org-wizard-owner-hint"
                >
                  Owned by <span className="select-text text-[var(--nim-text)]">{ownerEmail}</span>
                </p>
              )}
              {showAccountPicker && (
                <label className="mt-3 block text-[11px] font-medium text-[var(--nim-text-muted)]">
                  Owning personal account
                  <select
                    className="org-wizard-account-select mt-1 w-full rounded-md border border-[var(--nim-border)] bg-[var(--nim-bg-secondary)] px-2 py-2 text-[13px] text-[var(--nim-text)]"
                    data-testid="org-wizard-account-select"
                    value={state.sourcePersonalOrgId}
                    onChange={(event) => update((current) => ({ ...current, sourcePersonalOrgId: event.target.value }))}
                  >
                    {accounts.map((account) => (
                      <option key={account.personalOrgId} value={account.personalOrgId}>
                        {account.email ?? account.personalOrgId}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </section>
          )}

          {state.step === 'invite' && (
            <section className="org-wizard-invite-step mt-4" data-testid="org-wizard-invite-step">
              <h2 className="m-0 text-base font-semibold text-[var(--nim-text)]">Invite your team</h2>
              <p className="m-0 mt-1 text-[12px] text-[var(--nim-text-muted)]">
                Teammates get an email invitation. You can always invite more people later.
              </p>
              <div className="org-wizard-email-field mt-3 flex flex-wrap items-center gap-1.5 rounded-md border border-[var(--nim-border)] bg-[var(--nim-bg-secondary)] p-2">
                {state.emails.map((email) => (
                  <span
                    key={email}
                    className="org-wizard-email-chip flex items-center gap-1 rounded-full bg-[var(--nim-bg-tertiary)] px-2 py-0.5 text-[11px] text-[var(--nim-text)]"
                    data-testid="org-wizard-email-chip"
                  >
                    <span className="select-text">{email}</span>
                    <button
                      type="button"
                      aria-label={`Remove ${email}`}
                      className="text-[var(--nim-text-muted)] hover:text-[var(--nim-text)]"
                      onClick={() => update((current) => removeEmail(current, email))}
                    >
                      <MaterialSymbol icon="close" size={12} />
                    </button>
                  </span>
                ))}
                <input
                  className="org-wizard-email-input min-w-[160px] flex-1 bg-transparent px-1 py-0.5 text-[13px] text-[var(--nim-text)] outline-none"
                  data-testid="org-wizard-email-input"
                  value={emailDraft}
                  autoFocus
                  placeholder={state.emails.length > 0 ? 'Add another email…' : 'teammate@example.com'}
                  onChange={(event) => {
                    const value = event.target.value;
                    // A separator ends the address the user just typed, which is
                    // also what makes a pasted list land as chips.
                    if (/[,;\s]/.test(value)) commitEmailDraft(value);
                    else setEmailDraft(value);
                  }}
                  onBlur={() => commitEmailDraft(emailDraft)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      commitEmailDraft(emailDraft);
                    }
                  }}
                />
              </div>
              {invalidEmails.length > 0 && (
                <p className="org-wizard-email-invalid m-0 mt-1.5 text-[11px] text-[var(--nim-warning)]" data-testid="org-wizard-email-invalid">
                  Not an email address: {invalidEmails.join(', ')}
                </p>
              )}
              <p className="m-0 mt-2 text-[11px] text-[var(--nim-text-muted)]">
                Invited people join as members. Roles are changed from Members &amp; Roles.
              </p>
            </section>
          )}

          {state.step === 'done' && (
            <section className="org-wizard-done-step mt-4" data-testid="org-wizard-done-step">
              <h2 className="m-0 text-base font-semibold text-[var(--nim-text)]">
                {state.orgName.trim() || 'Your organization'} is ready
              </h2>
              <ul className="org-wizard-done-summary m-0 mt-3 flex list-none flex-col gap-1.5 p-0 text-[12px] text-[var(--nim-text-muted)]">
                <li className="flex items-center gap-2">
                  <MaterialSymbol icon="check_circle" size={14} className="text-[var(--nim-success)]" />
                  Organization created
                </li>
                <li className="flex items-center gap-2">
                  <MaterialSymbol icon={state.invitedEmails.length > 0 ? 'check_circle' : 'radio_button_unchecked'} size={14} className={state.invitedEmails.length > 0 ? 'text-[var(--nim-success)]' : 'text-[var(--nim-text-disabled)]'} />
                  {state.invitedEmails.length > 0
                    ? `${state.invitedEmails.length} ${state.invitedEmails.length === 1 ? 'invitation' : 'invitations'} sent`
                    : 'No invitations sent yet'}
                </li>
              </ul>
              <p className="m-0 mt-3 text-[12px] text-[var(--nim-text-muted)]">
                Open the organization from the org switcher whenever you're ready.
              </p>
            </section>
          )}

          {state.error && (
            <p className="org-wizard-error m-0 mt-3 select-text text-[12px] text-[var(--nim-error)]" data-testid="org-wizard-error">
              {state.error}
            </p>
          )}
        </div>

        <footer className="org-creation-wizard-footer flex items-center justify-between border-t border-[var(--nim-border)] px-5 py-3">
          <span className="text-[11px] text-[var(--nim-text-disabled)]" data-testid="org-wizard-step-count">
            {stepPosition >= 0 ? `Step ${stepPosition + 1} of ${visibleSteps.length}` : ''}
          </span>
          <div className="flex items-center gap-2">
            {state.step !== 'done' && (
              <button
                type="button"
                disabled={state.busy}
                className="org-wizard-cancel rounded-md border border-[var(--nim-border)] px-3 py-1.5 text-[12px] text-[var(--nim-text-muted)] hover:bg-[var(--nim-bg-hover)] disabled:pointer-events-none disabled:opacity-50"
                data-testid="org-wizard-cancel"
                onClick={() => void dismiss('later')}
              >
                {state.createdOrgId ? 'Finish later' : 'Cancel'}
              </button>
            )}
            {canSkip(state) && (
              <button
                type="button"
                className="org-wizard-skip rounded-md border border-[var(--nim-border)] px-3 py-1.5 text-[12px] text-[var(--nim-text)] hover:bg-[var(--nim-bg-hover)]"
                data-testid="org-wizard-skip"
                onClick={handleSkip}
              >
                Skip for now
              </button>
            )}
            {state.step === 'identity'
              && !state.pendingInvitation
              && state.inviteLookupStatus === 'complete' && (
              <button
                type="button"
                disabled={!canAdvance(state)}
                className="org-wizard-primary rounded-md bg-[var(--nim-primary)] px-4 py-1.5 text-[12px] font-semibold text-[var(--nim-on-primary)] disabled:opacity-50"
                data-testid="org-wizard-primary"
                onClick={() => void handleCreateOrganization()}
              >
                {/* A restored draft can land here with the organization already
                    created; the runner will not create a second one. */}
                {state.createdOrgId
                  ? (state.busy ? 'Continuing…' : 'Continue')
                  : (state.busy ? 'Creating…' : 'Create organization')}
              </button>
            )}
            {state.step === 'invite' && (
              <button
                type="button"
                disabled={state.busy}
                className="org-wizard-primary rounded-md bg-[var(--nim-primary)] px-4 py-1.5 text-[12px] font-semibold text-[var(--nim-on-primary)] disabled:opacity-50"
                data-testid="org-wizard-primary"
                onClick={() => void handleSendInvites()}
              >
                {state.busy ? 'Sending…' : 'Send invites and continue'}
              </button>
            )}
            {state.step === 'done' && (
              <button
                type="button"
                className="org-wizard-primary rounded-md bg-[var(--nim-primary)] px-4 py-1.5 text-[12px] font-semibold text-[var(--nim-on-primary)]"
                data-testid="org-wizard-primary"
                onClick={() => void handleFinish()}
              >
                Done
              </button>
            )}
          </div>
        </footer>
      </div>
    </div>
  );
}
