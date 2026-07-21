import { mkdir, open, readFile, rename, truncate, unlink } from 'node:fs/promises';
import path from 'node:path';

import type {
  SessionVisibilityAuditEvent,
  SessionVisibilityOperation,
} from './SessionVisibilityControlService';

export interface SessionVisibilityDeliveryDescriptor {
  auditId: string;
  operation: SessionVisibilityOperation;
  targetSessionId: string;
  workspaceId: string;
  /** Exact host-derived path used for WindowManager routing, never normalized. */
  workspacePath?: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}

export interface SessionVisibilityMutationIntent {
  auditId: string;
  operation: SessionVisibilityOperation;
  phase: 'reserved';
  /** Identifies the live service instance that may still reach its store write. */
  reservationOwnerId?: string;
  targetSessionId: string;
  workspaceId: string;
  beforeStateId: string;
  afterStateId: string;
  /** Exact store fingerprint; recovery must match both ID and payload. */
  mutationIdentity: string;
  audit: SessionVisibilityAuditEvent;
  delivery: SessionVisibilityDeliveryDescriptor | null;
}

type StandaloneEntry =
  | { id: string; kind: 'audit'; payload: SessionVisibilityAuditEvent }
  | { id: string; kind: 'delivery'; payload: SessionVisibilityDeliveryDescriptor };

interface MutationEntry {
  id: string;
  kind: 'mutation';
  payload: SessionVisibilityMutationIntent;
  phase: 'reserved' | 'committed';
  auditPending: boolean;
  deliveryPending: boolean;
}

type OutboxEntry = StandaloneEntry | MutationEntry;

type JournalRecord =
  | { action: 'put'; entry: StandaloneEntry }
  | { action: 'ack'; id: string }
  | { action: 'reserve'; entry: MutationEntry }
  | { action: 'commit'; id: string }
  | { action: 'auditAck'; id: string }
  | { action: 'deliveryAck'; id: string }
  | { action: 'retry'; id: string; attempts: number; nextAttemptAt: number }
  | { action: 'abort'; id: string };

interface PendingRuntimeEntry {
  entry: OutboxEntry;
  attempts: number;
  nextAttemptAt: number;
}

export interface SessionVisibilityConvergenceOutboxOptions {
  filePath?: string;
  storageRoot?: string;
  retryIntervalMs?: number;
  maxRetryIntervalMs?: number;
  maxEntriesPerFlush?: number;
  compactionRecordThreshold?: number;
  now?: () => number;
  audit: (event: SessionVisibilityAuditEvent) => Promise<void> | void;
  deliver: (descriptor: SessionVisibilityDeliveryDescriptor) => Promise<void> | void;
  resolveReservedMutation?: (
    intent: SessionVisibilityMutationIntent,
  ) => Promise<'committed' | 'aborted' | 'pending' | 'unattributable'>;
}

const DEFAULT_RETRY_INTERVAL_MS = 1_000;
const DEFAULT_MAX_RETRY_INTERVAL_MS = 60_000;
const DEFAULT_MAX_ENTRIES_PER_FLUSH = 100;
const DEFAULT_COMPACTION_RECORD_THRESHOLD = 4_096;

function resolveOutboxPath(options: SessionVisibilityConvergenceOutboxOptions): string {
  if (options.filePath) return options.filePath;
  if (options.storageRoot) {
    return path.join(
      options.storageRoot,
      'session-visibility',
      'convergence.jsonl',
    );
  }
  throw new Error('Session visibility convergence storage root is required');
}

function isStandaloneEntry(value: unknown): value is StandaloneEntry {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<StandaloneEntry>;
  return typeof candidate.id === 'string' &&
    (candidate.kind === 'audit' || candidate.kind === 'delivery') &&
    Boolean(candidate.payload && typeof candidate.payload === 'object');
}

function isMutationEntry(value: unknown): value is MutationEntry {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<MutationEntry>;
  return candidate.kind === 'mutation' &&
    typeof candidate.id === 'string' &&
    (candidate.phase === 'reserved' || candidate.phase === 'committed') &&
    typeof candidate.auditPending === 'boolean' &&
    typeof candidate.deliveryPending === 'boolean' &&
    Boolean(candidate.payload && typeof candidate.payload === 'object');
}

/**
 * Fsync-backed convergence journal with an explicit reservation/commit
 * lifecycle. Only one flush can run at a time. Failed entries use bounded
 * exponential backoff and a bounded batch, while successful siblings continue.
 */
