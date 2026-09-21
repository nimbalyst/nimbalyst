/**
 * One-shot sends on the index socket: the create-session request and response,
 * the create-worktree response, and session control messages.
 *
 * Each of these answers another device that is waiting. A send that lands on a
 * socket the connection has already replaced reaches nobody, and the phone sits
 * on a request that will never complete -- so this follows the same discipline
 * as `sendIndexUpdate` (b63afaeb3): capture the socket and the connection
 * generation, do the async work, re-check the fence immediately before
 * `send`, and re-resolve the live socket rather than firing into the void.
 *
 * It also waits for the handshake. `connectToIndex` constructs the WebSocket
 * without awaiting `onopen`, so a caller that looks straight after it sees a
 * CONNECTING socket and used to drop the message on the floor.
 */

const WS_OPEN = 1;

/** How often the open-wait re-reads the socket state. */
const POLL_INTERVAL_MS = 10;

/** How long to wait for a handshake before giving up on a one-shot send. */
export const DEFAULT_INDEX_OPEN_TIMEOUT_MS = 5_000;

/** How many times a send may re-resolve the socket after losing the fence. */
export const MAX_INDEX_SEND_ATTEMPTS = 3;

export interface IndexSocketLike {
  readyState: number;
  send(payload: string): void;
}

export interface IndexSendChannelDeps {
  /** The socket the provider currently considers live, or null. */
  getSocket(): IndexSocketLike | null;
  /** Bumped on every reconnect and teardown. */
  getGeneration(): number;
  /** The provider's own view of whether the index link is usable. */
  isConnected(): boolean;
  /** Bring the index link up. May resolve before the handshake completes. */
  connect(): Promise<void>;
  /**
   * Monotonic clock for the open-wait budget. Defaults to `performance.now`:
   * fake-timer suites that fake `performance` advance it, and suites that only
   * freeze `Date` leave it running, so neither can distort the budget.
   */
  now?: () => number;
  warn?: (message: string, detail?: unknown) => void;
}

export interface IndexSendOptions {
  openTimeoutMs?: number;
}

export interface IndexSendOutcome {
  /** True when the payload was handed to an open, current socket. */
  sent: boolean;
  reason?: string;
  retryable?: boolean;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createIndexSendChannel(deps: IndexSendChannelDeps) {
  const now = deps.now ?? (() => performance.now());
  const warn = deps.warn ?? ((message: string, detail?: unknown) => console.warn(message, detail));

  /** A socket that is live, open, and belongs to the current generation. */
  function currentOpenSocket(): IndexSocketLike | null {
    const socket = deps.getSocket();
    if (!socket || socket.readyState !== WS_OPEN || !deps.isConnected()) return null;
    return socket;
  }

  /**
   * Connect if needed, then wait out the handshake until `deadline`.
   *
   * The deadline is set by the caller BEFORE `connect()` is awaited: connecting
   * is part of the budget, and starting the clock afterwards let a stall during
   * connect hand the wait a fresh full budget on the far side.
   */
  async function awaitOpenSocket(label: string, deadline: number): Promise<IndexSocketLike | null> {
    if (!currentOpenSocket()) {
      try {
        await deps.connect();
      } catch (err) {
        warn(`[CollabV3] Failed to connect to index before sending ${label}:`, err);
        return null;
      }
    }
    // Elapsed time, not tick count. Timer callbacks run late under load, so
    // counting them lets a stalled event loop stretch the wait well past the
    // budget -- a 250ms stall inside a 200ms budget kept waiting afterwards.
    // The deadline is re-read after every yield, so a stall ends the wait on
    // the next tick instead of extending it.
    let socket = currentOpenSocket();
    while (!socket && now() < deadline) {
      await delay(POLL_INTERVAL_MS);
      socket = currentOpenSocket();
    }
    return socket;
  }

  return {
    /**
     * Build and send one message. `build` runs AFTER the socket is open and its
     * generation captured, and may be async (encryption); if the connection
     * turns over while it runs, the payload is rebuilt against the replacement
     * rather than sent to a socket that is already gone.
     */
    async send(
      label: string,
      build: () => string | Promise<string>,
      options: IndexSendOptions = {},
    ): Promise<IndexSendOutcome> {
      const deadline = now() + (options.openTimeoutMs ?? DEFAULT_INDEX_OPEN_TIMEOUT_MS);

      for (let attempt = 1; attempt <= MAX_INDEX_SEND_ATTEMPTS; attempt++) {
        const socket = await awaitOpenSocket(label, deadline);
        if (!socket) {
          return { sent: false, reason: `no open index connection for ${label}`, retryable: true };
        }
        const generation = deps.getGeneration();

        let payload: string;
        try {
          payload = await build();
        } catch (err) {
          warn(`[CollabV3] Failed to build ${label}:`, err);
          // Deterministic: the same input would fail to build the same way.
          return { sent: false, reason: `failed to build ${label}`, retryable: false };
        }

        // The fence, re-read on the far side of the build. Generation covers a
        // reconnect, socket identity covers a replacement within one
        // generation, and readyState covers a close with no replacement yet.
        if (deps.getGeneration() !== generation || currentOpenSocket() !== socket) {
          warn(`[CollabV3] Index connection changed while building ${label}; re-resolving (attempt ${attempt})`);
          continue;
        }

        socket.send(payload);
        return { sent: true };
      }

      return {
        sent: false,
        reason: `index connection kept changing while sending ${label}`,
        retryable: true,
      };
    },
  };
}

/**
 * A one-shot send that never reached the wire.
 *
 * The public senders reject with this rather than resolving quietly: a caller
 * that awaited `sendCreateSessionRequest()` and got a fulfilled promise is
 * entitled to believe the request is on its way, and every caller in the tree
 * already handles a rejection (RemoteSessionMirror turns it into the user-facing
 * failure, serveRuntime and the mobile handlers log it).
 */
export class IndexSendError extends Error {
  readonly label: string;
  readonly reason: string | undefined;
  readonly retryable: boolean;

  constructor(label: string, reason: string | undefined, retryable: boolean) {
    super(`Failed to send ${label}: ${reason ?? 'unknown reason'}`);
    this.name = 'IndexSendError';
    this.label = label;
    this.reason = reason;
    this.retryable = retryable;
  }
}

/** Reject on an unsent outcome; no send failure may be invisible at the public API. */
export function throwIfUnsent(label: string, outcome: IndexSendOutcome): void {
  if (!outcome.sent) throw new IndexSendError(label, outcome.reason, outcome.retryable ?? true);
}
