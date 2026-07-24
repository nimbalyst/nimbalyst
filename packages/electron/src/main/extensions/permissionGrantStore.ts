/**
 * Permission Grant Store
 *
 * Persists user grants for privileged extension capabilities. Storage is split:
 *   - workspace scope -> workspace-settings (electron-store, keyed by workspace path)
 *   - global scope    -> app-settings (electron-store)
 *
 * Never localStorage. Never PGLite (these are settings-class entries; PGLite is
 * reserved for richer, queryable per-session data).
 *
 * The grant row is keyed by (extensionId, moduleId, permissionId, scope) even
 * though MVP UI grants per-module. Per-permission rows make per-permission
 * toggles a UI change later, not a data migration.
 */

import type { ExtensionPermissionId } from '@nimbalyst/extension-sdk';
import {
  type PersistedPermissionGrant,
  getWorkspaceState,
  updateWorkspaceState,
  getExtensionPermissionGrantsGlobal,
  setExtensionPermissionGrantsGlobal,
} from '../utils/store';
import { isKnownPermissionId, PERMISSION_REGISTRY_VERSION } from './permissionRegistry';
import { logger } from '../utils/logger';

export type GrantScope = 'workspace' | 'global';

/**
 * Sentinel persisted as a `permissionId` to record "the user enabled this
 * module" when the module declares no host-brokered catalog permissions.
 *
 * A backend module's primary effect is "run native code in a privileged
 * runtime" -- that capability is conferred by enabling the module itself,
 * not by a granular catalog id. Modules that only need ambient Node access
 * (spawn, fs, net) declare an empty `permissions` array, but we still need a
 * persisted record that the user granted them. The sentinel row serves that
 * purpose without adding a new top-level store key.
 *
 * The sentinel is NOT a catalog id and never appears in the consent prompt
 * or the per-permission revoke UI. `isKnownPermissionId` returns false for
 * it on purpose so `toMaterialized` filters it out of permission listings;
 * `isModuleEnabled` / `listEnabledModules` consult the raw rows directly.
 */
const MODULE_ENABLED_SENTINEL = 'module:enabled';

export interface GrantKey {
  extensionId: string;
  moduleId: string;
  permissionId: ExtensionPermissionId;
  scope: GrantScope;
  /** Required for workspace scope, ignored (and not used) for global */
  workspacePath?: string;
}

/**
 * Materialized view of a single grant, with all metadata.
 */
export interface MaterializedGrant extends GrantKey {
  grantedAt: number;
  grantedBy: 'user';
  permissionVersion: number;
}

/**
 * Inputs to grant a whole module. MVP UI grants all declared permissions at
 * once, but the store fans the request out to per-permission rows.
 */
export interface ModuleGrantRequest {
  extensionId: string;
  moduleId: string;
  permissions: ExtensionPermissionId[];
  scope: GrantScope;
  /** Required for workspace scope */
  workspacePath?: string;
}

function requireWorkspacePath(scope: GrantScope, workspacePath?: string): string {
  if (scope !== 'workspace') {
    throw new Error(
      '[permissionGrantStore] workspacePath is only valid for workspace scope'
    );
  }
  if (!workspacePath) {
    throw new Error(
      '[permissionGrantStore] workspacePath is required for workspace-scoped grants'
    );
  }
  return workspacePath;
}

function rowMatchesKey(row: PersistedPermissionGrant, key: GrantKey): boolean {
  if (row.extensionId !== key.extensionId) return false;
  if (row.moduleId !== key.moduleId) return false;
  if (row.permissionId !== key.permissionId) return false;
  if (row.scope !== key.scope) return false;
  if (key.scope === 'workspace' && row.workspacePath !== key.workspacePath) {
    return false;
  }
  return true;
}

function loadGlobalRows(): PersistedPermissionGrant[] {
  return getExtensionPermissionGrantsGlobal() ?? [];
}

function loadWorkspaceRows(workspacePath: string): PersistedPermissionGrant[] {
  const state = getWorkspaceState(workspacePath);
  return state.extensionPermissionGrants ?? [];
}

function saveGlobalRows(rows: PersistedPermissionGrant[]): void {
  setExtensionPermissionGrantsGlobal(rows);
}

function saveWorkspaceRows(
  workspacePath: string,
  rows: PersistedPermissionGrant[]
): void {
  updateWorkspaceState(workspacePath, (state) => {
    state.extensionPermissionGrants = rows;
  });
}

function toMaterialized(row: PersistedPermissionGrant): MaterializedGrant | null {
  if (!isKnownPermissionId(row.permissionId)) {
    // The catalog removed this permission since the grant was written. We
    // can't surface a row for a permission the host no longer knows about;
    // it would be inert (no RPC could use it). Silently skip - the grant
    // will be cleaned up the next time the user touches that extension.
    return null;
  }
  return {
    extensionId: row.extensionId,
    moduleId: row.moduleId,
    permissionId: row.permissionId,
    scope: row.scope,
    workspacePath: row.workspacePath,
    grantedAt: row.grantedAt,
    grantedBy: row.grantedBy,
    permissionVersion: row.permissionVersion,
  };
}