export class SessionVisibilityConvergenceOutbox {
  private readonly filePath: string;
  private readonly retryIntervalMs: number;
  private readonly maxRetryIntervalMs: number;
  private readonly maxEntriesPerFlush: number;
  private readonly compactionRecordThreshold: number;
  private readonly now: () => number;
  private readonly auditHandler: SessionVisibilityConvergenceOutboxOptions['audit'];
  private readonly deliveryHandler: SessionVisibilityConvergenceOutboxOptions['deliver'];
  private readonly resolveReservedMutation?: SessionVisibilityConvergenceOutboxOptions['resolveReservedMutation'];
  private readonly pending = new Map<string, PendingRuntimeEntry>();
  private started: Promise<void> | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private journalTail: Promise<void> = Promise.resolve();
  private flushInFlight: Promise<void> | null = null;
  private closed = false;
  private journalRecordCount = 0;

  constructor(options: SessionVisibilityConvergenceOutboxOptions) {
    this.filePath = resolveOutboxPath(options);
    this.retryIntervalMs = Math.max(10, options.retryIntervalMs ?? DEFAULT_RETRY_INTERVAL_MS);
    this.maxRetryIntervalMs = Math.max(
      this.retryIntervalMs,
      options.maxRetryIntervalMs ?? DEFAULT_MAX_RETRY_INTERVAL_MS,
    );
    this.maxEntriesPerFlush = Math.max(1, options.maxEntriesPerFlush ?? DEFAULT_MAX_ENTRIES_PER_FLUSH);
    this.compactionRecordThreshold = Math.max(
      1,
      options.compactionRecordThreshold ?? DEFAULT_COMPACTION_RECORD_THRESHOLD,
    );
    this.now = options.now ?? Date.now;
    this.auditHandler = options.audit;
    this.deliveryHandler = options.deliver;
    this.resolveReservedMutation = options.resolveReservedMutation;
  }

  start(): Promise<void> {
    if (!this.started) {
      this.started = this.loadJournal().then(() => this.scheduleNextPendingRetry());
    }
    return this.started;
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    await (this.started ?? Promise.resolve());
    await (this.flushInFlight ?? Promise.resolve());
    await this.journalTail;
  }

  async reserveMutation(intent: SessionVisibilityMutationIntent): Promise<void> {
    await this.start();
    const id = `mutation:${intent.auditId}`;
    const entry: MutationEntry = {
      id,
      kind: 'mutation',
      payload: structuredClone(intent),
      phase: 'reserved',
      auditPending: true,
      deliveryPending: intent.delivery !== null,
    };
    await this.appendJournal({ action: 'reserve', entry });
    this.setPending(entry);
  }

  async markMutationCommitted(auditId: string): Promise<void> {
    await this.start();
    const id = `mutation:${auditId}`;
    await this.appendJournal({ action: 'commit', id });
    const runtime = this.pending.get(id);
    if (runtime?.entry.kind === 'mutation') runtime.entry.phase = 'committed';
  }

  async markMutationAborted(auditId: string): Promise<void> {
    await this.start();
    const id = `mutation:${auditId}`;
    await this.appendJournal({ action: 'abort', id });
    this.pending.delete(id);
  }

  async acknowledgeMutationAudit(auditId: string): Promise<void> {
    await this.acknowledgeMutationPart(auditId, 'auditAck');
  }

  async acknowledgeMutationDelivery(auditId: string): Promise<void> {
    await this.acknowledgeMutationPart(auditId, 'deliveryAck');
  }

  async enqueueAudit(event: SessionVisibilityAuditEvent): Promise<void> {
    await this.enqueue({
      id: `audit:${event.auditId}`,
      kind: 'audit',
      payload: structuredClone(event),
    });
  }

  async enqueueDelivery(descriptor: SessionVisibilityDeliveryDescriptor): Promise<void> {
    await this.enqueue({
      id: `delivery:${descriptor.auditId}`,
      kind: 'delivery',
      payload: structuredClone(descriptor),
    });
  }

  async pendingCount(): Promise<number> {
    await this.start();
    await this.journalTail;
    return this.pending.size;
  }

  pendingCountSync(): number {
    return this.pending.size;
  }

  flush(): Promise<void> {
    if (this.flushInFlight) return this.flushInFlight;
    const current = this.runFlush().finally(() => {
      if (this.flushInFlight === current) this.flushInFlight = null;
      this.scheduleNextPendingRetry();
    });
    this.flushInFlight = current;
    return current;
  }

