/**
 * Typed RPC bridge between Electron main (the PrivilegedExtensionHost) and a
 * backend module running in either a utility process or a worker thread.
 *
 * Shapes only - no transport-specific code. Both runtimes wrap the same
 * message protocol over their respective channels:
 *   - utility-process: `UtilityProcess.postMessage` <-> `process.parentPort.postMessage`
 *   - worker-thread:   `Worker.postMessage` <-> `parentPort.postMessage`
 *
 * The host owns the *outgoing* request side (renderer/AI -> backend). The
 * backend owns the *outgoing* result/stream side. Either side can log via
 * `log` messages so the host can pipe backend output into the main log with
 * structured context.
 *
 * Cancellation is cooperative: the host sends `rpc-cancel`, the backend is
 * expected to stop work and emit `rpc-stream-end` or `rpc-error` shortly
 * after. There is no forced termination short of killing the process.
 */

import type { ExtensionPermissionId } from '@nimbalyst/extension-sdk';

/**
 * Stable identity passed to a backend module on init. The module never
 * receives a reference to anything from main - everything it can do flows
 * through the services object the bootstrap builds from this context.
 */
export interface BackendRuntimeContext {
  extensionId: string;
  moduleId: string;
  /**
   * Resolved workspace path the module is bound to. Workspace path is
   * non-sensitive metadata (per plan's resolved open question) and is
   * always provided. `workspace-files` still gates real read/write.
   */
  workspacePath: string;
  /**
   * Snapshot of granted permissions at module-start time. The backend shim
   * uses this to gate its own services object synchronously, without
   * round-tripping. The host updates this set on grant changes by restarting
   * the module - no live mutation of this snapshot.
   */
  grantedPermissions: ExtensionPermissionId[];
  /**
   * Path to the user's `entry` JS file. The backend bootstrap dynamic-imports
   * this AFTER constructing the gated services object. (Dynamic import is
   * allowed here - this is in the utility-process / worker, NOT Electron
   * main, so the no-dynamic-imports rule does not apply.)
   */
  entryFilePath: string;
  /**
   * Absolute path to the extension's installation directory. The backend
   * may resolve assets relative to this. Read-only - not a write target.
   */
  extensionPath: string;
}

/** Messages the host sends to the backend. */
export type HostToBackendMessage =
  | {
      kind: 'init';
      runtimeContext: BackendRuntimeContext;
    }
  | {
      kind: 'rpc-request';
      /** Caller-generated correlation id. The backend echoes this on every reply. */
      id: string;
      /** Dot-separated method path the module exports. */
      method: string;
      /** Arbitrary JSON-serializable params. */
      params: unknown;
      /** When true, the backend may reply with rpc-stream-chunk messages. */
      streaming?: boolean;
    }
  | {
      kind: 'rpc-cancel';
      id: string;
    }
  | {
      kind: 'broker-response';
      /** Correlation id matching the backend's broker-request. */
      requestId: string;
      result: unknown;
    }
  | {
      kind: 'broker-error';
      /** Correlation id matching the backend's broker-request. */
      requestId: string;
      error: SerializedError;
    }
  | {
      kind: 'broker-event';
      /** Async event broadcast from main to the backend (e.g., emitEvent fan-out). */
      event: string;
      payload: unknown;
    }
  | {
      kind: 'shutdown';
    };

/** Messages the backend sends to the host. */
export type BackendToHostMessage =
  | {
      kind: 'init-ack';
      /** Reports the methods the module advertised after init. */
      methods: string[];
    }
  | {
      kind: 'init-error';
      error: SerializedError;
    }
  | {
      kind: 'rpc-result';
      id: string;
      result: unknown;
    }
  | {
      kind: 'rpc-error';
      id: string;
      error: SerializedError;
    }
  | {
      kind: 'rpc-stream-chunk';
      id: string;
      chunk: unknown;
    }
  | {
      kind: 'rpc-stream-end';
      id: string;
    }
  | {
      kind: 'rpc-stream-error';
      id: string;
      error: SerializedError;
    }
  | {
      kind: 'log';
      level: 'debug' | 'info' | 'warn' | 'error';
      message: string;
      data?: unknown;
    }
  | {
      kind: 'broker-request';
      /** Backend-generated correlation id. Main echoes this on broker-response. */
      requestId: string;
      /** Broker method name (e.g., 'logRaw', 'getApiKey', 'readWorkspaceFile'). */
      method: BrokerMethodName;
      /** Method-specific payload. */
      payload: unknown;
    };

