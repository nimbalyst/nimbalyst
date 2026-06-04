/**
 * Extension Backend Bootstrap
 *
 * This file is the entry point loaded inside an extension's privileged
 * backend runtime - either an Electron `utilityProcess` or a Node
 * `worker_threads.Worker`. It runs OUTSIDE Electron main, so:
 *
 *   - dynamic `import()` is allowed here (the no-dynamic-imports rule
 *     applies to Electron main only)
 *   - this file MUST NOT import anything from Electron-main code (no
 *     `electron` BrowserWindow, no `app.getPath`, no logger.main, etc.)
 *   - we may only import:
 *       * `node:worker_threads` (when running as a worker)
 *       * the typed RPC contract types (type-only imports)
 *       * the extension SDK type for ExtensionPermissionId (type-only)
 *
 * The bootstrap:
 *   1. Establishes the right messaging primitive (parentPort vs process.parentPort)
 *   2. Waits for an `init` message from the host
 *   3. Builds a gated services object from `init.runtimeContext.grantedPermissions`
 *   4. Dynamic-imports the user entry file
 *   5. Calls its `activate(context)` (if exported) and registers RPC methods
 *      from the returned `methods` object
 *   6. Dispatches `rpc-request` messages, supporting both single-result and
 *      streaming methods
 *
 * The gated services object is the OUT-of-process synchronous denial layer.
 * A module that calls `services.spawnProcess(...)` without `spawn-process`
 * granted throws synchronously inside the runtime, without round-tripping
 * to main. The main-side `assertPermission` is defense in depth.
 */

import { pathToFileURL } from 'node:url';
import type {
  BackendRuntimeContext,
  BackendToHostMessage,
  BrokerMethodName,
  BrokerPayloads,
  BrokerResults,
  HostToBackendMessage,
} from './extensionBackendRpc';
import type { ExtensionPermissionId } from '@nimbalyst/extension-sdk';

type SendToHost = (msg: BackendToHostMessage) => void;

// ---------------------------------------------------------------------------
// Transport bootstrapping
// ---------------------------------------------------------------------------

interface Transport {
  send: SendToHost;
  onMessage: (handler: (msg: HostToBackendMessage) => void) => void;
}

function detectTransport(): Transport {
  // utilityProcess: process.parentPort exists
  // worker_thread:  worker_threads.parentPort exists
  const maybeParentPort = (process as unknown as {
    parentPort?: {
      on: (event: 'message', handler: (e: { data: HostToBackendMessage }) => void) => void;
      postMessage: (msg: BackendToHostMessage) => void;
    };
  }).parentPort;
  if (maybeParentPort) {
    return {
      send: (msg) => maybeParentPort.postMessage(msg),
      onMessage: (handler) => {
        maybeParentPort.on('message', (e) => handler(e.data));
      },
    };
  }

  // Fall through to worker_threads
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { parentPort } = require('worker_threads') as typeof import('worker_threads');
  if (!parentPort) {
    throw new Error(
      '[extensionBackendBootstrap] no transport: not running in utility-process or worker-thread'
    );
  }
  return {
    send: (msg) => parentPort.postMessage(msg),
    onMessage: (handler) => {
      parentPort.on('message', (msg: HostToBackendMessage) => handler(msg));
    },
  };
}

// ---------------------------------------------------------------------------
// Permission-gated services builder
// ---------------------------------------------------------------------------

/**
 * The services object passed to the module's activate function.
 *
 * Every method that touches a permission-gated capability begins with a
 * synchronous `assertPermission` call. The granted set is captured at module
 * init and never mutated - on grant changes the host kills+restarts the
 * runtime, so a stale set would mean the module is already dead.
 *
 * MVP intentionally exposes a small surface. Extension authors call into
 * Node primitives themselves; the gate stops them from doing so when they
 * shouldn't. Future work may move spawn/fetch/db behind these methods so
 * the gate can also enforce shape (e.g., loopback-only).
 */
