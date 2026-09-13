/**
 * Lifecycle controls for the one deployed sandbox: wake, stop, delete.
 *
 * Three things this component refuses to do:
 *
 * 1. Conflate a deployment with a warm container. "Deployed" and the container
 *    state are rendered as separate facts, and the container line always says
 *    when it was observed — never implies live truth.
 * 2. Act on an implicit "current" deployment. Every request carries the
 *    deploymentId/revision/profile/account it was rendered from, so a second
 *    window holding a stale record is rejected by the handler
 *    (`deployment-stale`) instead of stopping or deleting the wrong account's
 *    sandbox.
 * 3. Carry consent across a target change. Confirmation is bound to the exact
 *    deployment that was on screen when the user opened it: if the record is
 *    replaced underneath (a refresh, another window's deploy, a re-target),
 *    the open confirmation is dropped rather than re-aimed, and a response for
 *    the previous target is discarded instead of overwriting the newer one.
 *
 * Stop and delete are both two-step: the destructive button appears only after
 * the warning naming what is lost has been shown.
 */

import type { JSX } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  CLOUDFLARE_SANDBOX_CHANNELS,
  type CloudflareSandboxError,
  type SandboxDeployment,
  type SandboxDeploymentTarget,
} from '../../../../shared/cloudflareSandbox';
import { invokeSandbox } from './CloudflareSandboxClient';
import { CloudflareSandboxNodePanel } from './CloudflareSandboxNodePanel';

type LifecycleOperation = 'none' | 'waking' | 'stopping' | 'deleting';
type ConfirmKind = 'stop' | 'delete';

interface CloudflareSandboxStatusCardProps {
  deployment: SandboxDeployment;
  /** Receives the updated record, or null once the deployment is deleted. */
  onDeploymentChange: (deployment: SandboxDeployment | null) => void;
  onRefresh: () => void;
}

const DEPLOYMENT_STATUS_LABEL: Record<SandboxDeployment['status'], string> = {
  'not-deployed': 'Not deployed',
  deploying: 'Deploying…',
  deployed: 'Deployed',
  error: 'Deployment failed',
  deleting: 'Deleting…',
};

const CONTAINER_STATUS_LABEL: Record<SandboxDeployment['container']['status'], string> = {
  unknown: 'Not observed yet',
  stopped: 'Stopped',
  starting: 'Starting…',
  running: 'Running',
  stopping: 'Stopping…',
};

const buttonClass =
  'px-3 py-1.5 text-[13px] rounded-md border border-[var(--nim-border)] bg-[var(--nim-bg)] text-[var(--nim-text)] hover:border-[var(--nim-primary)] disabled:opacity-50 disabled:cursor-not-allowed transition-colors';
const dangerButtonClass =
  'px-3 py-1.5 text-[13px] rounded-md border border-[var(--nim-error)] bg-[var(--nim-bg)] text-[var(--nim-error)] hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed transition-opacity';

function targetOf(deployment: SandboxDeployment): SandboxDeploymentTarget {
  return {
    deploymentId: deployment.deploymentId,
    revision: deployment.revision,
    profileName: deployment.profileName,
    accountId: deployment.account.id,
  };
}

/** Identity of the thing a confirmation or an in-flight request was aimed at. */
function targetKeyOf(target: SandboxDeploymentTarget): string {
  return [target.deploymentId, target.revision, target.profileName, target.accountId].join('');
}

