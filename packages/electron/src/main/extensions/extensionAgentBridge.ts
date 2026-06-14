/**
 * ExtensionAgentBridge (main-process installation)
 *
 * Phase 4 wiring: connects the runtime-side `ExtensionAgentProvider` wrapper
 * to the privileged backend module that actually implements the
 * `AgentProtocol`. The wrapper holds no state of its own; every call routes
 * through this bridge.
 *
 * Why a bridge (not a direct import)
 * ----------------------------------
 * The runtime package cannot import from electron main (it ships in both the
 * desktop app and the future headless server). So the wrapper exposes an
 * `ExtensionAgentBridge` interface and waits for main to install an
 * implementation via `setExtensionAgentBridge(...)`. This file is that
 * implementation. The bridge owns the three things the wrapper can't:
 *
 *   1. Looking up the `AgentProviderRegistry` entry for a contribution key
 *   2. Driving the lazy `PrivilegedExtensionHost.startModule(...)` flow
 *      (consent prompt + spawn) on first use
 *   3. Dispatching subsequent `sendMessage`/`abort`/`destroy` calls across
 *      the bootstrap broker once the module is `active`
 *
 * Lazy first-use semantics
 * ------------------------
 * The bridge does NOT start the backend module eagerly. The first
 * `initialize()` call:
 *
 *   - Looks up the registry entry. If status is `registered`, the bridge
 *     flips it to `pending-consent`, calls `startModule(...)`, and waits.
 *     `startModule` is the function that raises the consent prompt; the user
 *     may approve (-> `active`) or decline (-> `denied`).
 *   - If status is already `active`, the bridge skips straight to dispatch.
 *   - If status is `denied`, the bridge rejects the call cleanly with a
 *     `BridgeError` carrying `code: 'extension-agent-denied'` so the upstream
 *     ProviderFactory caller can surface a useful UI message.
 *   - If status is `pending-consent`, a concurrent caller awaits the same
 *     in-flight start (we don't fire `startModule` twice for the same key).
 *
 * After `startModule` resolves with `state.status === 'running'`, the bridge
 * marks the registry entry `active`. Anything else (denied, awaiting-trust,
 * crashed) flips it back to `registered` (or `denied` if the user said no)
 * so the next call re-runs the consent flow rather than silently failing.
 *
 * sendMessage shape
 * -----------------
 * `sendMessage` returns an `AsyncIterableIterator<StreamChunk>`. The bridge
 * starts a streaming RPC on the privileged host (`host.stream(...)`) and
 * pipes each `chunk` through the iterator. Cancellation (`abort()`) calls
 * the stream's `cancel()`. The streaming method on the backend side is the
 * convention `'sendMessage'` -- the backend module's `methods.sendMessage`
 * must be an `AsyncIterable` that yields `StreamChunk` shapes. Phase 5 will
 * adjust the contract; the bridge itself doesn't constrain it.
 *
 * Permission for sendMessage
 * --------------------------
 * `sendMessage` itself does NOT require an ExtensionPermissionId at the host
 * level -- the per-method permissions live on the broker calls the module
 * makes from inside its handler (logRaw, getApiKey, readWorkspaceFile,
 * etc.). The user's first-use consent grants every declared permission at
 * once; the broker re-asserts each one defense-in-depth on each call.
 *
 * Workspace path resolution
 * -------------------------
 * `PrivilegedExtensionHost.startModule` requires a workspace path. The
 * bridge prefers the path supplied by `sendMessage` (per-turn precision),
 * falling back to the active window's workspace path resolved at install
 * time. Sessions targeting a contribution before any workspace is open are
 * rejected with `BridgeError('extension-agent-no-workspace')`.
 */

import type {
  ExtensionAgentBridge,
  ExtensionAgentProvider as _ExtensionAgentProviderType, // type-only, for documentation
} from '@nimbalyst/runtime/ai/server/providers/ExtensionAgentProvider';
import { setExtensionAgentBridge } from '@nimbalyst/runtime/ai/server/providers/ExtensionAgentProvider';
import type {
  ProviderConfig,
  ProviderCapabilities,
  StreamChunk,
} from '@nimbalyst/runtime/ai/server/types';
import { logger } from '../utils/logger';
import {
  getAgentProviderRegistry,
  type AgentProviderEntry,
} from './AgentProviderRegistry';
import {
  getPrivilegedExtensionHost,
  type ModuleHandle,
} from './PrivilegedExtensionHost';
import { geminiUsageService } from '../services/GeminiUsageService';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