export interface BackendServices {
  workspacePath: string;
  extensionPath: string;
  log: (level: 'debug' | 'info' | 'warn' | 'error', message: string, data?: unknown) => void;
  /**
   * Throws if `permissionId` is not in the granted set. Modules can use this
   * to gate their own internal entry points before calling restricted APIs.
   */
  assertPermission(permissionId: ExtensionPermissionId): void;
  /**
   * Same as assertPermission but boolean-returning. Useful for branching.
   */
  hasPermission(permissionId: ExtensionPermissionId): boolean;

  // -------------------------------------------------------------------------
  // Phase 4 broker methods. Each round-trips to main via postMessage.
  // EVERY method is permission-gated against the catalog:
  //   1. assertPermission() on the client side (synchronous denial inside the
  //      runtime — never round-trips when denied)
  //   2. Main re-asserts via extensionCapabilityPolicy.assertPermission as
  //      defense in depth, in case the runtime shim is bypassed or grants
  //      were revoked between snapshot and call
  //
  // Per Q7 in phase-4-sdk-types-proposal: event-style methods (emitEvent,
  // requestPermission, askUserQuestion) are PROVIDER-PRIVATE and intentionally
  // NOT on this interface. They are injected by individual providers
  // (e.g. AntigravityGeminiBridge) atop their own RPC surface, not by the
  // generic backend services builder.
  // -------------------------------------------------------------------------

  /**
   * Persist a raw agent message via AgentMessagesRepository.
   * Requires: `nimbalyst-database-write`.
   */
  logRaw(
    sessionId: string,
    direction: BrokerPayloads['logRaw']['direction'],
    content: string,
    metadata?: Record<string, unknown>
  ): Promise<BrokerResults['logRaw']>;

  /**
   * Read a provider API key from the EXPLICIT Nimbalyst settings store ONLY.
   * Never reads from process.env (per CLAUDE.md no-env-key rule). Returns
   * `{ key: null }` if the user hasn't configured one.
   * Requires: `secrets-read`.
   */
  getApiKey(providerId: string): Promise<BrokerResults['getApiKey']>;

  /**
   * Read a file rooted at workspacePath. Main-side enforces the workspace
   * boundary - traversal outside workspacePath is rejected.
   * Requires: `workspace-files`.
   */
  readWorkspaceFile(path: string): Promise<BrokerResults['readWorkspaceFile']>;

  /**
   * Write a file rooted at workspacePath. Main-side enforces the workspace
   * boundary - writes outside workspacePath are rejected.
   * Requires: `workspace-files`.
   */
  writeWorkspaceFile(path: string, content: string): Promise<BrokerResults['writeWorkspaceFile']>;

  /**
   * Register MCP tools with the McpConfigService so the host advertises them
   * to coding-agent sessions.
   * Requires: `mcp-server-register`.
   */
  registerMcpTools(
    tools: BrokerPayloads['registerMcpTools']['tools']
  ): Promise<BrokerResults['registerMcpTools']>;

  /**
   * Execute a parsed tool call against the host's meta-agent tool fns and
   * return the raw text result. This is the broker round-trip that backs the
   * provider-private `ctx.services.toolExecutor` the agent module calls (Q7).
   * The host dispatches the tool by name (spawn_session / create_session /
   * list_spawned_sessions / ...) scoped to the supplied AI session id.
   *
   * Returns the raw string the tool fn produced (the backend folds it back
   * into the model's next turn). The ambient extension contract types this as
   * `Promise<unknown>`; we return the string directly.
   *
   * Requires: `nimbalyst-database-write` — spawning and inspecting child
   * sessions reads and writes the host's session store.
   */
  toolExecutor(payload: {
    sessionId: string;
    workspacePath?: string;
    name: string;
    args: Record<string, unknown>;
  }): Promise<unknown>;
}

class PermissionDeniedInRuntime extends Error {
  readonly permissionId: ExtensionPermissionId;
  constructor(permissionId: ExtensionPermissionId) {
    super(`Permission not granted: ${permissionId}`);
    this.name = 'PermissionDeniedInRuntime';
    this.permissionId = permissionId;
  }
}

// ---------------------------------------------------------------------------
// Broker request/response plumbing
// ---------------------------------------------------------------------------

