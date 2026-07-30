/**
 * Organization creation wizard.
 *
 * Four steps — name, invite, starting rooms, done — replacing the `<details>`
 * form that used to be buried in the Members panel. Everything stateful lives in
 * `orgWizardModel.ts` and every side effect in `orgWizardRunner.ts`; this file
 * is the surface.
 *
 * Ships behind the existing invite-only alpha gate: the entry points check
 * `organizationCreationEnabled` and `team:create` refuses outside dev builds.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MaterialSymbol } from '@nimbalyst/runtime';

import { AlphaBadge } from '../../common/AlphaBadge';
import { TEAM_ALPHA_TOOLTIP, TeamAlphaNotice } from '../../common/TeamAlphaNotice';
import {
  bucketMemberCount,
  categorizeTeamAnalyticsError,
} from '../../../../shared/analytics/teamAnalytics';
import { trackTeamAnalyticsEvent } from '../../../utils/teamAnalytics';
import {
  markOrgWelcomeDismissed,
  queueOrgWindowGeneralRoute,
} from './orgOnboardingStorage';
import { GENERAL_ROOM_ID } from './orgWizardModel';
import {
  ORG_WIZARD_STEPS,
  ORG_WIZARD_STEP_LABELS,
  STARTER_ROOM_OPTIONS,
  addEmails,
  advance,
  canAdvance,
  canSkip,
  createOrgWizardState,
  orgAvatarColor,
  orgAvatarInitials,
  removeEmail,
  stepIndex,
  stepStatus,
  toggleStarterRoom,
  type OrgWizardState,
} from './orgWizardModel';
import { createOrgWizardApi } from './orgWizardApi';
import {
  runCreateOrganization,
  runCreateStarterRooms,
  runPostWelcomeMessage,
  runSendInvites,
  type OrgWizardApi,
} from './orgWizardRunner';

interface PersonalAccount {
  personalOrgId: string;
  email: string | null;
}

export interface OrgCreationWizardProps {
  isOpen: boolean;
  onClose: () => void;
  /** Called once the organization exists, so lists behind the dialog refresh. */
  onOrganizationCreated?: (orgId: string) => void;
  /** Injected in tests; defaults to the live IPC-backed implementation. */
  api?: OrgWizardApi;
  openOrgWindow?: (orgId: string) => void;
}

function defaultOpenOrgWindow(orgId: string) {
  void window.electronAPI?.team?.openManagementWindow?.({ orgId });
}

