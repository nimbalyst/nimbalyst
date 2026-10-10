/**
 * Settles a confirmed team write (a page move, a type placement) from what the
 * server sends back, the way `itemPlacementConfirmations` does for typed pages.
 * TeamSync's sends are fire-and-forget and a server error carries no request
 * id, so:
 *
 * - the echo of the row (the server broadcasts every write to its author) that
 *   holds the wanted state confirms it; an echo without it (an older server
 *   that dropped `parentKind`) does not;
 * - a re-read list on the same connection that does not hold it is a refusal
 *   (TeamSync re-reads type placements after a server error);
 * - a server error that echoes the write's request id is a refusal (servers
 *   that send the author its own page writes do this);
 * - nothing within the timeout is a failure.
 */
export const COLLAB_WRITE_CONFIRM_TIMEOUT_MS = 6000;

interface Pending<Row> {
  key: string;
  holds: (row: Row) => boolean;
  requestId?: string;
  connection: number;
  resolve: () => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class CollabWriteConfirmations<Row> {
  private pending = new Set<Pending<Row>>();
  private connection = 0;

  constructor(
    private readonly timeoutMs = COLLAB_WRITE_CONFIRM_TIMEOUT_MS,
    /** Names the write in failure messages. */
    private readonly action = 'move',
  ) {}

  /** Register before sending; resolves on confirmation, rejects on refusal or timeout. */
  expect(key: string, holds: (row: Row) => boolean, requestId?: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const entry: Pending<Row> = {
        key,
        holds,
        ...(requestId ? { requestId } : {}),
        connection: this.connection,
        resolve,
        reject,
        timer: setTimeout(() => this.settle(entry, new Error(`The server did not confirm the ${this.action} in time.`)), this.timeoutMs),
      };
      this.pending.add(entry);
    });
  }

  changed(key: string, row: Row): void {
    for (const entry of this.pending) if (entry.key === key && entry.holds(row)) this.settle(entry);
  }

  /** The server refused the write sent with this request id. */
  refused(requestId: string, message: string): void {
    for (const entry of this.pending) {
      if (entry.requestId === requestId) this.settle(entry, new Error(`The server refused the ${this.action}: ${message}`));
    }
  }

  /** A full list from the server: what it holds is confirmed, the rest refused. */
  loaded(rows: Map<string, Row>): void {
    for (const entry of this.pending) {
      const row = rows.get(entry.key);
      if (row && entry.holds(row)) this.settle(entry);
      else if (entry.connection === this.connection) this.settle(entry, new Error(`The server refused the ${this.action}.`));
    }
  }

  connectionChanged(connected: boolean): void {
    if (!connected) this.connection += 1;
  }

  dispose(): void {
    for (const entry of this.pending) this.settle(entry, new Error('The team connection closed.'));
  }

  private settle(entry: Pending<Row>, error?: Error): void {
    if (!this.pending.delete(entry)) return;
    clearTimeout(entry.timer);
    if (error) entry.reject(error);
    else entry.resolve();
  }
}
