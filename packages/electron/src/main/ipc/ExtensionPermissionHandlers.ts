/**
 * IPC handlers for the extension privileged-capability consent surface.
 *
 * Two channel families:
 *
 *   ext-permissions:*  - the renderer reads/writes grant rows and asks the
 *                        host to start/stop modules. Pure request/response.
 *
 *   ext-permission-prompt:*  - the bridge between the main-process
 *                              PermissionPromptResolver and the renderer
 *                              modal. Main raises a prompt event; renderer
 *                              responds; main resolves the awaiting promise.
 *
 * The IPC layer is the only thing in Phase 4 that talks to the privileged
 * host directly. The renderer should never load `PrivilegedExtensionHost`.
 */

import { BrowserWindow } from 'electron';
import type { ExtensionPermissionId } from '@nimbalyst/extension-sdk';
import { safeHandle, safeOn } from '../utils/ipcRegistry';
import { logger } from '../utils/logger';
import {
  grantModulePermissions,
  revokeModule,
  listEffectiveGrants,
  listGrantsAtScope,
  listEnabledModules,
  isModuleEnabled,
  clearAllGrantsForExtension,
} from '../extensions/permissionGrantStore';
import { listPermissionDescriptors } from '../extensions/permissionRegistry';
import {
  setPermissionPromptResolver,
  type PermissionPromptRequest,
  type PermissionPromptResolution,
} from '../extensions/permissionPrompt';
import {
  getPrivilegedExtensionHost,
  type ModuleHandle,
} from '../extensions/PrivilegedExtensionHost';
import { getPermissionUsageTracker } from '../extensions/permissionUsageTracker';
import { windowStates, resolveActiveWorkspacePath } from '../window/windowState';

interface PendingPrompt {
  request: PermissionPromptRequest;
  resolve: (resolution: PermissionPromptResolution) => void;
  // Track which window the prompt was sent to so a resolution from a
  // different window's workspace is rejected and a late-mounted window
  // belonging to the right workspace can backfill.
  targetWindowIds: number[];
}

const pending = new Map<string, PendingPrompt>();

/**
 * The workspace this window is currently bound to. Used to scope prompt
 * broadcasts and validate prompt resolutions. A window with no workspace
 * (welcome/document-only) is treated as not-matching any workspace path.
 */
function windowWorkspacePath(windowId: number): string | null {
  return resolveActiveWorkspacePath(windowStates.get(windowId));
}

/**
 * Send `payload` to every window whose active workspace matches `workspacePath`.
 * Returns the recipient window IDs so the caller can later validate that a
 * resolve message came from one of them.
 */
function sendToWorkspaceWindows(
  channel: string,
  workspacePath: string,
  payload: unknown
): number[] {
  const ids: number[] = [];
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    if (windowWorkspacePath(win.id) !== workspacePath) continue;
    win.webContents.send(channel, payload);
    ids.push(win.id);
  }
  return ids;
}

function broadcastStateChange(handle: ModuleHandle): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    win.webContents.send('ext-permissions:state-changed', handle);
  }
}

let hostListenerInstalled = false;

function ensureHostListener(): void {
  if (hostListenerInstalled) return;
  hostListenerInstalled = true;
  getPrivilegedExtensionHost().onStateChanged(broadcastStateChange);
}