/**
 * Grant a module's permissions at the given scope. Replaces any existing
 * rows for the same (extension, module, scope) so re-grants stay idempotent.
 *
 * Returns the materialized grants that were written.
 */
export function grantModulePermissions(
  request: ModuleGrantRequest
): MaterializedGrant[] {
  const { extensionId, moduleId, permissions, scope } = request;
  for (const id of permissions) {
    if (!isKnownPermissionId(id)) {
      throw new Error(
        `[permissionGrantStore] unknown permission id: ${id} (extension ${extensionId}/${moduleId})`
      );
    }
  }

  const now = Date.now();
  // Modules that only need ambient native capabilities still need a persisted
  // record of consent. Write a sentinel row instead of throwing. Per-call
  // RPC checks consult `isKnownPermissionId` so this row never appears as a
  // grantable permission to anything but `isModuleEnabled` / `listEnabledModules`.
  const persistedPermissionIds: string[] =
    permissions.length === 0 ? [MODULE_ENABLED_SENTINEL] : (permissions as string[]);

  const newRows: PersistedPermissionGrant[] = persistedPermissionIds.map((permissionId) => ({
    extensionId,
    moduleId,
    permissionId,
    scope,
    workspacePath: scope === 'workspace' ? requireWorkspacePath(scope, request.workspacePath) : undefined,
    grantedAt: now,
    grantedBy: 'user' as const,
    permissionVersion: PERMISSION_REGISTRY_VERSION,
  }));

  if (scope === 'global') {
    const existing = loadGlobalRows().filter(
      (r) => !(r.extensionId === extensionId && r.moduleId === moduleId && r.scope === 'global')
    );
    saveGlobalRows([...existing, ...newRows]);
  } else {
    const workspacePath = requireWorkspacePath(scope, request.workspacePath);
    const existing = loadWorkspaceRows(workspacePath).filter(
      (r) => !(r.extensionId === extensionId && r.moduleId === moduleId && r.scope === 'workspace')
    );
    saveWorkspaceRows(workspacePath, [...existing, ...newRows]);
  }

  logger.main.info(
    `[permissionGrantStore] Granted ${extensionId}/${moduleId} at ${scope}` +
      (scope === 'workspace' ? ` (${request.workspacePath})` : '') +
      ` -> ${permissions.join(', ')}`
  );

  return newRows
    .map(toMaterialized)
    .filter((g): g is MaterializedGrant => g !== null);
}

/**
 * Revoke an entire module at a scope. Removes all per-permission rows for
 * that (extension, module, scope). Workspace scope requires workspacePath;
 * global scope ignores it.
 *
 * Returns the number of rows removed.
 */
export function revokeModule(args: {
  extensionId: string;
  moduleId: string;
  scope: GrantScope;
  workspacePath?: string;
}): number {
  const { extensionId, moduleId, scope } = args;
  if (scope === 'global') {
    const rows = loadGlobalRows();
    const next = rows.filter(
      (r) => !(r.extensionId === extensionId && r.moduleId === moduleId && r.scope === 'global')
    );
    saveGlobalRows(next);
    logger.main.info(
      `[permissionGrantStore] Revoked ${extensionId}/${moduleId} (global) - removed ${rows.length - next.length} rows`
    );
    return rows.length - next.length;
  }

  const workspacePath = requireWorkspacePath(scope, args.workspacePath);
  const rows = loadWorkspaceRows(workspacePath);
  const next = rows.filter(
    (r) => !(r.extensionId === extensionId && r.moduleId === moduleId && r.scope === 'workspace')
  );
  saveWorkspaceRows(workspacePath, next);
  logger.main.info(
    `[permissionGrantStore] Revoked ${extensionId}/${moduleId} (workspace ${workspacePath}) - removed ${rows.length - next.length} rows`
  );
  return rows.length - next.length;
}

/**
 * List all materialized grants visible from a given workspace context.
 *
 * Returns both workspace-scope grants for `workspacePath` AND all global-scope
 * grants. This is the set the privileged host consults when deciding whether
 * to start a module.
 *
 * `workspacePath` may be undefined when called from contexts that don't have a
 * workspace open (e.g., the global "Privileged Extensions" settings view).
 */
export function listEffectiveGrants(
  workspacePath?: string
): MaterializedGrant[] {
  const global = loadGlobalRows();
  const workspace = workspacePath ? loadWorkspaceRows(workspacePath) : [];
  return [...workspace, ...global]
    .map(toMaterialized)
    .filter((g): g is MaterializedGrant => g !== null);
}

