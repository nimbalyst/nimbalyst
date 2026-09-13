/**
 * CloudflareSandboxesPanel — Settings > Application > Cloudflare Sandboxes.
 *
 * Walks four gates in order, each of which must be satisfied explicitly:
 *   1. prerequisites (Wrangler with profile support; no local container runtime)
 *   2. a Wrangler profile, chosen from `wrangler auth list` or created through
 *      Wrangler's browser SSO flow
 *   3. a Cloudflare account, always chosen by hand — a single account is still
 *      a choice, never a silent default
 *   4. a reviewed deployment plan (resources + cost) acknowledged before deploy
 *
 * There are no API-key or token fields anywhere in this panel by design;
 * authentication belongs to Wrangler. See ../../../../shared/cloudflareSandbox.
 *
 * Async loads are sequenced: a profile switch invalidates in-flight account
 * loads, and any selection change invalidates the plan, so a slow response for
 * a superseded selection can never populate the UI it no longer describes.
 */

import type { JSX } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { MaterialSymbol } from '@nimbalyst/runtime/ui/icons/MaterialSymbol';
import {
  CLOUDFLARE_SANDBOX_CHANNELS,
  RESERVED_WRANGLER_PROFILE_NAMES,
  WRANGLER_PROFILE_NAME_PATTERN,
  type CloudflareAccount,
  type CloudflareSandboxError,
  type CloudflareSandboxPrerequisites,
  type DeploymentPlan,
  type SandboxDeployment,
  type WranglerProfile,
} from '../../../../shared/cloudflareSandbox';
import { invokeSandbox } from './CloudflareSandboxClient';
import { CloudflareSandboxStatusCard } from './CloudflareSandboxStatusCard';

type PendingOperation = 'none' | 'signing-in' | 'planning' | 'deploying';

const sectionClass = 'cloudflare-sandbox-section py-4 border-b border-[var(--nim-border)] last:border-b-0';
const headingClass = 'text-[13px] font-semibold text-[var(--nim-text)] mb-1';
const hintClass = 'text-[12px] leading-relaxed text-[var(--nim-text-muted)]';
const buttonClass =
  'px-3 py-1.5 text-[13px] rounded-md border border-[var(--nim-border)] bg-[var(--nim-bg)] text-[var(--nim-text)] hover:border-[var(--nim-primary)] disabled:opacity-50 disabled:cursor-not-allowed transition-colors';
const primaryButtonClass =
  'px-3 py-1.5 text-[13px] rounded-md bg-[var(--nim-primary)] text-white hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed transition-opacity';

/**
 * A plan is only ever shown or deployable while it still describes the current
 * selection. A review that arrives after the user moved on describes an account
 * they never agreed to deploy to, so this is the one test both the rendering
 * and the deploy handler use.
 */
/**
 * Mirrors Wrangler's own `validateProfileName`. `default` and `staging` are
 * reserved — `wrangler auth create` refuses them, and `default` is instead
 * managed by plain `wrangler login`, which is what the existing profile list
 * offers. Returns null when the name is usable.
 */
function newProfileNameError(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return null;
  if ((RESERVED_WRANGLER_PROFILE_NAMES as readonly string[]).includes(trimmed.toLowerCase())) {
    return `"${trimmed}" is reserved by Wrangler. Sign in to it from the profile list above instead.`;
  }
  if (!WRANGLER_PROFILE_NAME_PATTERN.test(trimmed)) {
    return 'Profile names may only contain letters, numbers, hyphens and underscores.';
  }
  return null;
}

function planAppliesTo(
  plan: DeploymentPlan | null,
  profileName: string | null,
  accountId: string | null,
): plan is DeploymentPlan {
  return plan !== null && plan.profileName === profileName && plan.account.id === accountId;
}

function ErrorNote({ error }: { error: CloudflareSandboxError }): JSX.Element {
  return (
    <p className="cloudflare-sandbox-error text-[12px] text-[var(--nim-error)] mt-2" role="alert">
      {error.message}
    </p>
  );
}

export function CloudflareSandboxesPanel({ workspacePath }: { workspacePath?: string }): JSX.Element {
  return <CloudflareSandboxesContent key={workspacePath ?? "global"} workspacePath={workspacePath} />;
}

