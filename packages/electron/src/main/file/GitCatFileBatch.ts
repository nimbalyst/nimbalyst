/**
 * One long-lived `git cat-file --batch` process per workspace, in place of a
 * `git show` spawn per file.
 *
 * Rebuilding a session's baseline calls into git once per changed file. Process
 * creation is the expensive part: on a memory-pressured machine a single
 * `posix_spawn` measured ~1.9s, and one 23s freeze was 22.4s of `spawn` across
 * twelve calls. `git cat-file --batch` answers unlimited lookups over stdin, so
 * the cost collapses to one spawn per workspace.
 *
 * Protocol (git-cat-file(1), `--batch`): write `<rev>:<path>\n`, read back
 *   `<oid> SP <type> SP <size> LF <size bytes> LF`
 * or, when the object cannot be resolved,
 *   `<input> SP missing LF`
 * Responses come back in request order on a single stream, so requests are
 * queued FIFO and the reader is a length-prefixed state machine -- the body is
 * binary and may contain anything, including blank lines.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { logger } from '../utils/logger';

/** Matches FileSnapshotCache's per-file cap. */
const DEFAULT_MAX_OBJECT_BYTES = 1_000_000;
/** Long enough to serve a burst of file events, short enough not to linger. */
const DEFAULT_IDLE_TIMEOUT_MS = 30_000;

interface PendingRead {
  resolve: (value: string | null) => void;
  /** Objects past the cap are drained from the stream but reported as missing. */
  oversizeIsMissing: boolean;
}

export interface GitCatFileBatchOptions {
  idleTimeoutMs?: number;
  maxObjectBytes?: number;
}

export class GitCatFileBatch {
  private readonly workspacePath: string;
  private readonly idleTimeoutMs: number;
  private readonly maxObjectBytes: number;

  private child: ChildProcessWithoutNullStreams | null = null;
  private buffer: Buffer = Buffer.alloc(0);
  private queue: PendingRead[] = [];
  /** Set while a body is being consumed; null while awaiting a header line. */
  private awaitingBody: { remaining: number; chunks: Buffer[]; discard: boolean } | null = null;
  private idleTimer: NodeJS.Timeout | null = null;

  /** Spawns performed over this instance's life. Observability for tests. */
  public spawnCount = 0;

  constructor(workspacePath: string, options: GitCatFileBatchOptions = {}) {
    this.workspacePath = workspacePath;
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.maxObjectBytes = options.maxObjectBytes ?? DEFAULT_MAX_OBJECT_BYTES;
  }

  get isRunning(): boolean {
    return this.child !== null;
  }

  /**
   * Content of `relativePath` at `sha`, or null when git cannot resolve it --
   * a path that did not exist at that commit, an object past the size cap, or
   * a directory that is not a git repository.
   */
  read(sha: string, relativePath: string): Promise<string | null> {
    return new Promise<string | null>(resolve => {
      const child = this.ensureStarted();
      if (!child) {
        resolve(null);
        return;
      }

      this.queue.push({ resolve, oversizeIsMissing: true });
      this.touchIdleTimer();

      try {
        child.stdin.write(`${sha}:${relativePath}\n`);
      } catch (error) {
        logger.main.warn('[GitCatFileBatch] Could not write request:', error);
        this.failAll();
      }
    });
  }

  dispose(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    const child = this.child;
    this.child = null;
    this.buffer = Buffer.alloc(0);
    this.awaitingBody = null;
    this.failAll();

    if (child) {
      try {
        child.stdin.end();
      } catch {
        // Already gone.
      }
      child.kill();
    }
  }

  private ensureStarted(): ChildProcessWithoutNullStreams | null {
    if (this.child) return this.child;

    try {
      const child = spawn('git', ['cat-file', '--batch'], {
        cwd: this.workspacePath,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      this.spawnCount++;
      this.child = child;
      this.buffer = Buffer.alloc(0);
      this.awaitingBody = null;

      child.stdout.on('data', (chunk: Buffer) => this.onData(chunk));
      // Bind these to *this* child: a killed process emits `exit` asynchronously,
      // and by then a replacement may already be serving reads. An unbound
      // handler would tear down its successor and null out that caller's result.
      child.on('error', () => this.handleExit(child));
      child.on('exit', () => this.handleExit(child));
      // Drain stderr so a non-repo directory's complaint cannot fill the pipe.
      child.stderr.resume();

      this.touchIdleTimer();
      return child;
    } catch (error) {
      logger.main.warn('[GitCatFileBatch] Could not start git cat-file:', error);
      return null;
    }
  }

  private handleExit(child: ChildProcessWithoutNullStreams): void {
    // A late event from a process we already replaced carries no information.
    if (this.child !== child) return;
    this.child = null;
    this.buffer = Buffer.alloc(0);
    this.awaitingBody = null;
    // Anything still queued will never be answered by this process. Resolve as
    // missing rather than leaving the caller pending; the next read respawns.
    this.failAll();
  }

  private failAll(): void {
    const queued = this.queue;
    this.queue = [];
    for (const pending of queued) pending.resolve(null);
  }

  private touchIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      // Only retire an idle process; a pending read means it is still in use.
      if (this.queue.length === 0) this.dispose();
    }, this.idleTimeoutMs);
    this.idleTimer.unref?.();
  }

  private onData(chunk: Buffer): void {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);

    // Alternate between consuming a body of known length and reading the next
    // header line. Looping because one chunk may carry several responses.
    for (;;) {
      if (this.awaitingBody) {
        if (!this.consumeBody()) return;
        continue;
      }
      if (!this.consumeHeader()) return;
    }
  }

  /** @returns false when more bytes are needed. */
  private consumeHeader(): boolean {
    const newline = this.buffer.indexOf(0x0a);
    if (newline === -1) return false;

    const header = this.buffer.subarray(0, newline).toString('utf8');
    this.buffer = this.buffer.subarray(newline + 1);

    if (header.endsWith(' missing')) {
      this.queue.shift()?.resolve(null);
      if (this.queue.length === 0) this.touchIdleTimer();
      return true;
    }

    // `<oid> <type> <size>`
    const size = Number.parseInt(header.slice(header.lastIndexOf(' ') + 1), 10);
    if (!Number.isFinite(size) || size < 0) {
      // Unparseable header means the stream position is no longer trustworthy.
      logger.main.warn('[GitCatFileBatch] Unexpected header, restarting:', header);
      this.dispose();
      return false;
    }

    const pending = this.queue[0];
    this.awaitingBody = {
      // +1 for the trailing LF git writes after every body.
      remaining: size + 1,
      chunks: [],
      discard: size > this.maxObjectBytes || !pending,
    };
    return true;
  }

  /** @returns false when more bytes are needed. */
  private consumeBody(): boolean {
    const body = this.awaitingBody!;
    if (this.buffer.length === 0) return false;

    const take = Math.min(body.remaining, this.buffer.length);
    if (!body.discard) body.chunks.push(this.buffer.subarray(0, take));
    this.buffer = this.buffer.subarray(take);
    body.remaining -= take;

    if (body.remaining > 0) return false;

    this.awaitingBody = null;
    const pending = this.queue.shift();
    if (!pending) return true;
    // A slow read may outlive the timer set when it was enqueued. Start the
    // idle interval when the last response drains, including oversized bodies.
    if (this.queue.length === 0) this.touchIdleTimer();

    if (body.discard) {
      pending.resolve(null);
      return true;
    }
    // Drop the trailing LF that is not part of the object.
    const full = Buffer.concat(body.chunks);
    pending.resolve(full.subarray(0, full.length - 1).toString('utf8'));
    return true;
  }
}