/**
 * List grants at a specific scope. Workspace requires workspacePath.
 * Used by the per-extension Permissions settings UI to render scope-specific
 * revoke buttons.
 */
export function listGrantsAtScope(
  scope: GrantScope,
  workspacePath?: string
): MaterializedGrant[] {
  const rows = scope === 'global' ? loadGlobalRows() : loadWorkspaceRows(requireWorkspacePath(scope, workspacePath));
  return rows
    .filter((r) => r.scope === scope)
    .map(toMaterialized)
    .filter((g): g is MaterializedGrant => g !== null);
}

/**
 * Check whether a specific (extension, module, permission) combo is granted
 * in this workspace context. The privileged host calls this on every RPC
 * boundary that touches a permission-gated capability.
 *
 * A module is "enabled" for the current workspace if it has either:
 *   - a workspace-scope row for this workspacePath, OR
 *   - a global-scope row
 *
 * Workspace-scope wins for revocation: if a global grant exists but the user
 * explicitly revoked the workspace grant, the workspace context is not the
 * place to enforce that. Revocation tears down the running module entirely;
 * this check just reflects current persisted state.
 */
export function isPermissionGranted(
  extensionId: string,
  moduleId: string,
  permissionId: ExtensionPermissionId,
  workspacePath?: string
): boolean {
  const effective = listEffectiveGrants(workspacePath);
  return effective.some(
    (g) =>
      g.extensionId === extensionId &&
      g.moduleId === moduleId &&
      g.permissionId === permissionId
  );
}

/**
 * Determine whether a module has any active grant (workspace or global) that
 * lets it start in the given workspace context. A module starts iff every
 * declared permission has a matching grant - MVP UI grants are all-or-nothing
 * per module, so this is effectively a single boolean once persisted.
 */
export function isModuleEnabled(args: {
  extensionId: string;
  moduleId: string;
  declaredPermissions: readonly ExtensionPermissionId[];
  workspacePath?: string;
}): boolean {
  const { extensionId, moduleId, declaredPermissions, workspacePath } = args;

  // Consult raw rows (not materialized ones) so the sentinel row is visible.
  const globalRows = loadGlobalRows().filter(
    (r) => r.extensionId === extensionId && r.moduleId === moduleId
  );
  const workspaceRows = workspacePath
    ? loadWorkspaceRows(workspacePath).filter(
        (r) => r.extensionId === extensionId && r.moduleId === moduleId
      )
    : [];
  const allRows = [...globalRows, ...workspaceRows];

  if (allRows.length === 0) {
    return false;
  }

  // For modules with no declared brokered permissions, the sentinel row alone
  // is sufficient (and is what the grant store wrote on consent).
  if (declaredPermissions.length === 0) {
    return allRows.some((r) => r.permissionId === MODULE_ENABLED_SENTINEL);
  }

  // Otherwise every declared permission must have a matching grant row.
  const granted = new Set(allRows.map((r) => r.permissionId));
  return declaredPermissions.every((p) => granted.has(p));
}

/**
 * Diff a manifest's currently declared permissions against the user's
 * persisted grants. Drives the re-prompt / silent-shrink flow on extension
 * update:
 *
 *   added.length > 0   -> re-prompt the user before loading the backend
 *   removed.length > 0 -> silently shrink the persisted grant set
 *
 * Returns separate diffs for each scope where a grant exists. If neither
 * scope has any rows, the module is treated as never-granted (no diff).
 */
export function diffDeclaredAgainstGrants(args: {
  extensionId: string;
  moduleId: string;
  declaredPermissions: readonly ExtensionPermissionId[];
  workspacePath?: string;
}): {
  workspace?: { added: ExtensionPermissionId[]; removed: ExtensionPermissionId[] };
  global?: { added: ExtensionPermissionId[]; removed: ExtensionPermissionId[] };
} {
  const { extensionId, moduleId, declaredPermissions, workspacePath } = args;
  const declared = new Set(declaredPermissions);

  const result: ReturnType<typeof diffDeclaredAgainstGrants> = {};

  const computeDiff = (rows: PersistedPermissionGrant[], scope: GrantScope) => {
    const scopedRows = rows.filter(
      (r) =>
        r.extensionId === extensionId &&
        r.moduleId === moduleId &&
        r.scope === scope
    );
    if (scopedRows.length === 0) {
      return undefined;
    }
    // Exclude the sentinel from grant/decline diffs -- it tracks "module is
    // enabled" not "user granted permission X" and isn't surfaced in the UI.
    const granted = new Set(
      scopedRows
        .filter((r) => r.permissionId !== MODULE_ENABLED_SENTINEL)
        .map((r) => r.permissionId as ExtensionPermissionId)
    );
    const added: ExtensionPermissionId[] = [];
    const removed: ExtensionPermissionId[] = [];
    for (const id of declared) {
      if (!granted.has(id)) added.push(id);
    }
    for (const id of granted) {
      if (!declared.has(id)) removed.push(id);
    }
    return { added, removed };
  };

  result.global = computeDiff(loadGlobalRows(), 'global');
  if (workspacePath) {
    result.workspace = computeDiff(loadWorkspaceRows(workspacePath), 'workspace');
  }

  return result;
}

