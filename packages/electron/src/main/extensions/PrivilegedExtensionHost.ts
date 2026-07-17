/**
 * PrivilegedExtensionHost
 *
 * Main-process singleton that owns the lifecycle of every privileged backend
 * module contributed by an extension. The host:
 *
 *   - composes the workspace-trust + permission-grant policy at start time
 *   - spawns the chosen runtime (utility-process or worker-thread)
 *   - speaks the typed RPC bridge defined in `extensionBackendRpc.ts`
 *   - tears modules down on revocation, uninstall, or crash
 *   - records per-call usage so the global view can show a timeline
 *   - exposes a small surface for Phase 4 to drive consent prompts
 *
 * Crash isolation:
 *   - Process-level for utility-process (OS isolation; `exit` is the signal)
 *   - Worker-level for worker-thread (`error` + `exit`; the main process
 *     keeps running)
 *   - In BOTH cases we do NOT auto-restart. The host emits a structured
 *     error event the renderer can surface and lets the user retry.
 *
 * Permission diff / re-prompt is computed at `startModule` time. Phase 4
 * will subscribe to the host's state events to drive the modal; this file
 * is responsible only for detecting and reporting the state.
 *
 * Lifecycle wiring status (as of this commit): this host implements the
 * runtime and policy machinery, but **nothing in the extension-loading
 * pipeline calls `startModule()` yet**. Backend modules ship with a
 * disabled-by-default contract (`enablement.default = 'disabled'`); the
 * first-use prompt, spawn, and crash plumbing here will be exercised once
 * the extension loader is taught to call `startModule` on activation /
 * grant-flip. The IPC layer in `ExtensionPermissionHandlers.ts` already
 * drives revoke + uninstall through this host.
 */

import { EventEmitter } from 'events';
import * as path from 'path';
import * as fs from 'fs/promises';
import { mkdirSync } from 'fs';
import { createHash } from 'crypto';
import { app, utilityProcess, UtilityProcess } from 'electron';
import { Worker } from 'worker_threads';
import type {
  BackendModuleContribution,
  ExtensionPermissionId,
} from '@nimbalyst/extension-sdk';
import { effectiveModulePermissions } from '@nimbalyst/extension-sdk';
import { logger } from '../utils/logger';
import {
  canModuleStart,
  assertPermission,
  CapabilityDeniedError,
} from './extensionCapabilityPolicy';
import {
  diffDeclaredAgainstGrants,
  shrinkGrantsToDeclared,
  listEffectiveGrants,
  clearAllGrantsForExtension,
  grantModulePermissions,
} from './permissionGrantStore';
import {
  raisePermissionPrompt,
  generatePermissionPromptId,
  type PermissionPromptRequest,
  type PermissionPromptKind,
} from './permissionPrompt';
import { getPermissionUsageTracker } from './permissionUsageTracker';
import { isBuiltinExtensionPath } from './builtinExtensionsDirectory';
import type {
  BackendRuntimeContext,
  BackendToHostMessage,
  BrokerMethodName,
  BrokerPayloads,
  BrokerResults,
  HostToBackendMessage,
  PendingRpc,
  PendingStream,
  SerializedError,
} from './extensionBackendRpc';
import { serializeError } from './extensionBackendRpc';
import { AgentMessagesRepository } from '@nimbalyst/runtime/storage/repositories/AgentMessagesRepository';
import { getProviderApiKeyFromSettings } from '../utils/store';
import { dispatchMetaAgentTool } from '../mcp/metaAgentServer';
import { dispatchDevAgentTool } from '../mcp/devAgentTools';
import { registerBackendTools } from '../mcp/backendToolRegistry';

/**
 * Authoritative map from broker method name to its required catalog permission.
 *
 * The host derives the required permission from the METHOD NAME, never from
 * anything the backend sends. This is the anti-forge gate: a compromised
 * backend that forges `method: 'getApiKey'` while only being granted
 * `nimbalyst-database-write` is denied because the host consults this table,
 * not the backend's claim.
 *
 * Per Q7 of phase-4-sdk-types-proposal: event-style methods (emitEvent,
 * requestPermission, askUserQuestion) are intentionally absent. They stay
 * provider-private and never route through this gate.
 */
const BROKER_METHOD_PERMISSIONS: {
  readonly [K in BrokerMethodName]: ExtensionPermissionId;
} = {
  logRaw: 'nimbalyst-database-write',
  getApiKey: 'secrets-read',
  readWorkspaceFile: 'workspace-files',
  writeWorkspaceFile: 'workspace-files',
  registerMcpTools: 'mcp-server-register',
  // Meta-agent tool dispatch (spawn_session / create_session / ...) reads and
  // writes the host's session store. The catalog has no dedicated orchestration
  // permission, so it gates on the high-risk DB-write grant the extension
  // already declares for logRaw.
  toolExecutor: 'nimbalyst-database-write',
  // Read-only dev tools (read_file / list_files / search_files) touch only the
  // workspace filesystem, so they gate on the minimal low-risk grant - NOT the
  // high-risk DB-write that orchestration needs. Separate method name keeps the
  // anti-forge gate honest: the host derives this permission from the method
  // name, never from the backend-supplied tool name.
  devToolExecutor: 'workspace-files',
} as const;

/** Public state of a single module the host is tracking. */
export type ModuleState =
  | { status: 'idle' }
  | { status: 'starting' }
  | { status: 'awaiting-consent'; reason: PermissionPromptKind }
  | { status: 'awaiting-trust' }
  | { status: 'running'; pid?: number; startedAt: number; methods: string[] }
  | { status: 'crashed'; exitCode: number | null; error?: SerializedError; crashedAt: number }
  | { status: 'denied'; reason: string }
  | { status: 'stopped'; stoppedAt: number };

export interface ModuleHandle {
  extensionId: string;
  moduleId: string;
  workspacePath: string;
  state: ModuleState;
}

/**
 * Inputs to start a module. The host owns the workspace, the module contract
 * comes from the extension's manifest, and `extensionPath` is the absolute
 * disk path the entry file is resolved against.
 */
