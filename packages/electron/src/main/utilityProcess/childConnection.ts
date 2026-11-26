/**
 * The child side of a supervised utility process.
 *
 * Loaded inside the utility process, outside Electron main, so it must stay
 * free of imports: no `electron`, no logger, no store. The build guard
 * (`scripts/utilityEntryGraphGuard.ts`) enforces that for every utility
 * entry's import closure.
 *
 * The handshake and liveness messages are shared with
 * `UtilityProcessSupervisor` on the main side: the child sends `ready` once it
 * can take work, and answers every `ping` with a `pong`. Every other message is
 * the owner's protocol.
 */

/** Sent once by the child when it can take work. */
export interface UtilityReadyMessage { type: 'ready'; protocol: number }
/** Sent by main while it has requests pending in the child. */
export interface UtilityPingMessage { type: 'ping'; seq: number }
/** The child's answer to a ping. */
export interface UtilityPongMessage { type: 'pong'; seq: number }

/** The subset of Electron's `process.parentPort` the connection uses. */
export interface ParentMessagePort {
  on(event: 'message', listener: (event: { data: unknown }) => void): unknown;
  postMessage(message: unknown): void;
}

export interface ChildConnection {
  /** Every message from main except pings. */
  onMessage(handler: (message: unknown) => void): void;
  postMessage(message: unknown): void;
  /** Tell main the child can take work. */
  ready(protocol: number): void;
}

export function createChildConnection(port: ParentMessagePort): ChildConnection {
  const handlers: Array<(message: unknown) => void> = [];
  port.on('message', (event) => {
    const message = event.data as { type?: unknown; seq?: unknown } | null;
    if (message && message.type === 'ping') {
      // Echo the seq as sent; the supervisor only needs to hear from the child.
      port.postMessage({ type: 'pong', seq: message.seq as number } satisfies UtilityPongMessage);
      return;
    }
    for (const handler of handlers) handler(message);
  });
  return {
    onMessage: (handler) => { handlers.push(handler); },
    postMessage: (message) => port.postMessage(message),
    ready: (protocol) => port.postMessage({ type: 'ready', protocol } satisfies UtilityReadyMessage),
  };
}

/** Connect to main through `process.parentPort`, or exit if there is none. */
export function connectToParentPort(label: string): ChildConnection {
  const port = (process as unknown as { parentPort?: ParentMessagePort }).parentPort;
  if (!port) {
    // stderr reaches main's log through the supervisor's stdio capture.
    console.error(`[${label}] no parentPort: not running in an Electron utility process`);
    process.exit(1);
  }
  return createChildConnection(port);
}
