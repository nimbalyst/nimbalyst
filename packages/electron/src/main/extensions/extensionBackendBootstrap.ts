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

import type {
  BackendRuntimeContext,
  BackendToHostMessage,
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
}

class PermissionDeniedInRuntime extends Error {
  readonly permissionId: ExtensionPermissionId;
  constructor(permissionId: ExtensionPermissionId) {
    super(`Permission not granted: ${permissionId}`);
    this.name = 'PermissionDeniedInRuntime';
    this.permissionId = permissionId;
  }
}

function buildServices(ctx: BackendRuntimeContext, send: SendToHost): BackendServices {
  const granted = new Set<ExtensionPermissionId>(ctx.grantedPermissions);

  return {
    workspacePath: ctx.workspacePath,
    extensionPath: ctx.extensionPath,
    log: (level, message, data) => {
      send({ kind: 'log', level, message, data });
    },
    assertPermission: (permissionId) => {
      if (!granted.has(permissionId)) {
        throw new PermissionDeniedInRuntime(permissionId);
      }
    },
    hasPermission: (permissionId) => granted.has(permissionId),
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
  const mod: Record<string, unknown> = await import(ctx.entryFilePath);
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