export function registerExtensionPermissionHandlers(): void {
  ensureHostListener();

  // -------------------------------------------------------------------
  // Renderer-driven grant / revoke / inspection
  // -------------------------------------------------------------------

  safeHandle('ext-permissions:list-descriptors', () => {
    return listPermissionDescriptors();
  });

  safeHandle(
    'ext-permissions:list-effective',
    (_event, workspacePath?: string) => {
      return listEffectiveGrants(workspacePath);
    }
  );

  safeHandle(
    'ext-permissions:list-at-scope',
    (_event, scope: 'workspace' | 'global', workspacePath?: string) => {
      return listGrantsAtScope(scope, workspacePath);
    }
  );

  safeHandle(
    'ext-permissions:list-enabled-modules',
    (_event, workspacePath?: string) => {
      return listEnabledModules(workspacePath);
    }
  );

  safeHandle(
    'ext-permissions:is-module-enabled',
    (
      _event,
      args: {
        extensionId: string;
        moduleId: string;
        declaredPermissions: ExtensionPermissionId[];
        workspacePath?: string;
      }
    ) => {
      return isModuleEnabled(args);
    }
  );

  // Grant a module's permissions at the requested scope. Called by the
  // first-use prompt's "Enable for this workspace" / "Enable for all
  // workspaces" buttons (after the user has clicked).
  safeHandle(
    'ext-permissions:grant-module',
    (
      _event,
      args: {
        extensionId: string;
        moduleId: string;
        permissions: ExtensionPermissionId[];
        scope: 'workspace' | 'global';
        workspacePath?: string;
      }
    ) => {
      const written = grantModulePermissions(args);
      return { success: true, grants: written };
    }
  );

  // Revoke a module's grants at the given scope. Tears down the running
  // module as a side effect - revocation must be immediate.
  //
  //   workspace scope -> stop only that one module in that one workspace
  //                      (sibling modules of the same extension are unaffected)
  //   global scope    -> stop that one module across every workspace where
  //                      it is currently running; the next start will
  //                      re-evaluate the policy against the surviving rows
  safeHandle(
    'ext-permissions:revoke-module',
    async (
      _event,
      args: {
        extensionId: string;
        moduleId: string;
        scope: 'workspace' | 'global';
        workspacePath: string;
      }
    ) => {
      const removed = revokeModule(args);
      const host = getPrivilegedExtensionHost();
      if (args.scope === 'global') {
        await host.revokeAndStopModuleEverywhere(args.extensionId, args.moduleId);
      } else {
        await host.revokeAndStopModule(
          args.extensionId,
          args.moduleId,
          args.workspacePath
        );
      }
      return { success: true, removedRows: removed };
    }
  );

  // Used by the extension uninstall flow. Stops running modules and clears
  // grants. Workspace is required so the workspace-scope rows can be
  // wiped for this project; other workspaces' rows are inert (extension
  // missing on disk) and will be ignored.
  safeHandle(
    'ext-permissions:handle-uninstall',
    async (
      _event,
      args: { extensionId: string; workspacePath?: string }
    ) => {
      const host = getPrivilegedExtensionHost();
      await host.handleExtensionUninstalled(args.extensionId, args.workspacePath);
      clearAllGrantsForExtension(args);
      return { success: true };
    }
  );

  // -------------------------------------------------------------------
  // Host state / usage telemetry
  // -------------------------------------------------------------------

  safeHandle('ext-permissions:list-host-state', () => {
    return getPrivilegedExtensionHost().list();
  });

  safeHandle('ext-permissions:usage-summary', () => {
    return getPermissionUsageTracker().summarize();
  });

  safeHandle(
    'ext-permissions:usage-events-for-module',
    (_event, args: { extensionId: string; moduleId: string }) => {
      return getPermissionUsageTracker().listForModule(
        args.extensionId,
        args.moduleId
      );
    }
  );

  safeHandle('ext-permissions:usage-events-all', () => {
    return getPermissionUsageTracker().listAll();
  });

  // -------------------------------------------------------------------
  // Prompt bridge
  // -------------------------------------------------------------------

  // The host resolver: when raised, send the prompt only to windows whose
  // active workspace matches the request's workspacePath, and wait for one
  // of them to respond. This is what stops workspace B from silently
  // approving a privileged grant for workspace A.
  //
  // If no matching window is open when the prompt is raised, we keep the
  // request pending: a window bound to that workspace may open later and
  // backfill via `ext-permission-prompt:list-pending`. Modules stuck in
  // `awaiting-consent` are acceptable because the user can re-trigger by
  // re-opening the action that needed the capability.
  setPermissionPromptResolver(async (request) => {
    return new Promise<PermissionPromptResolution>((resolve) => {
      const targetWindowIds = sendToWorkspaceWindows(
        'ext-permission-prompt:raise',
        request.workspacePath,
        request
      );
      pending.set(request.id, { request, resolve, targetWindowIds });
      if (targetWindowIds.length === 0) {
        logger.main.info(
          `[ExtensionPermissionHandlers] No window currently bound to workspace ${request.workspacePath} for prompt ${request.id}; awaiting a matching window`
        );
      }
    });
  });

  safeOn('ext-permission-prompt:resolve', (event, args: {
    promptId: string;
    resolution: PermissionPromptResolution;
  }) => {
    const entry = pending.get(args.promptId);
    if (!entry) {
      // Already resolved by another window or never raised. Safe to ignore.
      return;
    }
    // Sender validation: only a window whose active workspace matches the
    // prompt's workspacePath may resolve it. This prevents a multi-window
    // setup where workspace B's renderer fires a resolve for workspace A's
    // prompt (the prompt request was carrying workspace A's workspacePath
    // all along; we must not trust the sender's claim of who they are).
    const senderWindowId = event.sender ? BrowserWindow.fromWebContents(event.sender)?.id ?? null : null;
    if (senderWindowId === null) {
      logger.main.warn(
        `[ExtensionPermissionHandlers] Dropping prompt resolve ${args.promptId}: no sender window`
      );
      return;
    }
    if (windowWorkspacePath(senderWindowId) !== entry.request.workspacePath) {
      logger.main.warn(
        `[ExtensionPermissionHandlers] Dropping prompt resolve ${args.promptId} from window ${senderWindowId}: workspace mismatch`
      );
      return;
    }
    pending.delete(args.promptId);
    entry.resolve(args.resolution);
    // Notify the windows the prompt was targeted at so they can close their
    // modal. Workspace-scoped: other-workspace windows never saw it.
    sendToWorkspaceWindows(
      'ext-permission-prompt:resolved',
      entry.request.workspacePath,
      { promptId: args.promptId }
    );
  });

  // Renderer asks: "are there any prompts still pending for me?" - used on
  // window mount so a late-opened window can render a prompt that was
  // raised before it existed. Scoped to the caller's workspace so a window
  // bound to workspace B cannot enumerate (let alone approve) workspace A's
  // pending prompts.
  safeHandle('ext-permission-prompt:list-pending', (event) => {
    const senderWindowId = event.sender ? BrowserWindow.fromWebContents(event.sender)?.id ?? null : null;
    if (senderWindowId === null) return [];
    const callerWorkspace = windowWorkspacePath(senderWindowId);
    if (!callerWorkspace) return [];
    return Array.from(pending.values())
      .filter((p) => p.request.workspacePath === callerWorkspace)
      .map((p) => p.request);
  });

  logger.main.info('[ExtensionPermissionHandlers] Handlers registered');
}