export interface StartModuleArgs {
  extensionId: string;
  extensionName: string;
  extensionPath: string;
  module: BackendModuleContribution;
  workspacePath: string;
}

type ModuleKey = string;
function moduleKey(extensionId: string, moduleId: string, workspacePath: string): ModuleKey {
  return `${extensionId}::${moduleId}::${workspacePath}`;
}

type RpcCallback = {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  streaming: boolean;
  chunkHandler?: (chunk: unknown) => void;
};

interface ManagedRuntime {
  send: (msg: HostToBackendMessage) => void;
  kill: () => Promise<void>;
  isAlive: () => boolean;
}

/**
 * A one-shot gate that resolves when a spawning module reaches `running`
 * (init-ack) and rejects if it reaches a terminal non-running state first.
 * Lets `startModule` await readiness instead of returning while still
 * `starting` -- otherwise the first call after a cold start always sees
 * `starting` and the caller (e.g. an importer) wrongly reports "not ready".
 */
interface ReadyGate {
  promise: Promise<void>;
  resolve: () => void;
  reject: (err: Error) => void;
}

function createReadyGate(): ReadyGate {
  let resolve!: () => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // Never let the gate's own rejection surface as an unhandled rejection when
  // it loses a Promise.race to the timeout; awaiters handle the outcome.
  promise.catch(() => {});
  return { promise, resolve, reject };
}

/** Max time to wait for a spawned module to send init-ack before giving up. */
const MODULE_READY_TIMEOUT_MS = 15_000;

interface ManagedModule {
  args: StartModuleArgs;
  state: ModuleState;
  grantedPermissions: ExtensionPermissionId[];
  runtime?: ManagedRuntime;
  pending: Map<string, RpcCallback>;
  nextRpcId: number;
  /** Set while a spawn is in flight; resolved on `running`, rejected on failure. */
  ready?: ReadyGate | null;
  /**
   * The in-flight `startModule` attempt, if any. Concurrent callers await this
   * instead of launching a parallel attempt (prevents double-spawning while the
   * first attempt is parked on a consent/trust prompt).
   */
  startInFlight?: Promise<ModuleHandle>;
}

const HOST_EVENT_STATE_CHANGED = 'state-changed';

export class PrivilegedExtensionHost extends EventEmitter {
  private modules = new Map<ModuleKey, ManagedModule>();

  constructor() {
    super();
    this.setMaxListeners(50);
  }

  /**
   * Snapshot all module states. Phase 4 settings UI consumes this for the
   * "Privileged Extensions" view.
   */
  list(): ModuleHandle[] {
    const out: ModuleHandle[] = [];
    for (const m of this.modules.values()) {
      out.push({
        extensionId: m.args.extensionId,
        moduleId: m.args.module.id,
        workspacePath: m.args.workspacePath,
        state: m.state,
      });
    }
    return out;
  }

  /**
   * Get the current state of one module. Returns undefined if the host has
   * never been asked to start it.
   */
  getState(
    extensionId: string,
    moduleId: string,
    workspacePath: string
  ): ModuleState | undefined {
    return this.modules.get(moduleKey(extensionId, moduleId, workspacePath))?.state;
  }

  /**
   * Subscribe to state changes for any module the host manages. Phase 4
   * uses this to push live status updates to the renderer.
   */
  onStateChanged(
    handler: (handle: ModuleHandle) => void
  ): () => void {
    this.on(HOST_EVENT_STATE_CHANGED, handler);
    return () => {
      this.off(HOST_EVENT_STATE_CHANGED, handler);
    };
  }

  /**
   * Attempt to start a module. The flow is:
   *
   *   1. Check workspace trust. If untrusted -> state `awaiting-trust`, return.
   *   2. Compute permission diff vs. existing grants.
   *      a. removed.length > 0 (no added) -> silent shrink, continue.
   *      b. added.length > 0 OR no grants exist for the module -> raise the
   *         first-use / re-prompt prompt. If user declines, state `denied`.
   *   3. Once we have a satisfying grant set, launch the runtime.
   *
   * Returns the final handle. The handle's state reflects what actually
   * happened - callers don't need to inspect a separate result enum.
   */
  async startModule(args: StartModuleArgs): Promise<ModuleHandle> {
    const key = moduleKey(args.extensionId, args.module.id, args.workspacePath);
    let managed = this.modules.get(key);

    // Coalesce concurrent starts. A single attempt may be parked on an async
    // consent/trust prompt (state 'awaiting-consent'/'awaiting-trust'), which
    // the status checks below do NOT treat as in-flight — so two near-
    // simultaneous callers (e.g. the set-enable IPC and the workspace-open
    // sweep) would each launch a runtime, double-spawning the utility process.
    // Track the in-flight attempt and have later callers await it instead.
    if (managed?.startInFlight) {
      return managed.startInFlight;
    }

    if (!managed) {
      managed = {
        args,
        state: { status: 'idle' },
        grantedPermissions: [],
        pending: new Map(),
        nextRpcId: 1,
      };
      this.modules.set(key, managed);
    } else {
      // If already running, no-op. If a spawn is already in flight ('starting'),
      // await it instead of returning a premature 'starting' snapshot (which
      // would make the caller report "not ready"). If crashed/stopped/denied,
      // fall through and re-attempt.
      if (managed.state.status === 'running') {
        return this.snapshot(managed);
      }
      if (managed.state.status === 'starting') {
        await this.waitForRunning(managed).catch(() => {});
        return this.snapshot(managed);
      }
      managed.args = args;
    }

    const attempt = this.runStartAttempt(managed, args);
    managed.startInFlight = attempt;
    try {
      return await attempt;
    } finally {
      managed.startInFlight = undefined;
    }
  }

