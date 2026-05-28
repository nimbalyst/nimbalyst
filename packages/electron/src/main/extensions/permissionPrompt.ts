/**
 * Permission Prompt Bridge
 *
 * The privileged host needs to *request* a first-use / re-prompt consent
 * decision from the user without owning the UI. The actual modal lives in
 * the renderer (Phase 4). This file defines:
 *
 *   - the shape of a pending prompt
 *   - a small in-process registry the host uses to enqueue requests
 *   - an interface the Phase 4 IPC layer implements to resolve them
 *
 * Decoupling lets the host write its own tests and unblocks the Phase 4
 * session: Phase 4 only has to implement `setPermissionPromptResolver` and
 * the corresponding IPC events.
 *
 * If no resolver has been registered when a prompt is raised, the prompt
 * defaults to "denied" - the host will refuse to start the module rather
 * than silently auto-approving. This matches the "user is the allow-list"
 * rule even when the UI is missing.
 */

import type { ExtensionPermissionId } from '@nimbalyst/extension-sdk';
import { logger } from '../utils/logger';

export type PermissionPromptScope = 'workspace' | 'global';

export type PermissionPromptKind =
  | { kind: 'first-use' }
  | {
      kind: 're-prompt-update';
      /** Newly declared permissions the user has never approved. */
      addedPermissions: ExtensionPermissionId[];
      /** Scopes that already have prior grants. */
      existingScopes: PermissionPromptScope[];
    };

export interface PermissionPromptRequest {
  /** Stable id the resolver echoes back on resolution. */
  id: string;
  extensionId: string;
  extensionName: string;
  moduleId: string;
  /** Verbatim, user-facing purpose string from the manifest. */
  purpose: string;
  /** All declared permissions for the module (re-prompt highlights `addedPermissions`). */
  declaredPermissions: ExtensionPermissionId[];
  /** Workspace path this prompt is bound to. */
  workspacePath: string;
  reason: PermissionPromptKind;
  raisedAt: number;
}

export type PermissionPromptResolution =
  | { decision: 'enable-workspace' }
  | { decision: 'enable-global' }
  | { decision: 'not-now' };

export type PermissionPromptResolver = (
  request: PermissionPromptRequest
) => Promise<PermissionPromptResolution>;

let resolver: PermissionPromptResolver | null = null;

/**
 * Phase 4 calls this once at startup to register the renderer-backed
 * resolver. Calling again replaces - useful for tests.
 */
export function setPermissionPromptResolver(
  next: PermissionPromptResolver | null
): void {
  resolver = next;
  logger.main.info(
    `[permissionPrompt] resolver ${next ? 'registered' : 'cleared'}`
  );
}

export function hasPermissionPromptResolver(): boolean {
  return resolver !== null;
}

/**
 * Raise a permission prompt. Returns the user's decision.
 *
 * If no resolver is registered, returns `{ decision: 'not-now' }` immediately
 * and logs a warning. The host treats that as "do not start the module" -
 * the safe default when the consent UX isn't wired up.
 */
export async function raisePermissionPrompt(
  request: PermissionPromptRequest
): Promise<PermissionPromptResolution> {
  if (!resolver) {
    logger.main.warn(
      `[permissionPrompt] No resolver registered; refusing ${request.extensionId}/${request.moduleId} (${request.reason.kind})`
    );
    return { decision: 'not-now' };
  }
  try {
    return await resolver(request);
  } catch (err) {
    logger.main.error(
      `[permissionPrompt] Resolver threw for ${request.extensionId}/${request.moduleId}; treating as not-now:`,
      err
    );
    return { decision: 'not-now' };
  }
}

let nextPromptId = 1;

export function generatePermissionPromptId(): string {
  return `perm-prompt-${Date.now()}-${nextPromptId++}`;
}
