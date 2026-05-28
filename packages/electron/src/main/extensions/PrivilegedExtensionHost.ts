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
} from './permissionGrantStore';
import {
  raisePermissionPrompt,
  generatePermissionPromptId,
  type PermissionPromptRequest,
  type PermissionPromptKind,
} from './permissionPrompt';
import { getPermissionUsageTracker } from './permissionUsageTracker';
import type {
  BackendRuntimeContext,
  BackendToHostMessage,
  HostToBackendMessage,
  PendingRpc,
  PendingStream,
  SerializedError,
} from './extensionBackendRpc';
import { serializeError } from './extensionBackendRpc';

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

interface ManagedModule {
  args: StartModuleArgs;
  state: ModuleState;
  grantedPermissions: ExtensionPermissionId[];
  runtime?: ManagedRuntime;
  pending: Map<string, RpcCallback>;
  nextRpcId: number;
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
      // If already running, no-op. If crashed/stopped/denied, fall through
      // and re-attempt.
      if (managed.state.status === 'running' || managed.state.status === 'starting') {
        return this.snapshot(managed);
      }
      managed.args = args;
    }

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
    this.emit(HOST_EVENT_STATE_CHANGED, this.snapshot(managed));
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
    };
  }

  private async spawnRuntime(managed: ManagedModule): Promise<void> {
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