  /**
   * The actual start sequence (trust → consent → grant → spawn). Always invoked
   * through `startModule`, which guards against concurrent attempts via
   * `managed.startInFlight`.
   */
  private async runStartAttempt(
    managed: ManagedModule,
    args: StartModuleArgs
  ): Promise<ModuleHandle> {
    this.setState(managed, { status: 'starting' });

    // 1. Workspace trust + already-granted check. Note that canModuleStart
    //    returns ok:false for permission-not-granted as well; we want to
    //    treat that as "raise prompt" rather than "denied", so we'll
    //    re-check trust separately below.
    //
    //    Normalize the declared list to current catalog ids -- a module that
    //    still references a deprecated id (spawn-process et al.) shouldn't
    //    require a grant for a permission the host no longer enforces.
    const declared = effectiveModulePermissions(args.module.permissions);

    const trustCheck = await canModuleStart({
      extensionId: args.extensionId,
      moduleId: args.module.id,
      declaredPermissions: declared,
      workspacePath: args.workspacePath,
    });

    if (!trustCheck.ok && trustCheck.reason === 'workspace-untrusted') {
      this.setState(managed, { status: 'awaiting-trust' });
      logger.main.info(
        `[PrivilegedExtensionHost] ${args.extensionId}/${args.module.id} blocked: workspace untrusted`
      );
      return this.snapshot(managed);
    }
    if (!trustCheck.ok && trustCheck.reason === 'workspace-required') {
      this.setState(managed, {
        status: 'denied',
        reason: 'A workspace must be open to start privileged modules.',
      });
      return this.snapshot(managed);
    }

    // Built-in extensions ship inside the app bundle -- they are the same trust
    // domain as the app itself, so a first-use consent prompt would be
    // warning the user about code they already installed. Auto-grant
    // globally so the prompt below never raises for built-ins; marketplace
    // and sideloaded extensions still go through the full consent flow.
    if (await isBuiltinExtensionPath(args.extensionPath)) {
      grantModulePermissions({
        extensionId: args.extensionId,
        moduleId: args.module.id,
        permissions: declared,
        scope: 'global',
      });
      logger.main.info(
        `[PrivilegedExtensionHost] built-in auto-grant ${args.extensionId}/${args.module.id}`
      );
    }

    // 2. Diff declared vs. existing grants.
    const diff = diffDeclaredAgainstGrants({
      extensionId: args.extensionId,
      moduleId: args.module.id,
      declaredPermissions: declared,
      workspacePath: args.workspacePath,
    });

    const hasAnyGrant = diff.workspace !== undefined || diff.global !== undefined;
    const allAddedAcrossScopes = new Set<ExtensionPermissionId>();
    const existingScopes: Array<'workspace' | 'global'> = [];
    if (diff.workspace) {
      existingScopes.push('workspace');
      for (const p of diff.workspace.added) allAddedAcrossScopes.add(p);
    }
    if (diff.global) {
      existingScopes.push('global');
      for (const p of diff.global.added) allAddedAcrossScopes.add(p);
    }

    // 2a. Silent-shrink when permissions were removed and nothing was added.
    if (
      hasAnyGrant &&
      allAddedAcrossScopes.size === 0 &&
      ((diff.workspace?.removed.length ?? 0) > 0 || (diff.global?.removed.length ?? 0) > 0)
    ) {
      shrinkGrantsToDeclared({
        extensionId: args.extensionId,
        moduleId: args.module.id,
        declaredPermissions: declared,
        workspacePath: args.workspacePath,
      });
    }

    // 2b. Raise the prompt if we need consent.
    if (!hasAnyGrant || allAddedAcrossScopes.size > 0) {
      const reason: PermissionPromptKind = hasAnyGrant
        ? {
            kind: 're-prompt-update',
            addedPermissions: Array.from(allAddedAcrossScopes),
            existingScopes,
          }
        : { kind: 'first-use' };

      this.setState(managed, { status: 'awaiting-consent', reason });

      const request: PermissionPromptRequest = {
        id: generatePermissionPromptId(),
        extensionId: args.extensionId,
        extensionName: args.extensionName,
        moduleId: args.module.id,
        purpose: args.module.enablement.purpose,
        declaredPermissions: [...declared],
        workspacePath: args.workspacePath,
        reason,
        raisedAt: Date.now(),
      };

      const resolution = await raisePermissionPrompt(request);

      if (resolution.decision === 'not-now') {
        this.setState(managed, {
          status: 'denied',
          reason: 'User declined to grant permissions.',
        });
        return this.snapshot(managed);
      }
      // The Phase 4 resolver is expected to write the grant rows itself
      // (via permissionGrantStore.grantModulePermissions) before resolving.
      // We re-check post-resolution rather than trust the decision word.
      // This way the host stays correct even if the UI flow ever changes
      // shape (e.g., partial grants).
    }

    // 3. We should now have a satisfying grant set. Re-verify with the
    //    composed policy to be sure (trust + every declared permission).
    const finalCheck = await canModuleStart({
      extensionId: args.extensionId,
      moduleId: args.module.id,
      declaredPermissions: declared,
      workspacePath: args.workspacePath,
    });
    if (!finalCheck.ok) {
      this.setState(managed, {
        status: 'denied',
        reason: `Grant did not satisfy declared permissions (${finalCheck.reason}).`,
      });
      logger.main.warn(
        `[PrivilegedExtensionHost] ${args.extensionId}/${args.module.id} denied after prompt:`,
        finalCheck.reason
      );
      return this.snapshot(managed);
    }

    // Snapshot the effective grant set for the backend bootstrap. Only the
    // declared permissions are passed (no surplus from prior installs).
    const effective = listEffectiveGrants(args.workspacePath).filter(
      (g) =>
        g.extensionId === args.extensionId &&
        g.moduleId === args.module.id &&
        declared.includes(g.permissionId)
    );
    managed.grantedPermissions = Array.from(
      new Set(effective.map((g) => g.permissionId))
    );

    await this.spawnRuntime(managed);
    // Wait for init-ack so callers see 'running' (or a terminal failure),
    // never a transient 'starting'. A terminal failure rejects the gate; we
    // swallow it and return the snapshot so the caller inspects the status.
    await this.waitForRunning(managed).catch(() => {});
    return this.snapshot(managed);
  }

