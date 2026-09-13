/**
 * Running a Nimbalyst agent inside the deployed sandbox.
 *
 * Three facts this panel keeps separate, because conflating any two of them
 * produces a screen that lies:
 *
 *   1. The deployment exists (the Worker is in the account).
 *   2. The container is warm.
 *   3. A `nimbalyst-node` process is running inside it and joined to sync.
 *
 * The container sleeps when idle and discards everything written into it, so
 * (3) routinely stops being true while (1) and (2) still are. "Connect node" is
 * therefore a full provisioning run every time, not a one-off setup step, and
 * the copy says so rather than presenting connection as permanent.
 *
 * Placement on the Settings card is provisional, for testing this end to end.
 * It is deliberately not wired into any navigation surface.
 */

import type { JSX } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useAtomValue } from 'jotai';
import {
  CLOUDFLARE_SANDBOX_CHANNELS,
  type CloudflareSandboxError,
  type SandboxDeployment,
  type SandboxDeploymentTarget,
  type StartRemoteSessionResult,
} from '../../../../shared/cloudflareSandbox';
import { activeWorkspacePathAtom } from '../../../store/atoms/openProjects';
import { invokeSandbox } from './CloudflareSandboxClient';

type NodeOperation = 'none' | 'connecting' | 'refreshing' | 'disconnecting' | 'starting-session';

interface CloudflareSandboxNodePanelProps {
  deployment: SandboxDeployment;
  onDeploymentChange: (deployment: SandboxDeployment | null) => void;
}

const buttonClass =
  'px-3 py-1.5 text-[13px] rounded-md border border-[var(--nim-border)] bg-[var(--nim-bg)] text-[var(--nim-text)] hover:border-[var(--nim-primary)] disabled:opacity-50 disabled:cursor-not-allowed transition-colors';
const primaryButtonClass =
  'px-3 py-1.5 text-[13px] rounded-md bg-[var(--nim-primary)] text-white hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed transition-opacity';
const hintClass = 'text-[12px] leading-relaxed text-[var(--nim-text-muted)]';

function targetOf(deployment: SandboxDeployment): SandboxDeploymentTarget {
  return {
    deploymentId: deployment.deploymentId,
    revision: deployment.revision,
    profileName: deployment.profileName,
    accountId: deployment.account.id,
  };
}

function targetKeyOf(target: SandboxDeploymentTarget): string {
  return [target.deploymentId, target.revision, target.profileName, target.accountId].join('\x00');
}

/** What the node is doing, in the terms the user can act on. */
function describeNode(deployment: SandboxDeployment): string {
  const node = deployment.node;
  if (!node) return 'Not connected';
  if (node.running) {
    return node.startedAt
      ? `Running since ${new Date(node.startedAt).toLocaleTimeString()}`
      : 'Running';
  }
  if (node.exitCode !== null) return `Stopped, exit code ${node.exitCode}`;
  return 'Stopped';
}