  private async runFlush(): Promise<void> {
    await this.start();
    await this.journalTail;
    const now = this.now();
    const due = [...this.pending.values()]
      .filter((runtime) => runtime.nextAttemptAt <= now)
      .slice(0, this.maxEntriesPerFlush);
    for (const runtime of due) {
      if (!this.pending.has(runtime.entry.id)) continue;
      const failed = await this.processEntry(runtime.entry);
      if (!this.pending.has(runtime.entry.id)) continue;
      if (failed) {
        runtime.attempts += 1;
        runtime.nextAttemptAt = this.now() + Math.min(
          this.maxRetryIntervalMs,
          this.retryIntervalMs * (2 ** Math.min(runtime.attempts - 1, 16)),
        );
        await this.appendJournal({
          action: 'retry',
          id: runtime.entry.id,
          attempts: runtime.attempts,
          nextAttemptAt: runtime.nextAttemptAt,
        }).catch(() => undefined);
      } else {
        runtime.attempts = 0;
        runtime.nextAttemptAt = this.now();
      }
    }
  }

  private async processEntry(entry: OutboxEntry): Promise<boolean> {
    if (entry.kind === 'audit' || entry.kind === 'delivery') {
      try {
        if (entry.kind === 'audit') await this.auditHandler(structuredClone(entry.payload));
        else await this.deliveryHandler(structuredClone(entry.payload));
        await this.appendJournal({ action: 'ack', id: entry.id });
        this.pending.delete(entry.id);
        return false;
      } catch {
        return true;
      }
    }

    if (entry.phase === 'reserved') {
      if (!this.resolveReservedMutation) return true;
      try {
        const resolution = await this.resolveReservedMutation(structuredClone(entry.payload));
        if (resolution === 'pending') return true;
        if (resolution === 'unattributable') {
          await this.auditHandler({
            ...structuredClone(entry.payload.audit),
            outcome: 'failed',
            reasonCode: 'INTERNAL_ERROR',
          });
          await this.appendJournal({ action: 'abort', id: entry.id });
          this.pending.delete(entry.id);
          return false;
        }
        if (resolution === 'aborted') {
          await this.appendJournal({ action: 'abort', id: entry.id });
          this.pending.delete(entry.id);
          return false;
        }
        await this.appendJournal({ action: 'commit', id: entry.id });
        entry.phase = 'committed';
      } catch {
        return true;
      }
    }

    let failed = false;
    if (entry.auditPending) {
      try {
        await this.auditHandler(structuredClone(entry.payload.audit));
        await this.appendJournal({ action: 'auditAck', id: entry.id });
        entry.auditPending = false;
      } catch {
        failed = true;
      }
    }
    if (entry.deliveryPending && entry.payload.delivery) {
      try {
        await this.deliveryHandler(structuredClone(entry.payload.delivery));
        await this.appendJournal({ action: 'deliveryAck', id: entry.id });
        entry.deliveryPending = false;
      } catch {
        failed = true;
      }
    }
    if (!entry.auditPending && !entry.deliveryPending) this.pending.delete(entry.id);
    return failed;
  }

  private async acknowledgeMutationPart(
    auditId: string,
    action: 'auditAck' | 'deliveryAck',
  ): Promise<void> {
    await this.start();
    const id = `mutation:${auditId}`;
    await this.appendJournal({ action, id });
    const runtime = this.pending.get(id);
    if (runtime?.entry.kind !== 'mutation') return;
    if (action === 'auditAck') runtime.entry.auditPending = false;
    else runtime.entry.deliveryPending = false;
    if (!runtime.entry.auditPending && !runtime.entry.deliveryPending) this.pending.delete(id);
  }

  private async enqueue(entry: StandaloneEntry): Promise<void> {
    await this.start();
    await this.appendJournal({ action: 'put', entry });
    this.setPending(entry);
    this.scheduleRetry(0);
  }

  private setPending(entry: OutboxEntry): void {
    this.pending.set(entry.id, { entry, attempts: 0, nextAttemptAt: this.now() });
  }