  /**
   * Stop a module. Sends a shutdown message; if it doesn't exit cleanly,
   * forcibly kills the runtime. Always resolves.
   */
  async stopModule(
    extensionId: string,
    moduleId: string,
    workspacePath: string,
    opts: { failPendingWith?: string } = {}
  ): Promise<void> {
    const key = moduleKey(extensionId, moduleId, workspacePath);
    const managed = this.modules.get(key);
    if (!managed || !managed.runtime) {
      return;
    }
    const reason = opts.failPendingWith ?? 'Module is shutting down';
    this.rejectPending(managed, reason);
    try {
      managed.runtime.send({ kind: 'shutdown' });
    } catch {
      // ignore - we kill regardless
    }
    await managed.runtime.kill();
    managed.runtime = undefined;
    this.setState(managed, { status: 'stopped', stoppedAt: Date.now() });
  }

  /**
   * Revoke + stop a single module's runtime in a single workspace. Called by
   * the consent UI when the user clicks Revoke for the workspace-scope grant.
   * The host removes its tracking entry entirely so a subsequent start is
   * treated as a fresh first-use.
   *
   * Per-module by design: revoking module A must NOT tear down sibling module
   * B from the same extension.
   */
  async revokeAndStopModule(
    extensionId: string,
    moduleId: string,
    workspacePath: string
  ): Promise<void> {
    const key = moduleKey(extensionId, moduleId, workspacePath);
    const managed = this.modules.get(key);
    if (!managed) return;
    await this.stopModule(extensionId, moduleId, workspacePath, {
      failPendingWith: 'Permission revoked',
    });
    this.modules.delete(key);
  }

  /**
   * Revoke + stop a single module across every workspace it's currently
   * running in. Called when the user revokes a `global`-scope grant: the
   * grant store may still keep a workspace-scope row for the same module in
   * some specific workspace, but every runtime that was relying on the
   * global grant must be torn down so it can re-check its effective grants
   * on next start.
   *
   * We don't try to be clever and keep runtimes alive that "would still be
   * authorized" by a leftover workspace-scope grant — stopping is the safe
   * default and the next start re-runs the policy check.
   */
  async revokeAndStopModuleEverywhere(
    extensionId: string,
    moduleId: string
  ): Promise<void> {
    const keys: ModuleKey[] = [];
    for (const [key, m] of this.modules) {
      if (m.args.extensionId === extensionId && m.args.module.id === moduleId) {
        keys.push(key);
      }
    }
    await Promise.all(
      keys.map((k) => {
        const m = this.modules.get(k)!;
        return this.stopModule(
          m.args.extensionId,
          m.args.module.id,
          m.args.workspacePath,
          { failPendingWith: 'Permission revoked' }
        );
      })
    );
    for (const key of keys) {
      this.modules.delete(key);
    }
  }

  /**
   * Called on extension uninstall. Stops every running module for the
   * extension across all workspaces, and clears persisted grants for the
   * current workspace + global scope.
   */
  async handleExtensionUninstalled(
    extensionId: string,
    workspacePath?: string
  ): Promise<void> {
    const keys: ModuleKey[] = [];
    for (const [key, m] of this.modules) {
      if (m.args.extensionId === extensionId) keys.push(key);
    }
    await Promise.all(
      keys.map((k) => {
        const m = this.modules.get(k)!;
        return this.stopModule(
          m.args.extensionId,
          m.args.module.id,
          m.args.workspacePath,
          { failPendingWith: 'Extension uninstalled' }
        );
      })
    );
    for (const key of keys) this.modules.delete(key);
    clearAllGrantsForExtension({ extensionId, workspacePath });
    getPermissionUsageTracker().clearExtension(extensionId);
  }