export function CloudflareSandboxNodePanel({
  deployment,
  onDeploymentChange,
}: CloudflareSandboxNodePanelProps): JSX.Element {
  const workspacePath = useAtomValue(activeWorkspacePathAtom);
  const [operation, setOperation] = useState<NodeOperation>('none');
  const [confirmingDisconnect, setConfirmingDisconnect] = useState(false);
  const [error, setError] = useState<CloudflareSandboxError | null>(null);
  const [prompt, setPrompt] = useState('');
  const [startedSessionId, setStartedSessionId] = useState<string | null>(null);

  const target = targetOf(deployment);
  const targetKey = targetKeyOf(target);

  // Same reasoning as the lifecycle card: consent and in-flight state belong to
  // the exact record they were rendered from, so a replaced deployment drops
  // both rather than having them re-aimed at something the user never saw.
  const [seenTargetKey, setSeenTargetKey] = useState(targetKey);
  if (seenTargetKey !== targetKey) {
    setSeenTargetKey(targetKey);
    setConfirmingDisconnect(false);
    setOperation('none');
    setError(null);
  }

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
      pending: Exclude<NodeOperation, 'none'>,
    ) => {
      if (operation !== 'none') return;
      const requestedKey = targetKeyOf(payload);
      if (!mounted.current || requestedKey !== currentTargetKey.current) return;

      setOperation(pending);
      setError(null);
      const response = await invokeSandbox<SandboxDeployment>(channel, payload);
      if (!mounted.current || requestedKey !== currentTargetKey.current) return;

      setOperation('none');
      setConfirmingDisconnect(false);
      if (response.success) onDeploymentChange(response.data);
      else setError(response.error);
    },
    [operation, onDeploymentChange],
  );

  const startSession = useCallback(async () => {
    if (operation !== 'none' || !workspacePath) return;
    const requestedKey = currentTargetKey.current;
    setOperation('starting-session');
    setError(null);
    setStartedSessionId(null);

    const response = await invokeSandbox<StartRemoteSessionResult>(
      CLOUDFLARE_SANDBOX_CHANNELS.startRemoteSession,
      { ...target, workspacePath, prompt },
    );
    if (!mounted.current || requestedKey !== currentTargetKey.current) return;

    setOperation('none');
    if (response.success) {
      setStartedSessionId(response.data.sessionId);
      setPrompt('');
    } else {
      setError(response.error);
    }
  }, [operation, workspacePath, target, prompt]);

  const node = deployment.node;
  const busy = operation !== 'none';
  const nodeRunning = node?.running === true;

  return (
    <section className="cloudflare-sandbox-node-panel pt-4 mt-4 border-t border-[var(--nim-border)]" data-testid="cloudflare-node-section">
      <h4 className="text-[13px] font-semibold text-[var(--nim-text)] mb-1">Agent node</h4>
      <p className={hintClass}>
        Connecting installs a Nimbalyst agent in the sandbox and signs it in as one of your devices.
        Your Claude Code subscription login is copied into the sandbox so the agent can use it. The
        sandbox discards everything inside it whenever it sleeps, so anything the agent has not
        pushed to git is lost and the node has to be connected again.
      </p>

      <dl className="flex flex-col gap-1.5 text-[13px] mt-3">
        <div className="flex gap-2">
          <dt className="text-[var(--nim-text-muted)] min-w-[92px]">Node</dt>
          <dd className="text-[var(--nim-text)]" data-testid="cloudflare-node-status">
            {describeNode(deployment)}
          </dd>
        </div>
        {node?.workspace && (
          <div className="flex gap-2">
            <dt className="text-[var(--nim-text-muted)] min-w-[92px]">Working in</dt>
            <dd className="text-[var(--nim-text)] break-all" data-testid="cloudflare-node-workspace">
              {node.workspace.projectId} on branch {node.workspace.branch}
            </dd>
          </div>
        )}
      </dl>

      {node?.recentLog && (
        <pre
          className="mt-2 p-2 max-h-40 overflow-auto text-[11px] leading-snug rounded-md border border-[var(--nim-border)] bg-[var(--nim-bg-secondary)] text-[var(--nim-text-muted)] whitespace-pre-wrap select-text"
          data-testid="cloudflare-node-log"
        >
          {node.recentLog}
        </pre>
      )}

      <div className="flex flex-wrap items-center gap-2 mt-3">
        <button
          className={buttonClass}
          disabled={busy || nodeRunning || !workspacePath}
          onClick={() => void run(
            CLOUDFLARE_SANDBOX_CHANNELS.connectNode,
            { ...target, workspacePath: workspacePath ?? '' },
            'connecting',
          )}
          data-testid="cloudflare-connect-node"
        >
          {operation === 'connecting' ? 'Connecting…' : 'Connect node'}
        </button>
        {node && (
          <button
            className={buttonClass}
            disabled={busy}
            onClick={() => void run(CLOUDFLARE_SANDBOX_CHANNELS.nodeStatus, { ...target }, 'refreshing')}
            data-testid="cloudflare-node-refresh"
          >
            {operation === 'refreshing' ? 'Checking…' : 'Check node'}
          </button>
        )}
        {node && (
          <button
            className={buttonClass}
            disabled={busy || confirmingDisconnect}
            onClick={() => setConfirmingDisconnect(true)}
            data-testid="cloudflare-disconnect-node"
          >
            Disconnect node
          </button>
        )}
      </div>

      {!workspacePath && (
        <p className={`${hintClass} mt-2`} data-testid="cloudflare-node-no-workspace">
          Open a workspace first. The node clones that workspace&apos;s repository and branch.
        </p>
      )}

      {confirmingDisconnect && (
        <div
          className="mt-3 p-3 rounded-lg border border-[var(--nim-border)] bg-[var(--nim-bg-secondary)]"
          data-testid="cloudflare-disconnect-confirm"
        >
          <p className="text-[13px] text-[var(--nim-text)]">
            Disconnecting asks the agent to stop, ending any session it is running, and revokes its
            sync credential so reconnecting issues a new one. Anything it wrote and has not pushed
            stays in the sandbox until the sandbox next sleeps, and is then lost.
          </p>
          <div className="flex items-center gap-2 mt-3">
            <button
              className={buttonClass}
              disabled={busy}
              onClick={() => void run(
                CLOUDFLARE_SANDBOX_CHANNELS.disconnectNode,
                { ...target, discardEphemeralData: true },
                'disconnecting',
              )}
              data-testid="cloudflare-disconnect-confirmed"
            >
              {operation === 'disconnecting' ? 'Disconnecting…' : 'Disconnect and discard'}
            </button>
            <button className={buttonClass} onClick={() => setConfirmingDisconnect(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {nodeRunning && (
        <div className="mt-4" data-testid="cloudflare-remote-session-form">
          <h5 className="text-[13px] font-semibold text-[var(--nim-text)] mb-1">Start a session on the sandbox</h5>
          <p className={hintClass}>
            The agent runs in the sandbox, on{' '}
            {node?.workspace ? `${node.workspace.branch} in ${node.workspace.projectId}` : 'the connected workspace'}.
            Its sessions appear in your session list, where you can follow progress and send more prompts.
          </p>
          <textarea
            className="w-full mt-2 p-2 text-[13px] rounded-md border border-[var(--nim-border)] bg-[var(--nim-bg)] text-[var(--nim-text)] select-text"
            rows={3}
            value={prompt}
            placeholder="What should the sandbox agent do?"
            onChange={(event) => setPrompt(event.target.value)}
            data-testid="cloudflare-remote-session-prompt"
          />
          <button
            className={`${primaryButtonClass} mt-2`}
            disabled={busy || prompt.trim().length === 0}
            onClick={() => void startSession()}
            data-testid="cloudflare-start-remote-session"
          >
            {operation === 'starting-session' ? 'Starting…' : 'Start remote session'}
          </button>
          {startedSessionId && (
            <p className="text-[12px] text-[var(--nim-text)] mt-2" data-testid="cloudflare-remote-session-result">
              Started session {startedSessionId} on the sandbox.
              <button className={`${buttonClass} ml-2`} data-testid="cloudflare-open-remote-session" onClick={() => {
                window.dispatchEvent(new CustomEvent('open-ai-session', { detail: { sessionId: startedSessionId, workspacePath } }));
              }}>Open session</button>
            </p>
          )}
        </div>
      )}

      {error && (
        <p className="text-[12px] text-[var(--nim-error)] mt-2" role="alert" data-testid="cloudflare-node-error">
          {error.message}
        </p>
      )}
    </section>
  );
}