  private async loadJournal(): Promise<void> {
    let content: Buffer;
    try {
      content = await readFile(this.filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return;
    }

    const lastNewline = content.lastIndexOf(0x0a);
    const safeLength = lastNewline + 1;
    const durable = content.subarray(0, safeLength).toString('utf8');
    for (const line of durable.split('\n')) {
      if (line.trim()) {
        this.applyJournalRecord(JSON.parse(line) as JournalRecord);
        this.journalRecordCount += 1;
      }
    }

    const tail = content.subarray(safeLength).toString('utf8');
    if (!tail.trim()) {
      await this.compactJournalIfNeeded();
      return;
    }
    let record: JournalRecord;
    try {
      record = JSON.parse(tail) as JournalRecord;
    } catch {
      await truncate(this.filePath, safeLength);
      await this.compactJournalIfNeeded();
      return;
    }
    this.applyJournalRecord(record);
    this.journalRecordCount += 1;
    const handle = await open(this.filePath, 'a');
    try {
      await handle.appendFile('\n', 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await this.compactJournalIfNeeded();
  }

  private applyJournalRecord(record: JournalRecord): void {
    if (record.action === 'put') {
      if (!isStandaloneEntry(record.entry)) throw new Error('invalid convergence journal entry');
      this.setPending(record.entry);
      return;
    }
    if (record.action === 'reserve') {
      if (!isMutationEntry(record.entry)) throw new Error('invalid convergence mutation entry');
      this.setPending(record.entry);
      return;
    }
    if (record.action === 'ack' || record.action === 'abort') {
      this.pending.delete(record.id);
      return;
    }
    const runtime = this.pending.get(record.id);
    if (!runtime) return;
    if (record.action === 'retry') {
      runtime.attempts = Math.max(0, record.attempts);
      runtime.nextAttemptAt = Math.max(0, record.nextAttemptAt);
      return;
    }
    if (runtime.entry.kind !== 'mutation') return;
    if (record.action === 'commit') runtime.entry.phase = 'committed';
    else if (record.action === 'auditAck') runtime.entry.auditPending = false;
    else if (record.action === 'deliveryAck') runtime.entry.deliveryPending = false;
    if (!runtime.entry.auditPending && !runtime.entry.deliveryPending) this.pending.delete(record.id);
  }

  private appendJournal(record: JournalRecord): Promise<void> {
    const append = async () => {
      await mkdir(path.dirname(this.filePath), { recursive: true });
      const handle = await open(this.filePath, 'a');
      try {
        await handle.appendFile(`${JSON.stringify(record)}\n`, 'utf8');
        await handle.sync();
        this.journalRecordCount += 1;
      } finally {
        await handle.close();
      }
    };
    const current = this.journalTail.then(append, append);
    this.journalTail = current.catch(() => undefined);
    return current;
  }

  /**
   * Startup-only compaction replaces the complete history with an atomic
   * snapshot of every nonterminal obligation and its durable retry deadline.
   * No required entry is discarded and terminal history cannot be replayed.
   */
  private async compactJournalIfNeeded(): Promise<void> {
    if (this.journalRecordCount < this.compactionRecordThreshold) return;
    const records: JournalRecord[] = [];
    for (const runtime of this.pending.values()) {
      records.push(runtime.entry.kind === 'mutation'
        ? { action: 'reserve', entry: runtime.entry }
        : { action: 'put', entry: runtime.entry });
      if (runtime.attempts > 0 || runtime.nextAttemptAt > this.now()) {
        records.push({
          action: 'retry',
          id: runtime.entry.id,
          attempts: runtime.attempts,
          nextAttemptAt: runtime.nextAttemptAt,
        });
      }
    }

    await mkdir(path.dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${process.pid}.${this.now()}.tmp`;
    try {
      const handle = await open(temporaryPath, 'w');
      try {
        const content = records.map((record) => JSON.stringify(record)).join('\n');
        if (content) await handle.writeFile(`${content}\n`, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporaryPath, this.filePath);
      try {
        const directory = await open(path.dirname(this.filePath), 'r');
        try {
          await directory.sync();
        } finally {
          await directory.close();
        }
      } catch {
        // Windows does not permit directory handles; same-directory rename is
        // still atomic and the replacement file itself has already been fsynced.
      }
      this.journalRecordCount = records.length;
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
  }

  private scheduleRetry(delayMs: number): void {
    if (this.closed || this.retryTimer || this.pending.size === 0) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.flush();
    }, Math.max(0, delayMs));
    this.retryTimer.unref?.();
  }

  private scheduleNextPendingRetry(): void {
    if (this.closed || this.pending.size === 0) return;
    const earliest = Math.min(...[...this.pending.values()].map((entry) => entry.nextAttemptAt));
    this.scheduleRetry(Math.max(0, earliest - this.now()));
  }
}
