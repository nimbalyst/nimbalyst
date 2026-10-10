/**
 * Host-side services that reach backend modules through the privileged host
 * without living in it: owned-session settle delivery (`sessions.onSettled`)
 * and backend-set panel gutter badges. `PrivilegedExtensionHost` calls
 * `installExtensionHostWiring` once from its constructor.
 */
import type { ExtensionPermissionId, OwnedSessionSettledEvent } from '@nimbalyst/extension-sdk';
import { logger } from '../utils/logger';
import { sameWorkspaceIdentity } from '../utils/workspaceIdentity';
import { setOwnedSessionEventSink } from '../services/extensionSessions/extensionSessionsService';
import { SESSIONS_SETTLED_EVENT, type HostToBackendMessage } from './extensionBackendRpc';
import {
  clearBackendPanelGutterBadgesForModule,
  registerBackendPanelBadgeHandlers,
} from './backendPanelBadges';

/** The slice of the host's managed-module record these services read. */
export interface LiveBackendModule {
  args: { extensionId: string; workspacePath: string; module: { id: string } };
  state: { status: string };
  grantedPermissions: readonly ExtensionPermissionId[];
  runtime?: { send: (msg: HostToBackendMessage) => void };
}

export interface ExtensionHostWiringDeps {
  listModules: () => Iterable<LiveBackendModule>;
  onStateChanged: (
    listener: (handle: { extensionId: string; moduleId: string; workspacePath: string; state: { status: string } }) => void
  ) => void;
}

const TERMINAL_STATES = new Set(['stopped', 'crashed', 'denied']);

export function installExtensionHostWiring(deps: ExtensionHostWiringDeps): void {
  /**
   * Live modules holding `ai-sessions`: the only recipients of settle events.
   * `starting` counts: the bootstrap acks init only after activate() returns,
   * and an activate that subscribes and starts a session must not miss a fast
   * settle while it is still initializing.
   */
  const sessionListeners = (): LiveBackendModule[] =>
    Array.from(deps.listModules()).filter(
      (m) =>
        (m.state.status === 'running' || m.state.status === 'starting') &&
        m.runtime &&
        m.grantedPermissions.includes('ai-sessions')
    );

  setOwnedSessionEventSink({
    hasListeners: () => sessionListeners().length > 0,
    // Deliver an owned session's settle to its owning extension's modules in that workspace.
    emit: (extensionId: string, workspacePath: string, event: OwnedSessionSettledEvent) => {
      for (const m of sessionListeners()) {
        if (m.args.extensionId !== extensionId) continue;
        if (!sameWorkspaceIdentity(m.args.workspacePath, workspacePath)) continue;
        try {
          m.runtime!.send({ kind: 'broker-event', event: SESSIONS_SETTLED_EVENT, payload: event });
        } catch (err) {
          logger.main.warn(
            `[PrivilegedExtensionHost] settle delivery to ${extensionId}/${m.args.module.id} failed:`,
            err
          );
        }
      }
    },
  });

  registerBackendPanelBadgeHandlers();
  // A module that is gone can no longer keep its badge current.
  deps.onStateChanged((handle) => {
    if (TERMINAL_STATES.has(handle.state.status)) {
      clearBackendPanelGutterBadgesForModule(handle.extensionId, handle.moduleId, handle.workspacePath);
    }
  });
}