/**
 * Names of broker methods routed across the runtime boundary. Each maps to a
 * main-side handler that asserts the appropriate permission (defense in depth)
 * and performs the actual work.
 *
 * Per Q7 in phase-4-sdk-types-proposal: event-style methods (emitEvent,
 * requestPermission, askUserQuestion) are PROVIDER-PRIVATE. They are NOT
 * exposed on BackendServices and NOT routed through the broker. Providers
 * that need them inject their own bridge.
 */
export type BrokerMethodName =
  | 'logRaw'
  | 'getApiKey'
  | 'readWorkspaceFile'
  | 'writeWorkspaceFile'
  | 'registerMcpTools'
  | 'toolExecutor'
  | 'devToolExecutor';

/** Payload shapes for each broker method. Kept here so both sides share one truth. */
export interface BrokerPayloads {
  logRaw: {
    direction: 'inbound' | 'outbound';
    sessionId: string;
    content: string;
    metadata?: Record<string, unknown>;
  };
  getApiKey: {
    providerId: string;
  };
  readWorkspaceFile: {
    path: string;
  };
  writeWorkspaceFile: {
    path: string;
    content: string;
  };
  registerMcpTools: {
    tools: Array<{
      name: string;
      description?: string;
      inputSchema?: unknown;
    }>;
  };
  toolExecutor: {
    /** AI session id the tool call belongs to (used to scope spawn_session). */
    sessionId: string;
    /** Workspace path; the host normalizes worktree paths to the parent repo. */
    workspacePath?: string;
    /** Tool name (may carry the mcp__nimbalyst-meta-agent__ prefix). */
    name: string;
    /** Parsed tool arguments. */
    args: Record<string, unknown>;
  };
  devToolExecutor: {
    /** Read-only dev tool name (read_file | list_files | search_files). */
    name: string;
    /** Parsed tool arguments. */
    args: Record<string, unknown>;
    // NOTE: no workspacePath. The host pins the jail to its bound
    // ctx.workspacePath; the backend cannot influence the jail root.
  };
}

/** Result shapes returned over broker-response for each method. */
export interface BrokerResults {
  logRaw: { id: number };
  getApiKey: { key: string | null };
  readWorkspaceFile: { content: string };
  writeWorkspaceFile: { bytesWritten: number };
  registerMcpTools: { registered: string[] };
  /** Raw text result the meta-agent tool fn returned. */
  toolExecutor: { result: string };
  /** Formatted text result the read-only dev tool produced. */
  devToolExecutor: { result: string };
}

export interface SerializedError {
  message: string;
  name?: string;
  stack?: string;
  /** Optional structured tag for known error classes (e.g., CapabilityDeniedError). */
  code?: string;
}

export function serializeError(err: unknown): SerializedError {
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

/**
 * Promise + cancellation handle returned for an in-flight RPC.
 */
export interface PendingRpc<T = unknown> {
  id: string;
  promise: Promise<T>;
  cancel: () => void;
}

/**
 * Stream handle returned for a streaming RPC. `onChunk` is called for each
 * incoming chunk; `done` resolves on rpc-stream-end and rejects on
 * rpc-stream-error.
 */
export interface PendingStream<TChunk = unknown> {
  id: string;
  done: Promise<void>;
  cancel: () => void;
  onChunk: (handler: (chunk: TChunk) => void) => void;
}