/**
 * Shrink the persisted grant set to match the currently declared permissions.
 * Used after an extension update removes a permission - the plan calls for
 * silent shrink, no prompt.
 *
 * Operates on both scopes if present. Returns the count of rows removed.
 */
export function shrinkGrantsToDeclared(args: {
  extensionId: string;
  moduleId: string;
  declaredPermissions: readonly ExtensionPermissionId[];
  workspacePath?: string;
}): number {
  const { extensionId, moduleId, declaredPermissions, workspacePath } = args;
  const declared = new Set<string>(declaredPermissions);
  let removed = 0;

  const globalRows = loadGlobalRows();
  const nextGlobal = globalRows.filter((r) => {
    if (
      r.extensionId === extensionId &&
      r.moduleId === moduleId &&
      r.scope === 'global' &&
      r.permissionId !== MODULE_ENABLED_SENTINEL &&
      !declared.has(r.permissionId)
    ) {
      removed += 1;
      return false;
    }
    return true;
  });
  if (nextGlobal.length !== globalRows.length) {
    saveGlobalRows(nextGlobal);
  }

  if (workspacePath) {
    const wsRows = loadWorkspaceRows(workspacePath);
    const nextWs = wsRows.filter((r) => {
      if (
        r.extensionId === extensionId &&
        r.moduleId === moduleId &&
        r.scope === 'workspace' &&
        r.permissionId !== MODULE_ENABLED_SENTINEL &&
        !declared.has(r.permissionId)
      ) {
        removed += 1;
        return false;
      }
      return true;
    });
    if (nextWs.length !== wsRows.length) {
      saveWorkspaceRows(workspacePath, nextWs);
    }
  }

  if (removed > 0) {
    logger.main.info(
      `[permissionGrantStore] Silent-shrank ${extensionId}/${moduleId} - removed ${removed} stale permission rows`
    );
  }
  return removed;
}

/**
 * Remove every grant row for an extension, across all scopes and workspaces.
 * Called when an extension is uninstalled - leaving orphan grants behind
 * would let a re-installed extension silently inherit them.
 *
 * Workspace scope is only cleared for the given workspacePath because the
 * electron-store API gives one workspace's state at a time. Uninstall flow
 * should iterate or accept that other workspaces' grants remain until next
 * touch (when they'd be ignored anyway, since the extension is missing).
 */
export function clearAllGrantsForExtension(args: {
  extensionId: string;
  workspacePath?: string;
}): void {
  const { extensionId, workspacePath } = args;
  const globalRows = loadGlobalRows();
  saveGlobalRows(globalRows.filter((r) => r.extensionId !== extensionId));
  if (workspacePath) {
    const wsRows = loadWorkspaceRows(workspacePath);
    saveWorkspaceRows(
      workspacePath,
      wsRows.filter((r) => r.extensionId !== extensionId)
    );
  }
  logger.main.info(
    `[permissionGrantStore] Cleared all grants for extension ${extensionId}` +
      (workspacePath ? ` (workspace ${workspacePath})` : ' (global only)')
  );
}

/**
 * Returns a stable snapshot of which (extension, module) pairs currently have
 * any grant rows, in the given workspace context. Used by the global
 * "Privileged Extensions" view to enumerate what's listed.
 */
export function listEnabledModules(
  workspacePath?: string
): Array<{
  extensionId: string;
  moduleId: string;
  scopes: GrantScope[];
}> {
  // Consult raw rows so modules backed only by the sentinel are visible.
  const globalRows = loadGlobalRows();
  const workspaceRows = workspacePath ? loadWorkspaceRows(workspacePath) : [];
  const all = [...globalRows, ...workspaceRows];
  const byKey = new Map<string, { extensionId: string; moduleId: string; scopes: Set<GrantScope> }>();
  for (const row of all) {
    const key = `${row.extensionId}::${row.moduleId}`;
    if (!byKey.has(key)) {
      byKey.set(key, {
        extensionId: row.extensionId,
        moduleId: row.moduleId,
        scopes: new Set(),
      });
    }
    byKey.get(key)!.scopes.add(row.scope);
  }
  return Array.from(byKey.values()).map((v) => ({
    extensionId: v.extensionId,
    moduleId: v.moduleId,
    scopes: Array.from(v.scopes),
  }));
}