function StepIndicator({ state }: { state: OrgWizardState }) {
  return (
    <ol className="org-wizard-steps m-0 flex list-none items-center gap-1 p-0" data-testid="org-wizard-steps">
      {ORG_WIZARD_STEPS.map((step, index) => {
        const status = stepStatus(state, step);
        return (
          <li key={step} className="org-wizard-step flex items-center gap-1" data-testid={`org-wizard-step-${step}`} data-status={status}>
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
              className={`org-wizard-step-label text-[11px] ${
                status === 'upcoming' ? 'text-[var(--nim-text-disabled)]' : 'text-[var(--nim-text)]'
              }`}
            >
              {ORG_WIZARD_STEP_LABELS[step]}
            </span>
            {index < ORG_WIZARD_STEPS.length - 1 && (
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
  onOrganizationCreated,
  api,
  openOrgWindow = defaultOpenOrgWindow,
}: OrgCreationWizardProps) {
  const wizardApi = useMemo(() => api ?? createOrgWizardApi(), [api]);
  const [state, setState] = useState<OrgWizardState>(() => createOrgWizardState());
  const [accounts, setAccounts] = useState<PersonalAccount[]>([]);
  const [emailDraft, setEmailDraft] = useState('');
  const [invalidEmails, setInvalidEmails] = useState<string[]>([]);

  // The async steps need the state as it is right now, and React's updater form
  // cannot carry a value out of itself, so writes go through this ref as well.
  const stateRef = useRef(state);
  const commit = useCallback((next: OrgWizardState) => {
    stateRef.current = next;
    setState(next);
  }, []);
  const update = useCallback((
    change: (current: OrgWizardState) => OrgWizardState,
  ) => {
    commit(change(stateRef.current));
  }, [commit]);

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    void Promise.resolve(window.electronAPI?.stytch?.getAccounts?.())
      .then((result) => {
        if (cancelled) return;
        const rows: PersonalAccount[] = Array.isArray(result) ? result : [];
        setAccounts(rows);
        update((current) => (
          current.sourcePersonalOrgId
            ? current
            : { ...current, sourcePersonalOrgId: rows[0]?.personalOrgId ?? '' }
        ));
      })
      .catch(() => { /* The picker is optional; a single account needs none. */ });
    return () => { cancelled = true; };
  }, [isOpen, update]);

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
          entryPoint: 'organization_manager',
          errorCategory: categorizeTeamAnalyticsError('organization', next.error),
        });
        return next;
      }
      if (!current.createdOrgId) {
        trackTeamAnalyticsEvent('team_organization_created', {
          surface: 'desktop',
          entryPoint: 'organization_manager',
          projectAttached: false,
          encryptionMode: 'server_managed',
          memberCountBucket: bucketMemberCount(1),
        });
        onOrganizationCreated?.(next.createdOrgId);
      }
      return advance(next);
    });
  }, [onOrganizationCreated, runStep, wizardApi]);

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
          entryPoint: 'organization_manager',
          memberCountBucket: bucketMemberCount(sent + 1),
        });
      }
      return next.error ? next : advance(next);
    });
  }, [emailDraft, runStep, wizardApi]);

  const handleCreateRooms = useCallback(async () => {
    await runStep(async (current) => {
      const next = await runCreateStarterRooms(current, wizardApi);
      if (next.error) return next;
      const posted = await runPostWelcomeMessage(next, wizardApi, GENERAL_ROOM_ID);
      return advance(posted);
    });
  }, [runStep, wizardApi]);

  const handleSkip = useCallback(async () => {
    if (state.step === 'invite') {
      update((current) => advance(current));
      return;
    }
    // Skipping the rooms step still posts the welcome message: it is what makes
    // #general readable when the creator lands there.
    await runStep(async (current) => {
      const posted = await runPostWelcomeMessage(current, wizardApi, GENERAL_ROOM_ID);
      return advance(posted);
    });
  }, [runStep, state.step, wizardApi]);

  const handleFinish = useCallback(async () => {
    const orgId = state.createdOrgId;
    if (!orgId) {
      onClose();
      return;
    }
    // The creator just walked the wizard, so the invited-member welcome card is
    // noise for them — recording the dismissal up front suppresses it.
    await Promise.all([
      markOrgWelcomeDismissed(orgId),
      queueOrgWindowGeneralRoute(orgId),
    ]);
    openOrgWindow(orgId);
    onClose();
  }, [onClose, openOrgWindow, state.createdOrgId]);

  // Escape closes the wizard from anywhere in it. A handler on the card only
  // fires while focus is inside it, and the later steps autofocus nothing.
  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const avatarColor = orgAvatarColor(state.orgName || 'organization');
  const showAccountPicker = accounts.length > 1;

  return (
    <div
      className="org-creation-wizard-overlay fixed inset-0 z-[10000] flex items-center justify-center bg-black/60"
      data-testid="org-creation-wizard-overlay"
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}
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
          <span
            className="org-wizard-avatar flex h-7 w-7 items-center justify-center rounded-md text-[11px] font-semibold text-white"
            style={{ backgroundColor: avatarColor }}
            data-testid="org-wizard-avatar"
          >
            {orgAvatarInitials(state.orgName)}
          </span>
          <span className="min-w-0 flex-1 truncate text-sm font-semibold text-[var(--nim-text)]">
            {state.orgName.trim() || 'New organization'}
          </span>
          <AlphaBadge size="xs" tooltip={TEAM_ALPHA_TOOLTIP} />
        </header>

        <div className="org-creation-wizard-body px-5 py-4">
          <StepIndicator state={state} />

          {state.step === 'identity' && (
            <section className="org-wizard-identity-step mt-4" data-testid="org-wizard-identity-step">
              <h2 className="m-0 text-base font-semibold text-[var(--nim-text)]">Name your organization</h2>
              <p className="m-0 mt-1 text-[12px] text-[var(--nim-text-muted)]">
                Everyone you invite sees this name. You can change it later.
              </p>
              <TeamAlphaNotice className="mt-3" />
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

          {state.step === 'rooms' && (
            <section className="org-wizard-rooms-step mt-4" data-testid="org-wizard-rooms-step">
              <h2 className="m-0 text-base font-semibold text-[var(--nim-text)]">Starting rooms</h2>
              <p className="m-0 mt-1 text-[12px] text-[var(--nim-text-muted)]">
                Every organization has #general. Add any of these to start with — rooms can be created and archived at any time.
              </p>
              <div className="org-wizard-room-chips mt-3 flex flex-wrap gap-2">
                <span
                  className="org-wizard-room-chip org-wizard-room-chip-included flex items-center gap-1.5 rounded-full border border-[var(--nim-border)] bg-[var(--nim-bg-secondary)] px-3 py-1.5 text-[12px] text-[var(--nim-text-muted)]"
                  data-testid="org-wizard-room-chip-general"
                >
                  <span className="text-[var(--nim-text-disabled)]">#</span>
                  {GENERAL_ROOM_ID}
                  <span className="text-[10px] text-[var(--nim-success)]">included</span>
                </span>
                {STARTER_ROOM_OPTIONS.map((option) => {
                  const selected = state.selectedRoomIds.includes(option.id);
                  return (
                    <button
                      key={option.id}
                      type="button"
                      role="checkbox"
                      aria-checked={selected}
                      title={option.topic}
                      className={`org-wizard-room-chip flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[12px] ${
                        selected
                          ? 'border-[var(--nim-primary)] bg-[color-mix(in_srgb,var(--nim-primary)_12%,transparent)] text-[var(--nim-text)]'
                          : 'border-[var(--nim-border)] bg-[var(--nim-bg-secondary)] text-[var(--nim-text-muted)]'
                      }`}
                      data-testid={`org-wizard-room-chip-${option.id}`}
                      data-selected={selected}
                      onClick={() => update((current) => toggleStarterRoom(current, option.id))}
                    >
                      <MaterialSymbol icon={selected ? 'check_box' : 'check_box_outline_blank'} size={14} />
                      <span className="text-[var(--nim-text-disabled)]">#</span>
                      {option.title}
                    </button>
                  );
                })}
              </div>
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
                <li className="flex items-center gap-2">
                  <MaterialSymbol icon="check_circle" size={14} className="text-[var(--nim-success)]" />
                  {state.createdRoomIds.length > 0
                    ? `#general plus ${state.createdRoomIds.map((roomId) => `#${roomId}`).join(', ')}`
                    : '#general is ready'}
                </li>
              </ul>
              <p className="m-0 mt-3 text-[12px] text-[var(--nim-text-muted)]">
                The organization window opens on #general, where a note explains the Inbox, rooms and admin sections.
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
          <span className="text-[11px] text-[var(--nim-text-disabled)]">
            Step {stepIndex(state.step) + 1} of {ORG_WIZARD_STEPS.length}
          </span>
          <div className="flex items-center gap-2">
            {state.step !== 'done' && (
              <button
                type="button"
                className="org-wizard-cancel rounded-md border border-[var(--nim-border)] px-3 py-1.5 text-[12px] text-[var(--nim-text-muted)] hover:bg-[var(--nim-bg-hover)]"
                data-testid="org-wizard-cancel"
                onClick={onClose}
              >
                {state.createdOrgId ? 'Close' : 'Cancel'}
              </button>
            )}
            {canSkip(state) && (
              <button
                type="button"
                className="org-wizard-skip rounded-md border border-[var(--nim-border)] px-3 py-1.5 text-[12px] text-[var(--nim-text)] hover:bg-[var(--nim-bg-hover)]"
                data-testid="org-wizard-skip"
                onClick={() => void handleSkip()}
              >
                Skip for now
              </button>
            )}
            {state.step === 'identity' && (
              <button
                type="button"
                disabled={!canAdvance(state)}
                className="org-wizard-primary rounded-md bg-[var(--nim-primary)] px-4 py-1.5 text-[12px] font-semibold text-[var(--nim-on-primary)] disabled:opacity-50"
                data-testid="org-wizard-primary"
                onClick={() => void handleCreateOrganization()}
              >
                {state.busy ? 'Creating…' : 'Create organization'}
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
            {state.step === 'rooms' && (
              <button
                type="button"
                disabled={state.busy}
                className="org-wizard-primary rounded-md bg-[var(--nim-primary)] px-4 py-1.5 text-[12px] font-semibold text-[var(--nim-on-primary)] disabled:opacity-50"
                data-testid="org-wizard-primary"
                onClick={() => void handleCreateRooms()}
              >
                {state.busy ? 'Creating…' : 'Create rooms and continue'}
              </button>
            )}
            {state.step === 'done' && (
              <button
                type="button"
                className="org-wizard-primary rounded-md bg-[var(--nim-primary)] px-4 py-1.5 text-[12px] font-semibold text-[var(--nim-on-primary)]"
                data-testid="org-wizard-primary"
                onClick={() => void handleFinish()}
              >
                Open #general
              </button>
            )}
          </div>
        </footer>
      </div>
    </div>
  );
}