function CloudflareSandboxesContent({ workspacePath }: { workspacePath?: string }): JSX.Element {
  const selectionTouched = useRef(false);
  const savedSelection = useRef<{profileName: string; accountId: string | null} | null>(null);
  const saveSelection = useCallback((profileName: string, accountId: string | null) => {
    selectionTouched.current = true;
    if (!workspacePath) return;
    void window.electronAPI.invoke("workspace:update-state", workspacePath, {cloudflareSandboxSelection: {profileName, accountId}})
      .catch(() => setSelectionError("The Cloudflare selection could not be saved. Please select it again."));
  }, [workspacePath]);
  const [selectionError, setSelectionError] = useState<string | null>(null);
  const [selectionLoaded, setSelectionLoaded] = useState(!workspacePath);
  useEffect(() => {
    if (!workspacePath) return;
    let cancelled = false;
    void window.electronAPI.invoke("workspace:get-state", workspacePath).then(state => {
      if (cancelled || selectionTouched.current) return;
      const saved = state?.cloudflareSandboxSelection;
      if (typeof saved?.profileName === "string") savedSelection.current = saved;
    }).catch(() => { if (!cancelled) setSelectionError("The saved Cloudflare selection could not be loaded."); })
      .finally(() => { if (!cancelled) setSelectionLoaded(true); });
    return () => { cancelled = true; accountsRequest.current++; };
  }, [workspacePath]);
  const [prerequisites, setPrerequisites] = useState<CloudflareSandboxPrerequisites | null>(null);
  const [prerequisitesError, setPrerequisitesError] = useState<CloudflareSandboxError | null>(null);
  const [prerequisitesLoading, setPrerequisitesLoading] = useState(true);

  const [profiles, setProfiles] = useState<WranglerProfile[] | null>(null);
  const [profilesError, setProfilesError] = useState<CloudflareSandboxError | null>(null);
  const [profilesLoading, setProfilesLoading] = useState(false);
  const [selectedProfileName, setSelectedProfileName] = useState<string | null>(null);
  const [newProfileName, setNewProfileName] = useState('');

  const [accounts, setAccounts] = useState<CloudflareAccount[] | null>(null);
  const [accountsError, setAccountsError] = useState<CloudflareSandboxError | null>(null);
  const [accountsLoading, setAccountsLoading] = useState(false);
  const [selectedAccountId, setSelectedAccountId] = useState<string | null>(null);

  const [plan, setPlan] = useState<DeploymentPlan | null>(null);
  const [planError, setPlanError] = useState<CloudflareSandboxError | null>(null);
  const [planAcknowledged, setPlanAcknowledged] = useState(false);

  const [deployment, setDeployment] = useState<SandboxDeployment | null>(null);
  const [deploymentError, setDeploymentError] = useState<CloudflareSandboxError | null>(null);
  const [deploymentLoadError, setDeploymentLoadError] = useState<CloudflareSandboxError | null>(null);
  const [deploymentLoading, setDeploymentLoading] = useState(true);
  const [operation, setOperation] = useState<PendingOperation>('none');

  // Monotonic tokens: a response is applied only if it belongs to the latest
  // request for that family. Without these, switching profiles while an
  // account list is in flight lands the old profile's accounts under the new
  // profile — a wrong-account deployment one click away. A plan needs no token:
  // it names the profile and account it describes, so `planAppliesTo` is the
  // single test of whether it still applies.
  const profilesRequest = useRef(0);
  const accountsRequest = useRef(0);
  // A deploy, a wake/stop, or a delete produces a NEWER record than any read
  // already in flight. Bumping the generation on those writes means a slow
  // get-deployment cannot overwrite the result of an action the user just
  // took — including resurrecting a deployment they just deleted.
  const deploymentGeneration = useRef(0);
  const deploymentRequest = useRef(0);

  /** Applies an authoritative write and invalidates any in-flight read. */
  const applyDeployment = useCallback((next: SandboxDeployment | null) => {
    deploymentGeneration.current += 1;
    setDeployment(next);
    setDeploymentLoadError(null);
  }, []);

  const loadPrerequisites = useCallback(async () => {
    setPrerequisitesLoading(true);
    setPrerequisitesError(null);
    const response = await invokeSandbox<CloudflareSandboxPrerequisites>(
      CLOUDFLARE_SANDBOX_CHANNELS.getPrerequisites,
    );
    if (response.success) setPrerequisites(response.data);
    else {
      setPrerequisites(null);
      setPrerequisitesError(response.error);
    }
    setPrerequisitesLoading(false);
  }, []);

  const loadProfiles = useCallback(async () => {
    const token = ++profilesRequest.current;
    setProfilesLoading(true);
    setProfilesError(null);
    const response = await invokeSandbox<WranglerProfile[]>(CLOUDFLARE_SANDBOX_CHANNELS.listProfiles);
    if (token !== profilesRequest.current) return;
    if (response.success) setProfiles(response.data);
    else {
      setProfiles(null);
      setProfilesError(response.error);
    }
    setProfilesLoading(false);
  }, []);

  const loadDeployment = useCallback(async () => {
    const generation = deploymentGeneration.current;
    const token = ++deploymentRequest.current;
    setDeploymentLoading(true);
    setDeploymentLoadError(null);
    const response = await invokeSandbox<SandboxDeployment | null>(
      CLOUDFLARE_SANDBOX_CHANNELS.getDeployment,
    );
    // Superseded by a newer read, or by a write that happened while this was
    // in flight. Either way this answer is older than what is on screen.
    if (token !== deploymentRequest.current) return;
    if (generation !== deploymentGeneration.current) return;
    setDeploymentLoading(false);
    if (response.success) setDeployment(response.data);
    // A failed read is not evidence the sandbox is gone. Keep the last known
    // record and say the read failed, so a transient IPC error cannot present
    // itself as "no deployment".
    else setDeploymentLoadError(response.error);
  }, []);

  useEffect(() => {
    void loadPrerequisites();
    void loadProfiles();
    void loadDeployment();
  }, [loadPrerequisites, loadProfiles, loadDeployment]);

  /** Any selection change makes an existing plan describe the wrong thing. */
  const invalidatePlan = useCallback(() => {
    setPlan(null);
    setPlanError(null);
    setPlanAcknowledged(false);
  }, []);

  const handleSelectProfile = useCallback(
    async (profileName: string, restoredAccount?: string | null) => {
      if (restoredAccount === undefined) saveSelection(profileName, null);
      setSelectedProfileName(profileName);
      setSelectedAccountId(null);
      setAccounts(null);
      setAccountsError(null);
      invalidatePlan();

      const token = ++accountsRequest.current;
      setAccountsLoading(true);
      const response = await invokeSandbox<CloudflareAccount[]>(
        CLOUDFLARE_SANDBOX_CHANNELS.listAccounts,
        { profileName },
      );
      if (token !== accountsRequest.current) return;
      if (response.success) {
        setAccounts(response.data);
        if (restoredAccount && response.data.some(account => account.id === restoredAccount)) setSelectedAccountId(restoredAccount);
      }
      else setAccountsError(response.error);
      setAccountsLoading(false);
    },
    [invalidatePlan, saveSelection],
  );

  useEffect(() => {
    if (!selectionLoaded || !profiles || selectionTouched.current) return;
    const saved = savedSelection.current;
    savedSelection.current = null;
    if (saved && profiles.some(profile => profile.name === saved.profileName)) void handleSelectProfile(saved.profileName, saved.accountId);
  }, [selectionLoaded, profiles, handleSelectProfile]);

  const handleSignIn = useCallback(
    async (name: string, reauthenticate: boolean) => {
      if (!name.trim() || operation !== 'none') return;
      setOperation('signing-in');
      setProfilesError(null);
      const response = await invokeSandbox<WranglerProfile>(
        CLOUDFLARE_SANDBOX_CHANNELS.createProfile,
        { name: name.trim(), reauthenticate },
      );
      setOperation('none');
      if (!response.success) {
        setProfilesError(response.error);
        return;
      }
      setNewProfileName('');
      await loadProfiles();
      await handleSelectProfile(response.data.name);
    },
    [operation, loadProfiles, handleSelectProfile],
  );

  const handleReviewDeployment = useCallback(async () => {
    if (!selectedProfileName || !selectedAccountId || operation !== 'none') return;
    setOperation('planning');
    setPlanError(null);
    setPlanAcknowledged(false);
    const response = await invokeSandbox<DeploymentPlan>(
      CLOUDFLARE_SANDBOX_CHANNELS.planDeployment,
      { profileName: selectedProfileName, accountId: selectedAccountId },
    );
    setOperation('none');
    if (response.success) setPlan(response.data);
    else setPlanError(response.error);
  }, [selectedProfileName, selectedAccountId, operation]);

  const handleDeploy = useCallback(async () => {
    if (!planAcknowledged || operation !== 'none') return;
    if (!planAppliesTo(plan, selectedProfileName, selectedAccountId)) return;
    if (!selectedProfileName || !selectedAccountId) return;
    setOperation('deploying');
    setDeploymentError(null);
    const response = await invokeSandbox<SandboxDeployment>(CLOUDFLARE_SANDBOX_CHANNELS.deploy, {
      planId: plan.planId,
      profileName: selectedProfileName,
      accountId: selectedAccountId,
    });
    setOperation('none');
    if (response.success) {
      applyDeployment(response.data);
      invalidatePlan();
    } else {
      setDeploymentError(response.error);
    }
  }, [
    plan,
    planAcknowledged,
    selectedProfileName,
    selectedAccountId,
    operation,
    invalidatePlan,
    applyDeployment,
  ]);

  const selectedProfile = profiles?.find((profile) => profile.name === selectedProfileName) ?? null;
  const prerequisitesReady = prerequisites?.ready === true;
  const profileReady = selectedProfile?.authenticated === true;
  const planMatchesSelection = planAppliesTo(plan, selectedProfileName, selectedAccountId);
  const canReview = prerequisitesReady && profileReady && !!selectedAccountId && operation === 'none';
  const canDeploy = canReview && planMatchesSelection && planAcknowledged;

  return (
    <div className="cloudflare-sandboxes-panel provider-panel flex flex-col" data-testid="cloudflare-sandboxes-panel">
      <div className="provider-panel-header mb-2 pb-4 border-b border-[var(--nim-border)]">
        <h3 className="provider-panel-title text-xl font-semibold leading-tight mb-1.5 text-[var(--nim-text)]">
          Cloudflare Sandboxes
        </h3>
        <p className="provider-panel-description text-[13px] leading-relaxed text-[var(--nim-text-muted)]">
          Deploy and manage a sandbox container in your own Cloudflare account. Nimbalyst signs in
          through Wrangler in your browser and uses your Wrangler profiles — it never asks for an
          API token. Connect an agent node to start remote sessions from a git branch.
          The container keeps nothing between stops.
        </p>
      </div>

      {/* 1. Prerequisites */}
      <section className={sectionClass} data-testid="cloudflare-prerequisites-section">
        <div className="flex items-center justify-between gap-3 mb-2">
          <h4 className={headingClass}>Prerequisites</h4>
          <button
            className={buttonClass}
            onClick={() => void loadPrerequisites()}
            disabled={prerequisitesLoading}
            data-testid="cloudflare-recheck-prerequisites"
          >
            {prerequisitesLoading ? 'Checking…' : 'Re-check'}
          </button>
        </div>
        {prerequisitesError ? (
          <ErrorNote error={prerequisitesError} />
        ) : prerequisites ? (
          <ul className="flex flex-col gap-1.5">
            <PrerequisiteRow
              testId="cloudflare-prereq-wrangler"
              ok={prerequisites.wrangler.installed && prerequisites.wrangler.supportsProfiles}
              label={
                !prerequisites.wrangler.installed
                  ? 'Wrangler is not installed'
                  : !prerequisites.wrangler.supportsProfiles
                    ? `Wrangler ${prerequisites.wrangler.version ?? ''} does not support profiles`.trim()
                    : `Wrangler ${prerequisites.wrangler.version ?? ''}`.trim()
              }
              hint={
                prerequisites.wrangler.installed
                  ? undefined
                  : 'Install Wrangler, then re-check.'
              }
            />
          </ul>
        ) : (
          <p className={hintClass}>Checking your machine…</p>
        )}
      </section>

      {/* 2. Wrangler profile */}
      <section className={sectionClass} data-testid="cloudflare-profile-section">
        <h4 className={headingClass}>Cloudflare sign-in</h4>
        <p className={hintClass}>
          Pick one of your Wrangler profiles, or sign in to create a new named profile. Profiles let
          you keep separate Cloudflare accounts side by side.
        </p>

        {profilesLoading && !profiles ? (
          <p className={`${hintClass} mt-3`}>Loading profiles…</p>
        ) : (
          <div className="flex flex-col gap-1.5 mt-3" role="radiogroup" aria-label="Wrangler profile">
            {(profiles ?? []).map((profile) => (
              <label
                key={profile.name}
                className="flex items-center gap-2.5 text-[13px] text-[var(--nim-text)] cursor-pointer"
              >
                <input
                  type="radio"
                  name="cloudflare-wrangler-profile"
                  value={profile.name}
                  checked={selectedProfileName === profile.name}
                  onChange={() => void handleSelectProfile(profile.name)}
                  data-testid={`cloudflare-profile-${profile.name}`}
                />
                <span>{profile.name}</span>
                {profile.identity && (
                  <span className="text-[12px] text-[var(--nim-text-muted)]">{profile.identity}</span>
                )}
                {!profile.authenticated && (
                  <span className="text-[12px] text-[var(--nim-warning)]">signed out</span>
                )}
              </label>
            ))}
            {profiles?.length === 0 && (
              <p className={hintClass} data-testid="cloudflare-no-profiles">
                No Wrangler profiles yet.
              </p>
            )}
          </div>
        )}

        {selectedProfile && !selectedProfile.authenticated && (
          <button
            className={`${buttonClass} mt-3`}
            onClick={() => void handleSignIn(selectedProfile.name, true)}
            disabled={operation !== 'none'}
            data-testid="cloudflare-reauthenticate"
          >
            {operation === 'signing-in' ? 'Waiting for browser…' : `Sign in again as ${selectedProfile.name}`}
          </button>
        )}

        <div className="flex items-center gap-2 mt-3">
          <input
            type="text"
            className="px-2.5 py-1.5 text-[13px] bg-[var(--nim-bg)] border border-[var(--nim-border)] rounded-md text-[var(--nim-text)] outline-none focus:border-[var(--nim-primary)]"
            placeholder="New profile name"
            value={newProfileName}
            onChange={(event) => setNewProfileName(event.target.value)}
            data-testid="cloudflare-new-profile-name"
          />
          <button
            className={buttonClass}
            onClick={() => void handleSignIn(newProfileName, false)}
            disabled={
              operation !== 'none'
              || newProfileName.trim().length === 0
              || newProfileNameError(newProfileName) !== null
            }
            data-testid="cloudflare-sign-in"
          >
            {operation === 'signing-in' ? 'Waiting for browser…' : 'Sign in with Cloudflare'}
          </button>
        </div>
        {newProfileNameError(newProfileName) && (
          <p
            className="text-[12px] text-[var(--nim-error)] mt-2"
            role="alert"
            data-testid="cloudflare-new-profile-name-error"
          >
            {newProfileNameError(newProfileName)}
          </p>
        )}
        {profilesError && <ErrorNote error={profilesError} />}
      </section>

      {/* 3. Account */}
      <section className={sectionClass} data-testid="cloudflare-account-section">
        <h4 className={headingClass}>Cloudflare account</h4>
        {selectionError && <p role="alert" className={hintClass}>{selectionError}</p>}
        <p className={hintClass}>
          Choose which account this sandbox is deployed to. Your selection is remembered for this project.
        </p>
        {!selectedProfileName ? (
          <p className={`${hintClass} mt-3`} data-testid="cloudflare-account-blocked">
            Select a profile first.
          </p>
        ) : accountsLoading ? (
          <p className={`${hintClass} mt-3`}>Loading accounts…</p>
        ) : accountsError ? (
          <ErrorNote error={accountsError} />
        ) : (
          <select
            className="mt-3 w-full max-w-sm px-2.5 py-2 text-[13px] bg-[var(--nim-bg)] border border-[var(--nim-border)] rounded-md text-[var(--nim-text)] outline-none focus:border-[var(--nim-primary)]"
            value={selectedAccountId ?? ''}
            onChange={(event) => {
              setSelectedAccountId(event.target.value || null);
              if (selectedProfileName) saveSelection(selectedProfileName, event.target.value || null);
              invalidatePlan();
            }}
            data-testid="cloudflare-account-select"
            aria-label="Cloudflare account"
          >
            <option value="">Select an account…</option>
            {(accounts ?? []).map((account) => (
              <option key={account.id} value={account.id}>
                {account.name}
              </option>
            ))}
          </select>
        )}
      </section>

      {/* 4. Review and deploy */}
      <section className={sectionClass} data-testid="cloudflare-deploy-section">
        <h4 className={headingClass}>Review and deploy</h4>
        <p className={hintClass}>
          Review exactly what will be created in your account, and what it costs, before deploying.
        </p>

        <button
          className={`${buttonClass} mt-3`}
          onClick={() => void handleReviewDeployment()}
          disabled={!canReview}
          data-testid="cloudflare-review-deployment"
        >
          {operation === 'planning' ? 'Preparing review…' : 'Review deployment'}
        </button>
        {planError && <ErrorNote error={planError} />}

        {planMatchesSelection && plan && (
          <div
            className="cloudflare-deployment-plan mt-4 p-3 rounded-lg border border-[var(--nim-border)] bg-[var(--nim-bg-secondary)]"
            data-testid="cloudflare-deployment-plan"
          >
            <p className="text-[13px] text-[var(--nim-text)] mb-2">
              Deploying to <strong>{plan.account.name}</strong> using profile{' '}
              <strong>{plan.profileName}</strong>.
            </p>
            <ul className="flex flex-col gap-1 mb-3">
              {plan.resources.map((resource) => (
                <li key={`${resource.kind}:${resource.name}`} className="text-[12px] text-[var(--nim-text-muted)]">
                  {resource.action === 'create' ? 'Create' : resource.action === 'update' ? 'Update' : 'Reuse'}
                  {' '}{resource.kind} <span className="text-[var(--nim-text)]">{resource.name}</span>
                </li>
              ))}
            </ul>
            <p className="text-[12px] text-[var(--nim-text-muted)] mb-2" data-testid="cloudflare-plan-container">
              Container: {plan.container.instanceType}, at most {plan.container.maxInstances}{' '}
              {plan.container.maxInstances === 1 ? 'instance' : 'instances'}, sleeping after{' '}
              {plan.container.sleepAfterMinutes} minutes idle.
            </p>
            {plan.requiresPaidPlan && (
              <p className="text-[12px] text-[var(--nim-warning)] mb-2">
                This requires a paid Cloudflare plan on {plan.account.name}.
              </p>
            )}
            {plan.costNotes.map((note) => (
              <p key={note} className="text-[12px] text-[var(--nim-text-muted)] mb-1">{note}</p>
            ))}
            <label className="flex items-center gap-2 mt-3 text-[13px] text-[var(--nim-text)] cursor-pointer">
              <input
                type="checkbox"
                checked={planAcknowledged}
                onChange={(event) => setPlanAcknowledged(event.target.checked)}
                data-testid="cloudflare-acknowledge-plan"
              />
              I understand these resources and charges apply to my Cloudflare account.
            </label>
          </div>
        )}

        <div className="mt-3">
          <button
            className={primaryButtonClass}
            onClick={() => void handleDeploy()}
            disabled={!canDeploy}
            data-testid="cloudflare-deploy"
          >
            {operation === 'deploying' ? 'Deploying…' : 'Deploy sandbox'}
          </button>
        </div>
        {deploymentError && <ErrorNote error={deploymentError} />}
      </section>

      {/* Deployed sandbox. A deploy is not a running container, so lifecycle
          state lives in its own card with its own separate container line. */}
      {deploymentLoadError && (
        <div className="cloudflare-deployment-load-error py-4" data-testid="cloudflare-deployment-load-error">
          <p className="text-[13px] text-[var(--nim-error)]" role="alert">
            {deployment
              ? `Could not refresh the sandbox: ${deploymentLoadError.message} Showing the last known state.`
              : `Could not read the sandbox: ${deploymentLoadError.message}`}
          </p>
          <button
            className={`${buttonClass} mt-2`}
            onClick={() => void loadDeployment()}
            disabled={deploymentLoading}
            data-testid="cloudflare-retry-deployment-load"
          >
            {deploymentLoading ? 'Retrying…' : 'Retry'}
          </button>
        </div>
      )}

      {deployment && deployment.status !== 'not-deployed' && (
        <CloudflareSandboxStatusCard
          deployment={deployment}
          onDeploymentChange={applyDeployment}
          onRefresh={() => void loadDeployment()}
        />
      )}

    </div>
  );
}

function PrerequisiteRow({
  ok,
  label,
  hint,
  testId,
}: {
  ok: boolean;
  label: string;
  hint?: string;
  testId: string;
}): JSX.Element {
  return (
    <li className="flex items-start gap-2 text-[13px] text-[var(--nim-text)]" data-testid={testId}>
      <MaterialSymbol
        icon={ok ? 'check_circle' : 'error'}
        size={16}
        className={ok ? 'text-[var(--nim-success)] shrink-0 mt-0.5' : 'text-[var(--nim-warning)] shrink-0 mt-0.5'}
      />
      <span>
        {label}
        {hint && <span className="block text-[12px] text-[var(--nim-text-muted)]">{hint}</span>}
      </span>
    </li>
  );
}