interface PendingBrokerCall {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
}

/**
 * In-flight broker requests keyed by requestId. Shared across all service
 * methods so a single response dispatch can route to the right caller.
 * Populated by `makeBrokerCall`, drained by the bootstrap's onMessage
 * handler when broker-response / broker-error arrives.
 */
const pendingBrokerCalls = new Map<string, PendingBrokerCall>();

let brokerRequestSeq = 0;
function nextBrokerRequestId(): string {
  // Process-id + monotonically increasing counter. Unique within this runtime,
  // which is all that matters since the host scopes responses by runtime.
  brokerRequestSeq += 1;
  return `brk-${process.pid}-${brokerRequestSeq}`;
}

function makeBrokerCall<M extends BrokerMethodName>(
  send: SendToHost,
  method: M,
  payload: BrokerPayloads[M]
): Promise<BrokerResults[M]> {
  return new Promise<BrokerResults[M]>((resolve, reject) => {
    const requestId = nextBrokerRequestId();
    pendingBrokerCalls.set(requestId, {
      resolve: resolve as (value: unknown) => void,
      reject,
    });
    try {
      send({
        kind: 'broker-request',
        requestId,
        method,
        payload,
      });
    } catch (err) {
      // postMessage itself failed - clean up and surface synchronously via reject.
      pendingBrokerCalls.delete(requestId);
      reject(err);
    }
  });
}

function resolveBrokerResponse(requestId: string, result: unknown): void {
  const pending = pendingBrokerCalls.get(requestId);
  if (!pending) return;
  pendingBrokerCalls.delete(requestId);
  pending.resolve(result);
}

function rejectBrokerResponse(
  requestId: string,
  error: { message: string; name?: string; code?: string; stack?: string }
): void {
  const pending = pendingBrokerCalls.get(requestId);
  if (!pending) return;
  pendingBrokerCalls.delete(requestId);
  const e = new Error(error.message);
  e.name = error.name ?? 'BrokerError';
  if (error.stack) e.stack = error.stack;
  if (error.code) (e as { code?: string }).code = error.code;
  pending.reject(e);
}

// ---------------------------------------------------------------------------
// Broker-event subscribers (for emitEvent fan-in on the backend side).
// ---------------------------------------------------------------------------

type BrokerEventHandler = (payload: unknown) => void;
const brokerEventSubscribers = new Map<string, Set<BrokerEventHandler>>();

function dispatchBrokerEvent(event: string, payload: unknown): void {
  const handlers = brokerEventSubscribers.get(event);
  if (!handlers) return;
  for (const handler of handlers) {
    try {
      handler(payload);
    } catch {
      // Subscriber errors must not break the dispatch loop.
    }
  }
}

function buildServices(ctx: BackendRuntimeContext, send: SendToHost): BackendServices {
  const granted = new Set<ExtensionPermissionId>(ctx.grantedPermissions);

  const assert = (permissionId: ExtensionPermissionId): void => {
    if (!granted.has(permissionId)) {
      throw new PermissionDeniedInRuntime(permissionId);
    }
  };

  return {
    workspacePath: ctx.workspacePath,
    extensionPath: ctx.extensionPath,
    log: (level, message, data) => {
      send({ kind: 'log', level, message, data });
    },
    assertPermission: assert,
    hasPermission: (permissionId) => granted.has(permissionId),

    // -----------------------------------------------------------------------
    // Phase 4 broker methods
    // -----------------------------------------------------------------------

    logRaw: (sessionId, direction, content, metadata) => {
      // Synchronous in-runtime denial; main re-asserts as defense in depth.
      assert('nimbalyst-database-write' as ExtensionPermissionId);
      return makeBrokerCall(send, 'logRaw', { sessionId, direction, content, metadata });
    },

    getApiKey: (providerId) => {
      assert('secrets-read' as ExtensionPermissionId);
      return makeBrokerCall(send, 'getApiKey', { providerId });
    },

    readWorkspaceFile: (path) => {
      assert('workspace-files' as ExtensionPermissionId);
      return makeBrokerCall(send, 'readWorkspaceFile', { path });
    },

    writeWorkspaceFile: (path, content) => {
      assert('workspace-files' as ExtensionPermissionId);
      return makeBrokerCall(send, 'writeWorkspaceFile', { path, content });
    },

    registerMcpTools: (tools) => {
      assert('mcp-server-register' as ExtensionPermissionId);
      return makeBrokerCall(send, 'registerMcpTools', { tools });
    },

    toolExecutor: async (payload) => {
      // Synchronous in-runtime denial; main re-asserts as defense in depth.
      // Spawning/inspecting child sessions is a host session-store write.
      assert('nimbalyst-database-write' as ExtensionPermissionId);
      const res = await makeBrokerCall(send, 'toolExecutor', {
        sessionId: payload.sessionId,
        workspacePath: payload.workspacePath,
        name: payload.name,
        args: payload.args,
      });
      // The agent module's tool loop consumes the raw text result; unwrap the
      // { result } envelope so callers get the string directly.
      return res.result;
    },

    // Per Q7: emitEvent / requestPermission / askUserQuestion are NOT injected
    // here. Providers that need them layer their own bridge atop this object.
  };
}