type BridgeErrorCode =
  | 'extension-agent-unknown'
  | 'extension-agent-denied'
  | 'extension-agent-awaiting-trust'
  | 'extension-agent-crashed'
  | 'extension-agent-no-workspace'
  | 'extension-agent-start-failed';

class BridgeError extends Error {
  readonly code: BridgeErrorCode;
  constructor(code: BridgeErrorCode, message: string) {
    super(message);
    this.name = 'ExtensionAgentBridgeError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Workspace path resolver (installed by main at wire time)
// ---------------------------------------------------------------------------

/**
 * Function that returns the active workspace path. Installed by
 * `installExtensionAgentBridge` so this module doesn't import window state
 * directly (keeps the bridge testable in isolation).
 */
type WorkspaceResolver = () => string | null;
let resolveActiveWorkspace: WorkspaceResolver = () => null;

// ---------------------------------------------------------------------------
// In-flight startModule de-duplication
// ---------------------------------------------------------------------------

/**
 * Concurrent `initialize` calls for the same key share one
 * `PrivilegedExtensionHost.startModule` invocation. The first caller fires
 * the call and parks the promise here; later callers await the same promise.
 * Cleared after the call resolves (success or failure).
 */
const inFlightStarts = new Map<string, Promise<ModuleHandle>>();

function startKey(extensionId: string, contributionId: string, workspacePath: string): string {
  return `${extensionId}/${contributionId}::${workspacePath}`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function requireEntry(extensionId: string, contributionId: string): AgentProviderEntry {
  const entry = getAgentProviderRegistry().get(extensionId, contributionId);
  if (!entry) {
    throw new BridgeError(
      'extension-agent-unknown',
      `No extension-agent provider registered for ${extensionId}/${contributionId}. ` +
        'The extension may have been uninstalled or its backend module was stripped at load.'
    );
  }
  return entry;
}

function resolveWorkspacePath(supplied?: string): string {
  const candidate = supplied ?? resolveActiveWorkspace();
  if (!candidate) {
    throw new BridgeError(
      'extension-agent-no-workspace',
      'Extension-agent providers require an open workspace. Open a workspace and try again.'
    );
  }
  return candidate;
}

/**
 * Find the BackendModuleContribution that the entry's `backendModuleId`
 * points at. We re-derive it from the manifest the registry holds rather
 * than caching it, so a rescan that replaced the entry is reflected.
 */
function findBackendModule(entry: AgentProviderEntry): {
  backendModuleId: string;
  module: NonNullable<
    NonNullable<AgentProviderEntry['manifest']['contributions']>['backendModules']
  >[number];
} {
  const modules = entry.manifest.contributions?.backendModules ?? [];
  const module = modules.find((m) => m.id === entry.backendModuleId);
  if (!module) {
    throw new BridgeError(
      'extension-agent-unknown',
      `Extension ${entry.extensionId} aiAgentProviders[${entry.contributionId}] references ` +
        `backendModuleId="${entry.backendModuleId}" which is not declared in contributions.backendModules.`
    );
  }
  return { backendModuleId: entry.backendModuleId, module };
}

// ---------------------------------------------------------------------------
// Bridge implementation
// ---------------------------------------------------------------------------

/**
 * Ensure the backend module for an entry is `running`. Drives the consent
 * prompt + spawn on first use; returns immediately if already running.
 * Mutates the registry status on the way through.
 */
async function ensureModuleStarted(
  entry: AgentProviderEntry,
  workspacePath: string
): Promise<void> {
  const key = startKey(entry.extensionId, entry.contributionId, workspacePath);
  const inflight = inFlightStarts.get(key);
  if (inflight) {
    await inflight;
    // Re-check status after the shared start resolved -- the original caller
    // may have flipped the entry to `denied`.
    const after = getAgentProviderRegistry().get(entry.extensionId, entry.contributionId);
    if (after?.status === 'denied') {
      throw new BridgeError(
        'extension-agent-denied',
        `User declined to grant ${entry.extensionId}/${entry.contributionId}.`
      );
    }
    return;
  }

  const registry = getAgentProviderRegistry();
  if (entry.status === 'denied') {
    throw new BridgeError(
      'extension-agent-denied',
      `User declined to grant ${entry.extensionId}/${entry.contributionId}. Re-enable the extension to try again.`
    );
  }
  if (entry.status === 'active') {
    // Re-verify the host still has it running. If a previous workspace's
    // runtime crashed and the registry wasn't notified, fall through to
    // start.
    const state = getPrivilegedExtensionHost().getState(
      entry.extensionId,
      entry.backendModuleId,
      workspacePath
    );
    if (state?.status === 'running') return;
  }

  // Flip to pending-consent so concurrent UI (dropdown) renders a spinner.
  registry.updateStatus(entry.extensionId, entry.contributionId, 'pending-consent');

  const { module } = findBackendModule(entry);
  const startPromise = getPrivilegedExtensionHost()
    .startModule({
      extensionId: entry.extensionId,
      extensionName: entry.manifest.name ?? entry.extensionId,
      extensionPath: entry.extensionPath,
      module,
      workspacePath,
    })
    .finally(() => {
      inFlightStarts.delete(key);
    });

  inFlightStarts.set(key, startPromise);

  let handle: ModuleHandle;
  try {
    handle = await startPromise;
  } catch (err) {
    registry.updateStatus(entry.extensionId, entry.contributionId, 'registered');
    throw new BridgeError(
      'extension-agent-start-failed',
      `Failed to start ${entry.extensionId}/${entry.backendModuleId}: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }

  switch (handle.state.status) {
    case 'running':
      registry.updateStatus(entry.extensionId, entry.contributionId, 'active');
      return;
    case 'denied':
      registry.updateStatus(entry.extensionId, entry.contributionId, 'denied');
      throw new BridgeError(
        'extension-agent-denied',
        handle.state.reason ??
          `User declined to grant ${entry.extensionId}/${entry.contributionId}.`
      );
    case 'awaiting-trust':
      registry.updateStatus(entry.extensionId, entry.contributionId, 'registered');
      throw new BridgeError(
        'extension-agent-awaiting-trust',
        `Workspace is not trusted. Trust the workspace to use ${entry.extensionId}/${entry.contributionId}.`
      );
    case 'awaiting-consent':
      // Prompt is still open. Surface as denied for this call; the next
      // attempt will pick up wherever the user lands.
      registry.updateStatus(entry.extensionId, entry.contributionId, 'registered');
      throw new BridgeError(
        'extension-agent-denied',
        'Consent prompt is still open. Approve the prompt and retry.'
      );
    case 'crashed':
      registry.updateStatus(entry.extensionId, entry.contributionId, 'registered');
      throw new BridgeError(
        'extension-agent-crashed',
        `Backend module crashed at startup (exit ${handle.state.exitCode}).`
      );
    default:
      // starting / idle / stopped after a fresh start are unexpected here;
      // be defensive and surface as a generic failure.
      registry.updateStatus(entry.extensionId, entry.contributionId, 'registered');
      throw new BridgeError(
        'extension-agent-start-failed',
        `Unexpected post-start state: ${handle.state.status}`
      );
  }
}

const bridge: ExtensionAgentBridge = {
  async initialize(args) {
    const entry = requireEntry(args.extensionId, args.contributionId);
    const workspacePath = resolveWorkspacePath();
    await ensureModuleStarted(entry, workspacePath);
    // After start, dispatch the optional initialize RPC if the module
    // exposes one. We treat absence as success -- many modules will only
    // implement sendMessage.
    const { backendModuleId } = findBackendModule(entry);
    try {
      await getPrivilegedExtensionHost().request({
        extensionId: entry.extensionId,
        moduleId: backendModuleId,
        workspacePath,
        method: 'initialize',
        params: { config: args.config, sessionId: args.sessionId },
        requiredPermission: null,
      });
    } catch (err) {
      // Modules that don't export `initialize` will throw "Unknown method".
      // Ignore that case; other errors propagate.
      const message = err instanceof Error ? err.message : String(err);
      if (!/Unknown method/i.test(message)) throw err;
    }
  },

  sendMessage(args) {
    // sendMessage must return an AsyncIterableIterator synchronously. The
    // streaming RPC needs the module to be running, which is async. Bridge
    // the gap with an inner async generator -- the runtime-side consumer
    // already expects to await `next()`.
    return (async function* (): AsyncIterableIterator<StreamChunk> {
      const entry = requireEntry(args.extensionId, args.contributionId);
      const workspacePath = resolveWorkspacePath(args.workspacePath);
      await ensureModuleStarted(entry, workspacePath);
      const { backendModuleId } = findBackendModule(entry);

      // Ensure the backend session exists before streaming the turn. The
      // backend's sendMessage throws "session is not created" otherwise.
      // createSession is idempotent on the backend (re-creation drops the
      // prior session cleanly), so calling it per turn is safe.
      //
      // `tools` are threaded into createSession so the backend stores them as
      // session-level defaults, AND into the sendMessage stream params below as
      // a per-turn override. Both are optional/additive — absent for any
      // extension that doesn't pass meta-agent tools.
      await getPrivilegedExtensionHost().request({
        extensionId: entry.extensionId,
        moduleId: backendModuleId,
        workspacePath,
        method: 'createSession',
        params: {
          sessionId: args.sessionId,
          workspacePath,
          model: args.model,
          tools: args.tools,
          systemPrompt: args.systemPrompt,
        },
        requiredPermission: null,
      });

      // Bounded queue between the host stream callbacks and the consumer.
      const queue: StreamChunk[] = [];
      let waiter: ((chunk: StreamChunk | null) => void) | null = null;
      let endError: Error | null = null;
      let ended = false;

      const push = (chunk: StreamChunk): void => {
        if (waiter) {
          const w = waiter;
          waiter = null;
          w(chunk);
        } else {
          queue.push(chunk);
        }
      };
      const finish = (err: Error | null): void => {
        ended = true;
        endError = err;
        if (waiter) {
          const w = waiter;
          waiter = null;
          w(null);
        }
      };

      const stream = getPrivilegedExtensionHost().stream<StreamChunk>({
        extensionId: entry.extensionId,
        moduleId: backendModuleId,
        workspacePath,
        method: 'sendMessage',
        params: {
          sessionId: args.sessionId,
          message: args.message,
          documentContext: args.documentContext,
          messages: args.messages,
          attachments: args.attachments,
          workspacePath,
          tools: args.tools,
          systemPrompt: args.systemPrompt,
        },
        requiredPermission: null,
      });

      stream.onChunk(push);
      stream.done.then(
        () => {
          finish(null);
          // A turn finished, so the Antigravity language server is up: wake the
          // Gemini usage poller to replace the muted "module not running" chip
          // with real quota. Fire-and-forget; never blocks the turn.
          if (entry.extensionId === 'gemini-antigravity') {
            void geminiUsageService.recordActivity();
          }
        },
        (err) => finish(err instanceof Error ? err : new Error(String(err)))
      );

      // Hook abort: the runtime-side wrapper's `abort()` is recorded in
      // `activeStreams` below by key. We register here so abort can cancel.
      activeStreams.set(streamKey(args), () => stream.cancel());

      try {
        while (true) {
          if (queue.length > 0) {
            yield queue.shift()!;
            continue;
          }
          if (ended) {
            if (endError) throw endError;
            return;
          }
          const chunk = await new Promise<StreamChunk | null>((resolve) => {
            waiter = resolve;
          });
          if (chunk === null) {
            if (endError) throw endError;
            return;
          }
          yield chunk;
        }
      } finally {
        activeStreams.delete(streamKey(args));
      }
    })();
  },

  abort(args) {
    const cancel = activeStreams.get(streamKey(args));
    if (cancel) {
      try {
        cancel();
      } catch (err) {
        logger.main.warn(
          `[extensionAgentBridge] abort cancel threw for ${args.extensionId}/${args.contributionId}:`,
          err
        );
      }
    }
    // Best-effort RPC for modules that want explicit abort. Fire and forget;
    // ignore errors (the module may have already finished).
    const entry = getAgentProviderRegistry().get(args.extensionId, args.contributionId);
    if (!entry) return;
    let backendModuleId: string;
    try {
      backendModuleId = findBackendModule(entry).backendModuleId;
    } catch {
      return;
    }
    const workspacePath = resolveActiveWorkspace();
    if (!workspacePath) return;
    void getPrivilegedExtensionHost()
      .request({
        extensionId: entry.extensionId,
        moduleId: backendModuleId,
        workspacePath,
        method: 'abort',
        params: { sessionId: args.sessionId },
        requiredPermission: null,
      })
      .catch(() => {
        /* module may not implement abort; ignore */
      });
  },

  destroy(args) {
    // Per-session destroy. We don't stop the backend module because other
    // sessions on the same extension may still be active. The wrapper has
    // already removed listeners; here we only cancel any lingering stream
    // and fire a best-effort 'destroy' RPC.
    const cancel = activeStreams.get(streamKey(args));
    if (cancel) {
      try {
        cancel();
      } catch {
        /* ignore */
      }
      activeStreams.delete(streamKey(args));
    }
    const entry = getAgentProviderRegistry().get(args.extensionId, args.contributionId);
    if (!entry) return;
    let backendModuleId: string;
    try {
      backendModuleId = findBackendModule(entry).backendModuleId;
    } catch {
      return;
    }
    const workspacePath = resolveActiveWorkspace();
    if (!workspacePath) return;
    void getPrivilegedExtensionHost()
      .request({
        extensionId: entry.extensionId,
        moduleId: backendModuleId,
        workspacePath,
        method: 'destroy',
        params: { sessionId: args.sessionId },
        requiredPermission: null,
      })
      .catch(() => {
        /* module may not implement destroy; ignore */
      });
  },

  getCapabilities(args): ProviderCapabilities {
    // Capabilities are static manifest data -- read straight off the
    // contribution. No round-trip to the backend. This must stay
    // synchronous to match the AIProvider contract.
    //
    // The Phase 4 SDK shape only carries `supportsResume`/`supportsForking`/
    // `supportsAttachments`. The rest (streaming, tools, mcpSupport, edits,
    // supportsFileTools) defaults to the agent-style profile -- streaming
    // on, tool-driven file reads on, edits on, mcpSupport off. A Phase 5
    // task can lift these onto the contribution when the SDK grows a
    // `capabilities` field; the bridge will pick them up automatically.
    const entry = getAgentProviderRegistry().get(args.extensionId, args.contributionId);
    if (!entry) {
      // Fail closed: report a minimally-capable provider so the UI doesn't
      // expose features the module doesn't support.
      return {
        streaming: true,
        tools: false,
        mcpSupport: false,
        edits: false,
        resumeSession: false,
        supportsFileTools: false,
      };
    }
    const c = entry.contribution;
    return {
      streaming: true,
      tools: true,
      mcpSupport: false,
      edits: true,
      resumeSession: c.supportsResume ?? false,
      supportsFileTools: true,
    };
  },
};

// ---------------------------------------------------------------------------
// In-flight stream registry (for abort + destroy)
// ---------------------------------------------------------------------------

const activeStreams = new Map<string, () => void>();
function streamKey(args: { extensionId: string; contributionId: string; sessionId: string }): string {
  return `${args.extensionId}/${args.contributionId}::${args.sessionId}`;
}

// ---------------------------------------------------------------------------
// Install / uninstall hooks for main startup
// ---------------------------------------------------------------------------

/**
 * Install the bridge during electron main startup. Idempotent -- safe to
 * call multiple times (the second call replaces the first; useful for
 * dev-mode hot reload).
 *
 * @param opts.resolveActiveWorkspacePath function returning the current
 *        active workspace path, or null if no workspace is open.
 */
export function installExtensionAgentBridge(opts: {
  resolveActiveWorkspacePath: WorkspaceResolver;
}): void {
  resolveActiveWorkspace = opts.resolveActiveWorkspacePath;
  setExtensionAgentBridge(bridge);
  logger.main.info('[extensionAgentBridge] installed');
}

/**
 * Tear down the bridge. Called from app shutdown for completeness; the
 * underlying singleton resets via `setExtensionAgentBridge(null)`.
 */
export function uninstallExtensionAgentBridge(): void {
  setExtensionAgentBridge(null);
  activeStreams.clear();
  inFlightStarts.clear();
  resolveActiveWorkspace = () => null;
}

/** Test-only escape hatch. */
export function __getBridgeForTests(): ExtensionAgentBridge {
  return bridge;
}