  /**
   * Send a request to a running module. Throws CapabilityDeniedError if the
   * method's required permission isn't granted right now. The backend shim
   * does the same check on its side; the host's check exists so a missing
   * grant cannot even reach the backend.
   *
   * `requiredPermission` is the permission the dispatched method needs. The
   * caller (renderer IPC handler, AI tool adapter) is responsible for
   * declaring which permission a given method consumes. Methods that need
   * no permission at all can pass `null`.
   */
  async request<T = unknown>(args: {
    extensionId: string;
    moduleId: string;
    workspacePath: string;
    method: string;
    params?: unknown;
    requiredPermission: ExtensionPermissionId | null;
  }): Promise<T> {
    const key = moduleKey(args.extensionId, args.moduleId, args.workspacePath);
    const managed = this.modules.get(key);
    if (!managed || !managed.runtime || managed.state.status !== 'running') {
      throw new Error(
        `[PrivilegedExtensionHost] module not running: ${args.extensionId}/${args.moduleId}`
      );
    }
    if (args.requiredPermission) {
      try {
        assertPermission({
          extensionId: args.extensionId,
          moduleId: args.moduleId,
          permissionId: args.requiredPermission,
          workspacePath: args.workspacePath,
        });
      } catch (err) {
        getPermissionUsageTracker().record({
          extensionId: args.extensionId,
          moduleId: args.moduleId,
          permissionId: args.requiredPermission,
          outcome: 'denied',
          method: args.method,
        });
        throw err;
      }
      getPermissionUsageTracker().record({
        extensionId: args.extensionId,
        moduleId: args.moduleId,
        permissionId: args.requiredPermission,
        outcome: 'allowed',
        method: args.method,
      });
    }

    const id = String(managed.nextRpcId++);
    return new Promise<T>((resolve, reject) => {
      managed.pending.set(id, {
        resolve: (v) => resolve(v as T),
        reject,
        streaming: false,
      });
      try {
        managed.runtime!.send({
          kind: 'rpc-request',
          id,
          method: args.method,
          params: args.params,
        });
      } catch (err) {
        managed.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /**
   * Streaming variant of `request`. The returned PendingStream's `onChunk`
   * receives every chunk; `done` resolves on end, rejects on stream-error.
   */
  stream<TChunk = unknown>(args: {
    extensionId: string;
    moduleId: string;
    workspacePath: string;
    method: string;
    params?: unknown;
    requiredPermission: ExtensionPermissionId | null;
  }): PendingStream<TChunk> {
    const key = moduleKey(args.extensionId, args.moduleId, args.workspacePath);
    const managed = this.modules.get(key);
    if (!managed || !managed.runtime || managed.state.status !== 'running') {
      throw new Error(
        `[PrivilegedExtensionHost] module not running: ${args.extensionId}/${args.moduleId}`
      );
    }
    if (args.requiredPermission) {
      assertPermission({
        extensionId: args.extensionId,
        moduleId: args.moduleId,
        permissionId: args.requiredPermission,
        workspacePath: args.workspacePath,
      });
      getPermissionUsageTracker().record({
        extensionId: args.extensionId,
        moduleId: args.moduleId,
        permissionId: args.requiredPermission,
        outcome: 'allowed',
        method: args.method,
      });
    }

    const id = String(managed.nextRpcId++);
    let chunkHandler: ((c: TChunk) => void) | undefined;

    const done = new Promise<void>((resolve, reject) => {
      managed.pending.set(id, {
        resolve: () => resolve(),
        reject,
        streaming: true,
        chunkHandler: (chunk) => chunkHandler?.(chunk as TChunk),
      });
      try {
        managed.runtime!.send({
          kind: 'rpc-request',
          id,
          method: args.method,
          params: args.params,
          streaming: true,
        });
      } catch (err) {
        managed.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });

    return {
      id,
      done,
      cancel: () => {
        try {
          managed.runtime?.send({ kind: 'rpc-cancel', id });
        } catch {
          // ignore - runtime might already be gone
        }
      },
      onChunk: (handler) => {
        chunkHandler = handler;
      },
    };
  }

  /**
   * Dispose of every managed module. Call on app shutdown.
   */
  async dispose(): Promise<void> {
    const keys = Array.from(this.modules.keys());
    await Promise.all(
      keys.map((k) => {
        const m = this.modules.get(k)!;
        return this.stopModule(
          m.args.extensionId,
          m.args.module.id,
          m.args.workspacePath,
          { failPendingWith: 'Host shutting down' }
        );
      })
    );
    this.modules.clear();
    this.removeAllListeners();
  }

  // ---------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------

  private setState(managed: ManagedModule, state: ModuleState): void {
    managed.state = state;
    // Settle a pending readiness gate when the spawn outcome is known.
    // `awaiting-consent` / `awaiting-trust` / `starting` are non-terminal and
    // leave the gate pending.
    if (managed.ready) {
      if (state.status === 'running') {
        managed.ready.resolve();
        managed.ready = null;
      } else if (
        state.status === 'crashed' ||
        state.status === 'denied' ||
        state.status === 'stopped'
      ) {
        managed.ready.reject(new Error(`module entered ${state.status}`));
        managed.ready = null;
      }
    }
    this.emit(HOST_EVENT_STATE_CHANGED, this.snapshot(managed));
  }

  /**
   * Await a starting module reaching `running`. Resolves immediately if already
   * running, returns (without throwing) if there is no in-flight spawn, and
   * gives up after {@link MODULE_READY_TIMEOUT_MS} so a hung spawn can't wedge
   * the caller. On a terminal failure the gate rejects; callers swallow it and
   * inspect the returned snapshot's status instead.
   */
  private async waitForRunning(managed: ManagedModule): Promise<void> {
    if (managed.state.status === 'running') return;
    const gate = managed.ready;
    if (!gate) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error('timed out waiting for module to start')),
        MODULE_READY_TIMEOUT_MS
      );
    });
    try {
      await Promise.race([gate.promise, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private snapshot(managed: ManagedModule): ModuleHandle {
    return {
      extensionId: managed.args.extensionId,
      moduleId: managed.args.module.id,
      workspacePath: managed.args.workspacePath,
      state: managed.state,
    };
  }

  private rejectPending(managed: ManagedModule, reason: string): void {
    if (managed.pending.size === 0) return;
    const err = new Error(reason);
    for (const [, cb] of managed.pending) {
      try {
        cb.reject(err);
      } catch {
        // swallow handler errors so one bad caller doesn't poison others
      }
    }
    managed.pending.clear();
  }

  /**
   * Resolve the path to the backend-side bootstrap shim. Vite emits it as a
   * standalone entry at `out/main/extensionBackendBootstrap.js`. This file
   * may end up in either `out/main/` or `out/main/chunks/` depending on how
   * vite splits the main bundle, so try both.
   */
  private resolveBootstrapPath(): string {
    const fs = require('fs') as typeof import('fs');
    const candidates = [
      path.join(__dirname, 'extensionBackendBootstrap.js'),
      path.join(__dirname, '..', 'extensionBackendBootstrap.js'),
    ];
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) return candidate;
    }
    throw new Error(
      `[PrivilegedExtensionHost] extensionBackendBootstrap.js not found. Tried: ${candidates.join(', ')}`
    );
  }

  private buildRuntimeContext(managed: ManagedModule): BackendRuntimeContext {
    return {
      extensionId: managed.args.extensionId,
      moduleId: managed.args.module.id,
      workspacePath: managed.args.workspacePath,
      grantedPermissions: [...managed.grantedPermissions],
      entryFilePath: path.join(managed.args.extensionPath, managed.args.module.entry),
      extensionPath: managed.args.extensionPath,
      dataDir: this.resolveBackendDataDir(
        managed.args.extensionId,
        managed.args.workspacePath
      ),
    };
  }

  /**
   * Per-(extension, workspace) data directory under the app's userData. Backend
   * modules persist machine-local, rebuildable state here so nothing is ever
   * written into the user's project tree. The workspace path is hashed (not
   * embedded) to keep the path short and free of path-illegal characters; the
   * extension id is sanitized to a safe segment. Created synchronously so it
   * exists by the time the module receives `init`.
   */
  private resolveBackendDataDir(extensionId: string, workspacePath: string): string {
    const safeExtId = extensionId.replace(/[^a-zA-Z0-9._-]/g, '_');
    const wsHash = createHash('sha256').update(workspacePath).digest('hex').slice(0, 16);
    const dir = path.join(app.getPath('userData'), 'extension-data', safeExtId, wsHash);
    try {
      mkdirSync(dir, { recursive: true });
    } catch (err) {
      logger.main.warn(
        `[PrivilegedExtensionHost] failed to create data dir ${dir}:`,
        err
      );
    }
    return dir;
  }

  private async spawnRuntime(managed: ManagedModule): Promise<void> {
    // Arm the readiness gate before sending init; `setState` settles it when
    // init-ack ('running') or a failure arrives.
    managed.ready = createReadyGate();
    const runtimeKind = managed.args.module.runtime;
    const bootstrapPath = this.resolveBootstrapPath();
    const ctx = this.buildRuntimeContext(managed);

    const logLabel = `${managed.args.extensionId}/${managed.args.module.id}`;

    let runtime: ManagedRuntime;
    if (runtimeKind === 'utility-process') {
      runtime = this.spawnUtilityProcess(managed, bootstrapPath, ctx, logLabel);
    } else {
      runtime = this.spawnWorkerThread(managed, bootstrapPath, ctx, logLabel);
    }
    managed.runtime = runtime;

    // Send init. `running` state is set once we receive init-ack.
    try {
      runtime.send({ kind: 'init', runtimeContext: ctx });
    } catch (err) {
      logger.main.error(
        `[PrivilegedExtensionHost] failed to send init to ${logLabel}:`,
        err
      );
      this.setState(managed, {
        status: 'crashed',
        exitCode: null,
        error: serializeError(err),
        crashedAt: Date.now(),
      });
      await runtime.kill();
      managed.runtime = undefined;
      return;
    }

    // Wait for the module to leave the transient 'starting' state (init-ack ->
    // running, or init-error -> crashed) before returning. Callers like the
    // extension-agent bridge treat 'starting' as a failure, so returning while
    // init-ack is still in flight would spuriously reject a module that is
    // milliseconds from ready. Yielding the event loop lets handleBackendMessage
    // process the init-ack and flip the state.
    const initDeadline = Date.now() + 20000;
    while (managed.state.status === 'starting' && Date.now() < initDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    if (managed.state.status === 'starting') {
      logger.main.error(
        `[PrivilegedExtensionHost] ${logLabel} init timed out (no init-ack within 20s)`
      );
      this.setState(managed, {
        status: 'crashed',
        exitCode: null,
        error: serializeError(new Error('Backend module init timed out')),
        crashedAt: Date.now(),
      });
      await managed.runtime?.kill();
      managed.runtime = undefined;
    }
  }

  private spawnUtilityProcess(
    managed: ManagedModule,
    bootstrapPath: string,
    ctx: BackendRuntimeContext,
    logLabel: string
  ): ManagedRuntime {
    if (!app.isReady()) {
      throw new Error(
        '[PrivilegedExtensionHost] cannot spawn utility-process before app ready'
      );
    }
    const child: UtilityProcess = utilityProcess.fork(bootstrapPath, [], {
      serviceName: `nimbalyst-ext-${managed.args.extensionId}-${managed.args.module.id}`,
      stdio: 'pipe',
    });

    child.on('spawn', () => {
      logger.main.info(
        `[PrivilegedExtensionHost] utility-process spawned for ${logLabel} pid=${child.pid}`
      );
    });
    child.on('message', (msg: unknown) => {
      this.handleBackendMessage(managed, msg as BackendToHostMessage, ctx);
    });
    child.on('exit', (code: number) => {
      this.handleRuntimeExit(managed, code, logLabel);
    });
    child.on('error', (type: string, location: string) => {
      logger.main.error(
        `[PrivilegedExtensionHost] utility-process fatal for ${logLabel}: ${type} @ ${location}`
      );
    });
    if (child.stderr) {
      child.stderr.on('data', (chunk: Buffer) => {
        logger.main.warn(
          `[PrivilegedExtensionHost:${logLabel}:stderr] ${chunk.toString().trimEnd()}`
        );
      });
    }
    if (child.stdout) {
      child.stdout.on('data', (chunk: Buffer) => {
        logger.main.info(
          `[PrivilegedExtensionHost:${logLabel}:stdout] ${chunk.toString().trimEnd()}`
        );
      });
    }

    return {
      send: (msg) => {
        child.postMessage(msg);
      },
      kill: async () => {
        if (child.pid === undefined) return;
        const killed = child.kill();
        if (!killed) {
          logger.main.warn(
            `[PrivilegedExtensionHost] kill() returned false for ${logLabel}`
          );
        }
      },
      isAlive: () => child.pid !== undefined,
    };
  }

  private spawnWorkerThread(
    managed: ManagedModule,
    bootstrapPath: string,
    ctx: BackendRuntimeContext,
    logLabel: string
  ): ManagedRuntime {
    const worker = new Worker(bootstrapPath, {
      workerData: { mode: 'worker-thread' },
      // We pass the runtime context via the init message rather than
      // workerData so the contract matches utility-process exactly.
    });

    worker.on('message', (msg: unknown) => {
      this.handleBackendMessage(managed, msg as BackendToHostMessage, ctx);
    });
    worker.on('error', (err) => {
      logger.main.error(
        `[PrivilegedExtensionHost] worker error for ${logLabel}:`,
        err
      );
      this.setState(managed, {
        status: 'crashed',
        exitCode: null,
        error: serializeError(err),
        crashedAt: Date.now(),
      });
      this.rejectPending(managed, `Backend crashed: ${err.message}`);
    });
    worker.on('exit', (code) => {
      this.handleRuntimeExit(managed, code, logLabel);
    });

    return {
      send: (msg) => {
        worker.postMessage(msg);
      },
      kill: async () => {
        await worker.terminate();
      },
      isAlive: () => worker.threadId !== -1,
    };
  }

  private handleRuntimeExit(
    managed: ManagedModule,
    code: number | null,
    logLabel: string
  ): void {
    logger.main.info(
      `[PrivilegedExtensionHost] runtime for ${logLabel} exited with code ${code}`
    );
    // If we already transitioned to `stopped`, this is the expected exit;
    // don't downgrade to crashed.
    if (managed.state.status !== 'stopped' && managed.state.status !== 'crashed') {
      this.setState(managed, {
        status: 'crashed',
        exitCode: code,
        crashedAt: Date.now(),
      });
    }
    this.rejectPending(managed, `Backend exited (code=${code ?? 'null'})`);
    managed.runtime = undefined;
  }

  private handleBackendMessage(
    managed: ManagedModule,
    msg: BackendToHostMessage,
    ctx: BackendRuntimeContext
  ): void {
    if (!msg || typeof msg !== 'object' || !('kind' in msg)) {
      logger.main.warn(
        '[PrivilegedExtensionHost] dropped malformed message from backend'
      );
      return;
    }
    const logLabel = `${managed.args.extensionId}/${managed.args.module.id}`;
    switch (msg.kind) {
      case 'init-ack':
        this.setState(managed, {
          status: 'running',
          startedAt: Date.now(),
          methods: msg.methods,
        });
        logger.main.info(
          `[PrivilegedExtensionHost] ${logLabel} ready (${msg.methods.length} methods)`
        );
        break;
      case 'init-error':
        logger.main.error(
          `[PrivilegedExtensionHost] ${logLabel} init failed:`,
          msg.error
        );
        this.setState(managed, {
          status: 'crashed',
          exitCode: null,
          error: msg.error,
          crashedAt: Date.now(),
        });
        // Module is unusable - tear it down.
        void managed.runtime?.kill();
        managed.runtime = undefined;
        break;
      case 'rpc-result': {
        const cb = managed.pending.get(msg.id);
        if (!cb) return;
        managed.pending.delete(msg.id);
        cb.resolve(msg.result);
        break;
      }
      case 'rpc-error': {
        const cb = managed.pending.get(msg.id);
        if (!cb) return;
        managed.pending.delete(msg.id);
        cb.reject(this.toError(msg.error));
        break;
      }
      case 'rpc-stream-chunk': {
        const cb = managed.pending.get(msg.id);
        if (!cb || !cb.streaming) return;
        cb.chunkHandler?.(msg.chunk);
        break;
      }
      case 'rpc-stream-end': {
        const cb = managed.pending.get(msg.id);
        if (!cb) return;
        managed.pending.delete(msg.id);
        cb.resolve(undefined);
        break;
      }
      case 'rpc-stream-error': {
        const cb = managed.pending.get(msg.id);
        if (!cb) return;
        managed.pending.delete(msg.id);
        cb.reject(this.toError(msg.error));
        break;
      }
      case 'log': {
        const fn =
          msg.level === 'error'
            ? logger.main.error
            : msg.level === 'warn'
            ? logger.main.warn
            : msg.level === 'debug'
            ? logger.main.debug
            : logger.main.info;
        fn.call(
          logger.main,
          `[ext:${ctx.extensionId}/${ctx.moduleId}] ${msg.message}`,
          msg.data
        );
        break;
      }
      case 'broker-request': {
        // Defense-in-depth gate. The client-side broker stub in
        // extensionBackendBootstrap also calls assertPermission synchronously
        // before postMessage; this check re-asserts it on the trust side of
        // the runtime boundary so a forged broker-request from a compromised
        // module is still rejected. The permission required is derived from
        // the HOST-AUTHORITATIVE table above, never from the backend's claim.
        //
        // The actual dispatch is async (DB / fs / settings store); we fire it
        // as a detached promise so handleBackendMessage stays synchronous.
        // The response/error is sent back on completion via runtime.send.
        const { requestId, method, payload } = msg;
        void this.handleBrokerRequest(managed, ctx, requestId, method, payload, logLabel);
        break;
      }
      default: {
        // Exhaustiveness check
        const _exhaust: never = msg;
        void _exhaust;
      }
    }
  }

  private toError(err: SerializedError): Error {
    const wrapped = new Error(err.message);
    wrapped.name = err.name ?? wrapped.name;
    if (err.stack) wrapped.stack = err.stack;
    if (err.code) (wrapped as { code?: string }).code = err.code;
    return wrapped;
  }

  /**
   * Apply the permission gate then dispatch a broker method, sending the
   * response or error back to the backend over its runtime channel.
   * Separated from handleBackendMessage so the message dispatcher stays sync.
   */
  private async handleBrokerRequest(
    managed: ManagedModule,
    ctx: BackendRuntimeContext,
    requestId: string,
    method: BrokerMethodName,
    payload: unknown,
    logLabel: string
  ): Promise<void> {
    const requiredPermission = BROKER_METHOD_PERMISSIONS[method];
    const tracker = getPermissionUsageTracker();
    try {
      assertPermission({
        extensionId: managed.args.extensionId,
        moduleId: managed.args.module.id,
        permissionId: requiredPermission,
        workspacePath: managed.args.workspacePath,
      });
      tracker.record({
        extensionId: managed.args.extensionId,
        moduleId: managed.args.module.id,
        permissionId: requiredPermission,
        outcome: 'allowed',
        method,
      });
      const result = await this.dispatchBrokerMethod(method, payload, ctx);
      managed.runtime?.send({
        kind: 'broker-response',
        requestId,
        result,
      });
    } catch (err) {
      if (err instanceof CapabilityDeniedError) {
        tracker.record({
          extensionId: managed.args.extensionId,
          moduleId: managed.args.module.id,
          permissionId: requiredPermission,
          outcome: 'denied',
          method,
        });
      }
      logger.main.warn(
        `[PrivilegedExtensionHost] ${logLabel} broker.${method} failed:`,
        err
      );
      managed.runtime?.send({
        kind: 'broker-error',
        requestId,
        error: serializeError(err),
      });
    }
  }

  /**
   * Per-method broker dispatch. Each branch performs the actual work AFTER the
   * gate has cleared. Payload typing is method-keyed via BrokerPayloads.
   *
   * Workspace boundary enforcement: readWorkspaceFile / writeWorkspaceFile
   * resolve the requested path against the runtime's workspacePath and reject
   * anything that escapes it (absolute paths outside the workspace, `..`
   * traversal).
   */
  private async dispatchBrokerMethod(
    method: BrokerMethodName,
    rawPayload: unknown,
    ctx: BackendRuntimeContext
  ): Promise<BrokerResults[BrokerMethodName]> {
    switch (method) {
      case 'logRaw': {
        const payload = rawPayload as BrokerPayloads['logRaw'];
        // Per phase-4-sdk-types-proposal §4.3 anti-impersonation guarantee:
        // the `source` is stamped HOST-SIDE from ctx.extensionId/ctx.moduleId.
        // The extension cannot supply or override it, so it cannot impersonate
        // first-party providers (e.g. claude-code) over the broker.
        const source = `${ctx.extensionId}/${ctx.moduleId}`;
        const direction = payload.direction === 'inbound' ? 'input' : 'output';
        await AgentMessagesRepository.create({
          sessionId: payload.sessionId,
          source,
          direction,
          content: payload.content,
          metadata: payload.metadata,
          hidden: false,
          createdAt: new Date(),
          searchable: true,
        });
        // AgentMessagesRepository.create returns void; the row id is not
        // exposed by the store contract. Return 0 as a sentinel so the wire
        // result shape stays { id: number }; callers that need the id should
        // re-query by (sessionId, providerMessageId) once a real id surface
        // is added.
        const result: BrokerResults['logRaw'] = { id: 0 };
        return result;
      }
      case 'getApiKey': {
        const payload = rawPayload as BrokerPayloads['getApiKey'];
        // Per CLAUDE.md "Never Use Environment Variables as Implicit API Key
        // Sources": read ONLY from the explicit Nimbalyst settings — the
        // `ai-settings` store's `apiKeys` (where provider keys actually live,
        // NOT `app-settings`) plus per-workspace overrides. Never process.env.
        const key = getProviderApiKeyFromSettings(payload.providerId, ctx.workspacePath);
        const result: BrokerResults['getApiKey'] = { key };
        return result;
      }
      case 'readWorkspaceFile': {
        const payload = rawPayload as BrokerPayloads['readWorkspaceFile'];
        const abs = this.resolveWorkspacePath(ctx, payload.path);
        const content = await fs.readFile(abs, 'utf-8');
        const result: BrokerResults['readWorkspaceFile'] = { content };
        return result;
      }
      case 'writeWorkspaceFile': {
        const payload = rawPayload as BrokerPayloads['writeWorkspaceFile'];
        const abs = this.resolveWorkspacePath(ctx, payload.path);
        await fs.writeFile(abs, payload.content, 'utf-8');
        const result: BrokerResults['writeWorkspaceFile'] = {
          bytesWritten: Buffer.byteLength(payload.content, 'utf-8'),
        };
        return result;
      }
      case 'registerMcpTools': {
        const payload = rawPayload as BrokerPayloads['registerMcpTools'];
        // Fan the registered tools into the main-side backend tool registry,
        // keyed by the workspace this module was started for. The coding-agent
        // and voice tool surfaces read from that registry; execution routes
        // back to this module via `handleBackendTool` -> `request`.
        const registered = registerBackendTools(
          ctx.workspacePath,
          ctx.extensionId,
          ctx.moduleId,
          payload.tools
        );
        logger.main.info(
          `[PrivilegedExtensionHost] broker.registerMcpTools: ${ctx.extensionId}/${ctx.moduleId} registered ${registered.length} tool(s) for ${ctx.workspacePath}`
        );
        const result: BrokerResults['registerMcpTools'] = { registered };
        return result;
      }
      case 'toolExecutor': {
        const payload = rawPayload as BrokerPayloads['toolExecutor'];
        // Scope the tool to the AI session that emitted it (so spawn_session
        // can find the caller) and the workspace it ran in. dispatchMetaAgentTool
        // normalizes worktree workspace paths to the parent repo internally.
        // The workspace falls back to the runtime's bound workspacePath when the
        // backend didn't supply one.
        const text = await dispatchMetaAgentTool(
          payload.name,
          payload.sessionId,
          payload.workspacePath ?? ctx.workspacePath,
          payload.args
        );
        const result: BrokerResults['toolExecutor'] = { result: text };
        return result;
      }
      case 'devToolExecutor': {
        const payload = rawPayload as BrokerPayloads['devToolExecutor'];
        // Read-only dev tools (read_file / list_files / search_files). The jail
        // root is the HOST-bound workspace (ctx.workspacePath), NEVER a
        // backend-supplied path, so a compromised backend cannot read outside
        // the workspace. ElectronFileSystemService's SafePathValidator blocks
        // traversal within the call, and reads are size-capped.
        const text = await dispatchDevAgentTool(
          payload.name,
          ctx.workspacePath,
          payload.args
        );
        const result: BrokerResults['devToolExecutor'] = { result: text };
        return result;
      }
      default: {
        // Exhaustiveness over BrokerMethodName.
        const _exhaust: never = method;
        void _exhaust;
        throw new Error(`unknown broker method: ${String(method)}`);
      }
    }
  }

  /**
   * Resolve a workspace-relative path against the runtime's workspacePath and
   * reject anything that escapes the workspace boundary. The `workspace-files`
   * grant is scoped to within the workspace; an access outside the workspace
   * is implicitly denied even when the catalog permission has been granted.
   */
  private resolveWorkspacePath(ctx: BackendRuntimeContext, relativePath: string): string {
    const resolved = path.resolve(ctx.workspacePath, relativePath);
    const workspaceAbs = path.resolve(ctx.workspacePath);
    const inside =
      resolved === workspaceAbs ||
      resolved.startsWith(workspaceAbs + path.sep);
    if (!inside) {
      throw new CapabilityDeniedError({
        reason: 'permission-not-granted',
        extensionId: ctx.extensionId,
        moduleId: ctx.moduleId,
        permissionId: 'workspace-files',
        detail: `path escapes workspace: ${relativePath}`,
      });
    }
    return resolved;
  }
}

let singleton: PrivilegedExtensionHost | null = null;

/**
 * Lazy accessor. Constructed on first use so static-init order in
 * `index.ts` is not affected.
 */
export function getPrivilegedExtensionHost(): PrivilegedExtensionHost {
  if (!singleton) {
    singleton = new PrivilegedExtensionHost();
  }
  return singleton;
}

export { CapabilityDeniedError };