/**
 * Internal hook used by integration tests to attach to broker-event fan-out.
 * Not exposed on BackendServices because the MVP design has main pushing
 * events one-way; backends consume them only via the host SDK shim.
 */
export function _subscribeBrokerEvent(event: string, handler: BrokerEventHandler): () => void {
  let set = brokerEventSubscribers.get(event);
  if (!set) {
    set = new Set();
    brokerEventSubscribers.set(event, set);
  }
  set.add(handler);
  return () => {
    set!.delete(handler);
    if (set!.size === 0) brokerEventSubscribers.delete(event);
  };
}

// ---------------------------------------------------------------------------
// Module loading + method dispatch
// ---------------------------------------------------------------------------

/**
 * Shape the extension's entry file is expected to default-export OR
 * export as `activate`. The host calls activate(context) and receives a
 * `methods` record. Each method is invoked via RPC by name.
 */
export interface BackendModuleApi {
  /** Map of method name -> handler. Non-streaming handlers return a Promise. */
  methods?: Record<string, BackendMethod>;
  /** Optional cleanup. Called on shutdown. */
  deactivate?: () => Promise<void> | void;
}

export type BackendMethod =
  | ((params: unknown, ctx: BackendMethodContext) => Promise<unknown> | unknown)
  | ((params: unknown, ctx: BackendMethodContext) => AsyncIterable<unknown>);

export interface BackendMethodContext {
  services: BackendServices;
  signal: AbortSignal;
}

export interface BackendActivateContext {
  runtimeContext: BackendRuntimeContext;
  services: BackendServices;
}

type ActivateFn = (
  ctx: BackendActivateContext
) => Promise<BackendModuleApi | undefined> | BackendModuleApi | undefined;

interface LoadedModule {
  api: BackendModuleApi;
  abortByRpcId: Map<string, AbortController>;
}

async function loadEntry(
  ctx: BackendRuntimeContext,
  services: BackendServices
): Promise<LoadedModule> {
  // On Windows, dynamic import() of an absolute path (e.g. C:\...\agent.js)
  // throws ERR_UNSUPPORTED_ESM_URL_SCHEME: the ESM loader requires a file://
  // URL. Convert unless the caller already passed a URL.
  const entryUrl = ctx.entryFilePath.startsWith('file:')
    ? ctx.entryFilePath
    : pathToFileURL(ctx.entryFilePath).href;
  const mod: Record<string, unknown> = await import(entryUrl);
  const activate =
    (mod.activate as ActivateFn | undefined) ??
    (mod.default as ActivateFn | undefined);
  if (typeof activate !== 'function') {
    throw new Error(
      `[extensionBackendBootstrap] entry ${ctx.entryFilePath} must export activate(context)`
    );
  }
  const api = (await activate({ runtimeContext: ctx, services })) ?? {};
  return { api, abortByRpcId: new Map() };
}