export function CloudflareSandboxStatusCard({
  deployment,
  onDeploymentChange,
  onRefresh,
}: CloudflareSandboxStatusCardProps): JSX.Element {
  const [operation, setOperation] = useState<LifecycleOperation>('none');
  const [confirming, setConfirming] = useState<ConfirmKind | null>(null);
  const [error, setError] = useState<CloudflareSandboxError | null>(null);

  const target = targetOf(deployment);
  const targetKey = targetKeyOf(target);

  // The deployment prop can be replaced mid-confirmation by a refresh or by
  // another window's write. Consent given for the old record is not consent
  // for the new one, so reset during render — before the confirm dialog and
  // its destructive button paint against a target the user never saw.
  const [seenTargetKey, setSeenTargetKey] = useState(targetKey);
  if (seenTargetKey !== targetKey) {
    setSeenTargetKey(targetKey);
    setConfirming(null);
    setOperation('none');
    setError(null);
  }

  // Read by async continuations, which close over a stale `targetKey`.
  const currentTargetKey = useRef(targetKey);
  currentTargetKey.current = targetKey;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const run = useCallback(
    async (
      channel: string,
      payload: SandboxDeploymentTarget & Record<string, unknown>,
      pending: Exclude<LifecycleOperation, 'none'>,
    ) => {
      if (operation !== 'none') return;
      const requestedKey = targetKeyOf(payload);
      // Refuse to fire against anything but what is on screen right now.
      if (!mounted.current || requestedKey !== currentTargetKey.current) return;

      setOperation(pending);
      setError(null);
      const response = await invokeSandbox<SandboxDeployment | null>(channel, payload);

      // While this was in flight the card may have been pointed at a different
      // deployment. Applying this result would overwrite the newer record with
      // an answer about the older one.
      if (!mounted.current || requestedKey !== currentTargetKey.current) return;

      setOperation('none');
      setConfirming(null);
      if (response.success) onDeploymentChange(response.data);
      else setError(response.error);
    },
    [operation, onDeploymentChange],
  );

  const containerStatus = deployment.container.status;
  const canWake = deployment.status === 'deployed'
    && containerStatus !== 'running'
    && containerStatus !== 'starting'
    && operation === 'none';
  const canStop = deployment.status === 'deployed'
    && (containerStatus === 'running' || containerStatus === 'starting')
    && operation === 'none';
  const confirmingStop = confirming === 'stop';
  const confirmingDelete = confirming === 'delete';

  return (
    <section className="cloudflare-sandbox-status-card py-4" data-testid="cloudflare-status-section">
      <h4 className="text-[13px] font-semibold text-[var(--nim-text)] mb-2">Deployed sandbox</h4>

      <dl className="flex flex-col gap-1.5 text-[13px]">
        <div className="flex gap-2">
          <dt className="text-[var(--nim-text-muted)] min-w-[92px]">Deployment</dt>
          <dd className="text-[var(--nim-text)]" data-testid="cloudflare-deployment-status">
            {DEPLOYMENT_STATUS_LABEL[deployment.status]} — {deployment.account.name} (profile{' '}
            {deployment.profileName})
          </dd>
        </div>
        <div className="flex gap-2">
          <dt className="text-[var(--nim-text-muted)] min-w-[92px]">Container</dt>
          <dd className="text-[var(--nim-text)]" data-testid="cloudflare-container-status">
            {CONTAINER_STATUS_LABEL[containerStatus]}
            {deployment.container.observedAt && (
              <span className="text-[var(--nim-text-muted)]">
                {' '}as of {new Date(deployment.container.observedAt).toLocaleTimeString()}
              </span>
            )}
          </dd>
        </div>
        <div className="flex gap-2">
          <dt className="text-[var(--nim-text-muted)] min-w-[92px]">Access</dt>
          <dd className="text-[var(--nim-text)] break-all" data-testid="cloudflare-access">
            {deployment.access === 'public-url' && deployment.url
              ? deployment.url
              : 'Private — reached over a Worker binding, with no public endpoint.'}
          </dd>
        </div>
      </dl>

      {deployment.container.message && (
        <p className="text-[12px] text-[var(--nim-text-muted)] mt-2">{deployment.container.message}</p>
      )}
      {deployment.errorMessage && (
        <p className="text-[12px] text-[var(--nim-error)] mt-2">{deployment.errorMessage}</p>
      )}

      <div className="flex flex-wrap items-center gap-2 mt-3">
        <button className={buttonClass} onClick={onRefresh} data-testid="cloudflare-refresh-status">
          Refresh
        </button>
        <button
          className={buttonClass}
          disabled={!canWake}
          onClick={() => void run(CLOUDFLARE_SANDBOX_CHANNELS.wake, { ...target }, 'waking')}
          data-testid="cloudflare-wake"
        >
          {operation === 'waking' ? 'Waking…' : 'Wake sandbox'}
        </button>
        <button
          className={buttonClass}
          disabled={!canStop || confirmingStop}
          onClick={() => setConfirming('stop')}
          data-testid="cloudflare-stop"
        >
          Stop sandbox
        </button>
        <button
          className={dangerButtonClass}
          disabled={operation !== 'none' || confirmingDelete}
          onClick={() => setConfirming('delete')}
          data-testid="cloudflare-delete-deployment"
        >
          Delete sandbox
        </button>
      </div>

      {confirmingStop && (
        <div
          className="mt-3 p-3 rounded-lg border border-[var(--nim-border)] bg-[var(--nim-bg-secondary)]"
          data-testid="cloudflare-stop-confirm"
        >
          <p className="text-[13px] text-[var(--nim-text)]">
            Stopping the container ends every process running in it and discards files written
            inside it. Nothing in the sandbox is kept.
          </p>
          <div className="flex items-center gap-2 mt-3">
            <button
              className={buttonClass}
              disabled={operation !== 'none'}
              onClick={() => void run(
                CLOUDFLARE_SANDBOX_CHANNELS.stop,
                { ...target, discardEphemeralData: true },
                'stopping',
              )}
              data-testid="cloudflare-stop-confirmed"
            >
              {operation === 'stopping' ? 'Stopping…' : 'Stop and discard'}
            </button>
            <button className={buttonClass} onClick={() => setConfirming(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {confirmingDelete && (
        <div
          className="mt-3 p-3 rounded-lg border border-[var(--nim-error)] bg-[var(--nim-bg-secondary)]"
          data-testid="cloudflare-delete-confirm"
        >
          <p className="text-[13px] text-[var(--nim-text)]">
            Delete this sandbox from <strong>{deployment.account.name}</strong> using profile{' '}
            <strong>{deployment.profileName}</strong>? The deployed Worker and its container are
            removed, along with anything inside the container.
          </p>
          <div className="flex items-center gap-2 mt-3">
            <button
              className={dangerButtonClass}
              disabled={operation !== 'none'}
              onClick={() => void run(
                CLOUDFLARE_SANDBOX_CHANNELS.deleteDeployment,
                { ...target, confirmed: true },
                'deleting',
              )}
              data-testid="cloudflare-delete-confirmed"
            >
              {operation === 'deleting' ? 'Deleting…' : `Delete from ${deployment.account.name}`}
            </button>
            <button className={buttonClass} onClick={() => setConfirming(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {error && (
        <p className="text-[12px] text-[var(--nim-error)] mt-2" role="alert">
          {error.message}
        </p>
      )}

      {deployment.status === 'deployed' && (
        <CloudflareSandboxNodePanel
          deployment={deployment}
          onDeploymentChange={onDeploymentChange}
        />
      )}
    </section>
  );
}
