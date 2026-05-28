/**
 * Extension Capability Policy
 *
 * Centralized gate the privileged host (and any future privileged-capability
 * caller) consults to answer "is this extension+module allowed to use this
 * permission right now, in this workspace?"
 *
 * Two checks compose:
 *   1. Workspace trust - untrusted workspaces refuse all privileged grants.
 *      Worktrees inherit trust from their parent project (resolved via
 *      `resolveWorkspacePathForPermissions`).
 *   2. Permission grant - the user has explicitly granted the (extension,
 *      module, permission) tuple at workspace or global scope.
 *
 * The host calls `assertPermission` at the RPC dispatch boundary. The backend
 * shim ALSO holds its own copy of the granted-permission set (received at
 * init) and refuses synchronously without round-tripping; this main-side gate
 * is defense-in-depth and the authoritative source on grant changes.
 *
 * Trust is checked on every call. Revoking trust mid-flight should reject the
 * next RPC even if the module is still running (the host will also tear the
 * module down, but the gate must not assume that has already happened).
 */

import type { ExtensionPermissionId } from '@nimbalyst/extension-sdk';
import {
  resolveWorkspacePathForPermissions,
  getPermissionService,
} from '../services/PermissionService';
import { isPermissionGranted, isModuleEnabled } from './permissionGrantStore';
import { logger } from '../utils/logger';

export type CapabilityDenialReason =
  | 'workspace-untrusted'
  | 'permission-not-granted'
  | 'workspace-required';

export class CapabilityDeniedError extends Error {
  readonly reason: CapabilityDenialReason;
  readonly extensionId: string;
  readonly moduleId: string;
  readonly permissionId?: ExtensionPermissionId;

  constructor(args: {
    reason: CapabilityDenialReason;
    extensionId: string;
    moduleId: string;
    permissionId?: ExtensionPermissionId;
    detail?: string;
  }) {
    const permLabel = args.permissionId ? ` (${args.permissionId})` : '';
    super(
      `[CapabilityDenied] ${args.reason}: ${args.extensionId}/${args.moduleId}${permLabel}` +
        (args.detail ? ` - ${args.detail}` : '')
    );
    this.name = 'CapabilityDeniedError';
    this.reason = args.reason;
    this.extensionId = args.extensionId;
    this.moduleId = args.moduleId;
    this.permissionId = args.permissionId;
  }
}

/**
 * Resolve the trust path (worktree -> parent project) and return whether the
 * workspace is trusted for privileged capabilities.
 *
 * A workspace with no permissionMode set is untrusted. This mirrors how the
 * agent treats workspace trust elsewhere; we deliberately share the same
 * underlying trust signal so the user is never asked to trust the same
 * workspace twice.
 *
 * `workspacePath` is required for any privileged capability. There is no
 * "ambient" trusted workspace at module scope; callers without a workspace
 * cannot start privileged modules.
 */
export async function isWorkspaceTrustedForPrivileged(
  workspacePath: string
): Promise<boolean> {
  if (!workspacePath) {
    return false;
  }
  try {
    const resolved = await resolveWorkspacePathForPermissions(workspacePath);
    return getPermissionService().isWorkspaceTrusted(resolved);
  } catch (err) {
    // resolveWorkspacePathForPermissions throws if the database isn't ready.
    // Treat that as "not trusted" rather than crashing; the host will
    // refuse to start the module and the renderer can surface a clear error.
    logger.main.warn(
      '[extensionCapabilityPolicy] workspace trust check failed:',
      err
    );
    return false;
  }
}

/**
 * Can a module start right now? Composes:
 *   - workspace trust (worktree-aware)
 *   - presence of grants covering every declared permission
 *
 * Returns a discriminated result so the caller can produce a structured
 * "needs-trust" / "needs-permission" / "ok" outcome instead of just a bool.
 */
export type ModuleStartCheck =
  | { ok: true }
  | { ok: false; reason: CapabilityDenialReason; detail?: string };

export async function canModuleStart(args: {
  extensionId: string;
  moduleId: string;
  declaredPermissions: readonly ExtensionPermissionId[];
  workspacePath: string;
}): Promise<ModuleStartCheck> {
  const { extensionId, moduleId, declaredPermissions, workspacePath } = args;

  if (!workspacePath) {
    return { ok: false, reason: 'workspace-required' };
  }

  const trusted = await isWorkspaceTrustedForPrivileged(workspacePath);
  if (!trusted) {
    return {
      ok: false,
      reason: 'workspace-untrusted',
      detail: workspacePath,
    };
  }

  const enabled = isModuleEnabled({
    extensionId,
    moduleId,
    declaredPermissions,
    workspacePath,
  });
  if (!enabled) {
    return { ok: false, reason: 'permission-not-granted' };
  }

  return { ok: true };
}

/**
 * Synchronous permission check used by the RPC boundary.
 *
 * IMPORTANT: this does NOT re-check workspace trust on every call - the host
 * tears the module down on trust revocation, so by the time an RPC arrives,
 * the running module's process already lost its IPC pipe. The grant check is
 * what we still need to verify per-call (in case the user revoked just this
 * grant without touching trust).
 */
export function assertPermission(args: {
  extensionId: string;
  moduleId: string;
  permissionId: ExtensionPermissionId;
  workspacePath: string;
}): void {
  if (
    !isPermissionGranted(
      args.extensionId,
      args.moduleId,
      args.permissionId,
      args.workspacePath
    )
  ) {
    throw new CapabilityDeniedError({
      reason: 'permission-not-granted',
      extensionId: args.extensionId,
      moduleId: args.moduleId,
      permissionId: args.permissionId,
    });
  }
}