function isAsyncIterable(v: unknown): v is AsyncIterable<unknown> {
  return (
    v !== null &&
    typeof v === 'object' &&
    typeof (v as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] ===
      'function'
  );
}

async function handleRequest(
  loaded: LoadedModule,
  services: BackendServices,
  send: SendToHost,
  msg: Extract<HostToBackendMessage, { kind: 'rpc-request' }>
): Promise<void> {
  const method = loaded.api.methods?.[msg.method];
  if (!method) {
    send({
      kind: 'rpc-error',
      id: msg.id,
      error: { message: `Unknown method: ${msg.method}`, name: 'UnknownMethod' },
    });
    return;
  }
  const abort = new AbortController();
  loaded.abortByRpcId.set(msg.id, abort);

  try {
    const ret = (method as BackendMethod)(msg.params, {
      services,
      signal: abort.signal,
    });

    if (msg.streaming) {
      if (!isAsyncIterable(ret)) {
        send({
          kind: 'rpc-stream-error',
          id: msg.id,
          error: {
            message: `Method ${msg.method} called as stream but did not return an AsyncIterable`,
            name: 'TypeError',
          },
        });
        return;
      }
      try {
        for await (const chunk of ret as AsyncIterable<unknown>) {
          if (abort.signal.aborted) break;
          send({ kind: 'rpc-stream-chunk', id: msg.id, chunk });
        }
        send({ kind: 'rpc-stream-end', id: msg.id });
      } catch (err) {
        send({ kind: 'rpc-stream-error', id: msg.id, error: serializeErrorLite(err) });
      }
    } else {
      const result = await (ret as Promise<unknown> | unknown);
      send({ kind: 'rpc-result', id: msg.id, result });
    }
  } catch (err) {
    send({ kind: 'rpc-error', id: msg.id, error: serializeErrorLite(err) });
  } finally {
    loaded.abortByRpcId.delete(msg.id);
  }
}

function serializeErrorLite(err: unknown): {
  message: string;
  name?: string;
  stack?: string;
  code?: string;
} {
  if (err instanceof Error) {
    return {
      message: err.message,
      name: err.name,
      stack: err.stack,
      code: (err as { code?: string }).code,
    };
  }
  return { message: String(err) };
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const transport = detectTransport();
  let loaded: LoadedModule | undefined;
  let services: BackendServices | undefined;

  transport.onMessage((msg) => {
    void handleMessage(msg);
  });

  async function handleMessage(msg: HostToBackendMessage): Promise<void> {
    switch (msg.kind) {
      case 'init': {
        try {
          services = buildServices(msg.runtimeContext, transport.send);
          loaded = await loadEntry(msg.runtimeContext, services);
          transport.send({
            kind: 'init-ack',
            methods: Object.keys(loaded.api.methods ?? {}),
          });
        } catch (err) {
          transport.send({ kind: 'init-error', error: serializeErrorLite(err) });
        }
        break;
      }
      case 'rpc-request': {
        if (!loaded || !services) {
          transport.send({
            kind: 'rpc-error',
            id: msg.id,
            error: { message: 'Backend not initialized', name: 'NotReady' },
          });
          return;
        }
        await handleRequest(loaded, services, transport.send, msg);
        break;
      }
      case 'rpc-cancel': {
        loaded?.abortByRpcId.get(msg.id)?.abort();
        break;
      }
      case 'broker-response': {
        resolveBrokerResponse(msg.requestId, msg.result);
        break;
      }
      case 'broker-error': {
        rejectBrokerResponse(msg.requestId, msg.error);
        break;
      }
      case 'broker-event': {
        dispatchBrokerEvent(msg.event, msg.payload);
        break;
      }
      case 'shutdown': {
        try {
          await loaded?.api.deactivate?.();
        } catch {
          // best-effort
        }
        // Exit. The host already expects exit shortly after shutdown.
        process.exit(0);
      }
    }
  }
}

main().catch((err) => {
  // No transport yet - last-ditch stderr so the host's stderr pipe captures it.
  // eslint-disable-next-line no-console
  console.error('[extensionBackendBootstrap] fatal:', err);
  process.exit(1);
});
