import { codexQuestionTurns } from './codexQuestionTurns';
import { cancelTurnSetup, hasActiveTurnSetup, TurnSetupCancelledError } from './turnSetupStages';
import type { DriveOutcome } from './QueueDriveService';

export class TurnControlPendingError extends TurnSetupCancelledError {
  constructor(quarantined = false) {
    super();
    this.message = quarantined
      ? 'This session is recovering a stuck save. Your text and attachments are kept in the composer. Restart the app to clear recovery; queued text is preserved.'
      : 'Cancellation is still finishing. Your message is back in the composer. Stop again to retry; if this persists, reopen the session.';
  }
}

export interface SessionTurn {
  cancelled: boolean;
  providerEntered?: boolean;
  deliveryMayHaveStarted?: boolean;
  controlDecision?: Promise<boolean>;
  finished: Promise<void>;
  finish(): void;
}

const turns = new Map<string, Set<SessionTurn>>();
const controls = new Map<string, {
  result: Promise<TurnControlResult>;
  stop(explicit?: boolean): void;
  fenced: boolean;
  sequence: number;
}>();

const postControlDrives = new Map<string, Set<symbol>>();

export function isDirectTurnAdmissionBlocked(sessionId: string): boolean {
  return isTurnAdmissionBlocked(sessionId) || controls.has(sessionId) || postControlDrives.has(sessionId);
}

interface TurnRecovery {
  pending: Set<Promise<unknown>>;
  resume: { sequence: number; run(): Promise<void> };
  retired: Promise<void>;
}
const recoveries = new Map<string, TurnRecovery>();
let controlSequence = 0;

/** Join overlapping timeouts; the newest control owns cleanup after all retire. */
function retainTurnRecovery(
  sessionId: string,
  pending: Promise<unknown>[],
  sequence: number,
  resume: () => Promise<void>,
  logError: (error: unknown) => void,
): void {
  const existing = recoveries.get(sessionId);
  if (existing) {
    for (const work of pending) existing.pending.add(work);
    if (sequence > existing.resume.sequence) existing.resume = { sequence, run: resume };
    return;
  }
  let resolveRetired!: () => void;
  const recovery: TurnRecovery = {
    pending: new Set(pending), resume: { sequence, run: resume },
    retired: new Promise<void>(resolve => { resolveRetired = resolve; }),
  };
  recoveries.set(sessionId, recovery);
  void (async () => {
    while (recovery.pending.size) {
      const batch = [...recovery.pending];
      await Promise.allSettled(batch);
      for (const work of batch) recovery.pending.delete(work);
    }
    if (recoveries.get(sessionId) !== recovery) return;
    recoveries.delete(sessionId);
    resolveRetired();
    // A newer live control already owns cleanup and its eventual drive.
    if ((controls.get(sessionId)?.sequence ?? -1) > recovery.resume.sequence) return;
    await recovery.resume.run();
  })().catch(logError);
}

/** A timed-out operation remains live until actual retirement or app restart. */
export function isTurnRecoveryQuarantined(sessionId: string): boolean {
  return recoveries.has(sessionId);
}

export function isTurnAdmissionBlocked(sessionId: string): boolean {
  return isTurnControlPending(sessionId) || recoveries.has(sessionId);
}

export function isTurnControlPending(sessionId: string): boolean {
  return controls.get(sessionId)?.fenced === true;
}

/** A host invocation still owns this session, including a waiting tool call. */
export function hasActiveSessionTurn(sessionId: string): boolean {
  return (turns.get(sessionId)?.size ?? 0) > 0;
}

/** Registration and the control fence check are synchronous. */
export function beginSessionTurn(sessionId: string): SessionTurn {
  if (isTurnAdmissionBlocked(sessionId)) throw new TurnControlPendingError(isTurnRecoveryQuarantined(sessionId));
  let resolve!: () => void;
  const finished = new Promise<void>(done => { resolve = done; });
  const active = turns.get(sessionId) ?? new Set<SessionTurn>();
  const turn: SessionTurn = {
    cancelled: false,
    finished,
    finish() {
      active.delete(turn);
      if (active.size === 0 && turns.get(sessionId) === active) turns.delete(sessionId);
      resolve();
    },
  };
  active.add(turn);
  turns.set(sessionId, active);
  return turn;
}

export function assertSessionTurnActive(turn: SessionTurn | undefined): void {
  if (turn?.cancelled) throw new TurnSetupCancelledError();
}

/** A pending control pauses setup reversibly until its provider accepts or refuses. */
export async function awaitSessionTurnControl(turn: SessionTurn | undefined): Promise<void> {
  while (turn?.controlDecision) {
    const decision = turn.controlDecision;
    await decision;
    if (turn.controlDecision === decision) turn.controlDecision = undefined;
  }
  assertSessionTurnActive(turn);
}

interface ControlledProvider {
  abort(): void;
  interruptCurrentTurn(): Promise<{ method: 'interrupt' | 'abort'; hadActiveTurn?: boolean }>;
}

export interface TurnControlResult {
  success: boolean;
  method?: 'interrupt' | 'abort';
  error?: string;
  warning?: string;
  forcedIdle?: boolean;
}

interface TurnControlOptions {
  sessionId: string;
  mode: 'stop' | 'interrupt';
  provider: ControlledProvider | null | undefined;
  isCurrentProvider(): boolean;
  guard: Pick<Set<string>, 'delete'>;
  retireInbox(): Promise<void>;
  sweep(): Promise<void>;
  settle(): Promise<void>;
  drive(): Promise<DriveOutcome | void>;
  /** Schedule the queue's durable retry loop after a provider replacement. */
  requestDrive?(): boolean;
  invalidateDrive?(expected?: Promise<DriveOutcome | void>): void;
  logError(error: unknown): void;
  timeouts?: { interruptMs?: number; stageMs?: number };
}

class TurnControlTimeoutError extends Error {}

async function bounded<T>(work: Promise<T>, label: string, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new TurnControlTimeoutError(
        `Cancellation timed out during ${label}. This session is recovering a stuck save. Your queued text is preserved; rejected text and attachments stay in the composer. Restart the app to clear recovery.`,
      )), milliseconds);
    })]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}

/** Desktop controls share one captured operation; Stop escalates a graceful one. */
export function performTurnInterruption(options: TurnControlOptions, progress: { retired: boolean; swept: boolean; settled: boolean; failure?: unknown } = { retired: false, swept: false, settled: false }): Promise<TurnControlResult> {
  const { sessionId, provider } = options;
  if (recoveries.has(sessionId)) {
    try {
      if (options.isCurrentProvider()) {
        provider?.abort();
        cancelTurnSetup(sessionId);
        for (const turn of turns.get(sessionId) ?? []) turn.cancelled = true;
      }
    }
    catch (error) { options.logError(error); }
    return Promise.resolve({ success: false, error: new TurnControlPendingError(true).message });
  }
  if (postControlDrives.has(sessionId) && !(turns.get(sessionId)?.size)) {
    return Promise.resolve({ success: false, error: 'The previous queue drive is still starting. Your message remains queued.' });
  }
  const existing = controls.get(sessionId);
  if (existing) {
    if (!existing.fenced) {
      // The first control has retired; a new control targets any successor its
      // drive is currently claiming or running, rather than being swallowed.
      if (!(turns.get(sessionId)?.size)) return Promise.resolve({ success: false, error: 'The previous queue drive is still starting. Your message remains queued.' });
    } else {
      if (options.mode === 'stop') existing.stop(true);
      return existing.result;
    }
  }
  if (!options.isCurrentProvider()) return Promise.resolve({ success: false, error: 'The session provider was replaced.' });
  const sequence = ++controlSequence;

  const captured = [...(turns.get(sessionId) ?? [])];
  const question = codexQuestionTurns.current(sessionId);
  // An active unregistered setup is a proven in-progress owner. A provider
  // object alone is cached state; orphan recovery aborts it before cleanup.
  if (captured.length === 0 && hasActiveTurnSetup(sessionId)) {
    return Promise.resolve({ success: false, error: 'An active setup has no owned host invocation. Stop again to retry; if this persists, reopen the session.' });
  }
  let hard = options.mode === 'stop' || captured.length === 0;
  let stopRequested = options.mode === 'stop';
  let turnStopped = false;
  let driving = false;
  let abortCalled = false;
  let resolveHard!: (value: { method: 'abort' }) => void;
  let rejectHard!: (error: unknown) => void;
  const hardResult = new Promise<{ method: 'abort' }>((resolve, reject) => { resolveHard = resolve; rejectHard = reject; });
  // A rejected escalation is also observed before the operation starts.
  void hardResult.catch(() => {});
  const stop = (explicit = false) => {
    if (explicit) stopRequested = true;
    if (driving) return;
    hard = true;
    if (abortCalled) return;
    abortCalled = true;
    try {
      if (!options.isCurrentProvider()) throw new Error('The session provider was replaced.');
      provider?.abort();
      resolveHard({ method: 'abort' });
    } catch (error) { rejectHard(error); }
  };

  let resolveResult!: (result: TurnControlResult) => void;
  let resolveDecision!: (accepted: boolean) => void;
  const decision = new Promise<boolean>(resolve => { resolveDecision = resolve; });
  const operation = { result: new Promise<TurnControlResult>(resolve => { resolveResult = resolve; }), stop, fenced: true, sequence };
  controls.set(sessionId, operation);
  let reservedDrive: Promise<DriveOutcome | void> | undefined;
  const driveReserved = async () => {
    const token = Symbol(sessionId);
    const activeDrives = postControlDrives.get(sessionId) ?? new Set<symbol>();
    activeDrives.add(token);
    postControlDrives.set(sessionId, activeDrives);
    try {
      reservedDrive = options.drive();
      return await reservedDrive;
    }
    finally {
      activeDrives.delete(token);
      if (activeDrives.size === 0 && postControlDrives.get(sessionId) === activeDrives) postControlDrives.delete(sessionId);
    }
  };
  const pendingSteps = new Set<Promise<unknown>>();
  let timedOutDuringDrive = false;
  let providerReplaced = false;
  let replacementDriveIssued = false;
  const step = async <T>(label: string, work: () => Promise<T>): Promise<T> => {
    const pending = Promise.resolve().then(work);
    pendingSteps.add(pending);
    void pending.then(() => pendingSteps.delete(pending), () => pendingSteps.delete(pending));
    return bounded(pending, label, options.timeouts?.stageMs ?? 10_000);
  };
  const issueReplacementDrive = (): boolean => {
    if (replacementDriveIssued) return true;
    if (!progress.swept || !progress.settled || progress.failure) return false;
    // A replacement drive belongs to the new provider. Release this control's
    // fence before handing the session to the retrying queue driver.
    driving = true;
    operation.fenced = false;
    if (controls.get(sessionId) === operation) controls.delete(sessionId);
    try { replacementDriveIssued = options.requestDrive?.() ?? false; }
    catch (error) { options.logError(error); }
    return replacementDriveIssued;
  };
  const run = async (): Promise<TurnControlResult> => {
    try {
      if (!options.isCurrentProvider()) throw new Error('The session provider was replaced.');
      for (const turn of captured) turn.controlDecision = decision;
      let action: Promise<{ method: 'interrupt' | 'abort'; hadActiveTurn?: boolean }>;
      if (hard || !provider) {
        stop();
        action = hardResult;
      } else {
        action = Promise.race([provider.interruptCurrentTurn(), hardResult]);
      }
      let result: { method: 'interrupt' | 'abort'; hadActiveTurn?: boolean };
      try { result = await bounded(action, 'provider interrupt', options.timeouts?.interruptMs ?? 5_000); }
      catch (error) {
        if (!(error instanceof TurnControlTimeoutError) || hard) throw error;
        stop();
        result = await hardResult;
      }
      cancelTurnSetup(sessionId);
      options.invalidateDrive?.();
      for (const turn of captured) turn.cancelled = true;
      resolveDecision(true);
      // Only an accepted control can abandon a live question. Production
      // stream cleanup, rather than this call, owns host-turn retirement.
      codexQuestionTurns.abandonWaiters(question);
      await bounded(Promise.all(captured.map(turn => turn.finished)), 'host retirement', options.timeouts?.stageMs ?? 10_000);
      turnStopped = true;
      providerReplaced = !options.isCurrentProvider();
      if (!progress.retired) {
        const retired = await step('inbox and question retirement', async () => {
          const results = await Promise.allSettled([codexQuestionTurns.end(question), options.retireInbox()]);
          progress.retired = true;
          return results;
        });
        for (const outcome of retired) if (outcome.status === 'rejected') options.logError(outcome.reason);
      }
      try {
        if (!progress.swept && !progress.failure) await step('queue cleanup', async () => { await options.sweep(); progress.swept = true; });
      } catch (error) {
        // A timed-out write is still live. Its recovery continuation owns
        // guard release and idle after that exact write has actually settled.
        if (error instanceof TurnControlTimeoutError) throw error;
        progress.failure = error;
        options.guard.delete(sessionId);
        await step('session settlement', async () => { await options.settle(); progress.settled = true; });
        throw error;
      }
      options.guard.delete(sessionId);
      if (!progress.settled) await step('session settlement', async () => { await options.settle(); progress.settled = true; });
      if (progress.failure) throw progress.failure;
      if (providerReplaced) {
        return issueReplacementDrive()
          ? { success: true, method: hard ? 'abort' : result.method,
              warning: 'The turn stopped and its queue was settled; queue drive was requested after the session provider was replaced.' }
          : { success: false, error: 'The turn stopped, but queued input could not be scheduled after the session provider was replaced.' };
      }
      // A superseded drive may time out while this control is cleaning up.
      // Keep our fence until that exact drive retires. Do not add this wait to
      // pendingSteps: a timeout joins that recovery, so doing so would self-wait.
      const earlierRecovery = recoveries.get(sessionId);
      if (earlierRecovery) await bounded(earlierRecovery.retired, 'earlier control retirement', options.timeouts?.stageMs ?? 10_000);
      // Release admission so this drive can claim its successor. A new
      // control may target that successor once its handle is registered.
      driving = true;
      operation.fenced = false;
      let driven: DriveOutcome | void;
      try { driven = await step('queue drive', driveReserved); }
      catch (error) { timedOutDuringDrive = true; throw error; }
      if (driven?.kind === 'failed' || driven?.kind === 'deferred') {
        const message = driven.kind === 'failed'
          ? 'The turn stopped, but the queued message could not start because the project is unavailable.'
          : driven.reason === 'queue-stopped'
            ? 'The turn stopped. Your message is still queued. Use Send Now or send a new message to resume.'
            : 'The turn stopped. Your message is still queued and will start when the session is ready.';
        return stopRequested
          ? { success: true, method: 'abort', warning: message }
          : { success: false, error: message };
      }
      return { success: true, method: hard ? 'abort' : result.method };
    } catch (error) {
      if (error instanceof TurnControlTimeoutError) {
        // Retire the timed-out driver generation synchronously. Pure reads
        // release their leases on abort; unknown claims/start writes retain
        // registered lifetimes until exact rollback has actually finished.
        if (timedOutDuringDrive) options.invalidateDrive?.(reservedDrive);
        const pending = [...pendingSteps, ...captured.map(turn => turn.finished),
          ...[...(turns.get(sessionId) ?? [])].map(turn => turn.finished)];
        retainTurnRecovery(sessionId, pending, sequence, async () => {
          // Retry only queue admission after a late drive. The existing driver
          // and exact claims coalesce it; never abort or sweep its successor.
          if (timedOutDuringDrive && options.isCurrentProvider()) {
            try {
              const retried = await bounded(driveReserved(), 'queue retry', options.timeouts?.stageMs ?? 10_000);
              if (retried?.kind === 'failed') options.logError(new Error('Queued input could not start after cancellation recovery.'));
            } catch (error) {
              if (error instanceof TurnControlTimeoutError) {
                options.invalidateDrive?.(reservedDrive);
                const writers = [...(turns.get(sessionId) ?? [])];
                // Retain the exact retry drive as well as any registered host.
                // A newer Stop keeps cleanup ownership, but joins these lives.
                retainTurnRecovery(sessionId,
                  [...writers.map(turn => turn.finished), ...(reservedDrive ? [reservedDrive] : [])],
                  sequence, async () => {}, options.logError);
              }
              options.logError(error);
            }
          } else if (providerReplaced && progress.swept && progress.settled && !progress.failure) {
            // A bounded settlement may finish after Stop has returned. The
            // recovery fence is gone here; keep its pending rows on the
            // driver's idle/backoff net instead of requiring another Send.
            if (!issueReplacementDrive()) options.logError(new Error('Queued input could not be scheduled after provider replacement recovery.'));
          } else if (options.isCurrentProvider()) {
            // Recovery continues the original control; it is not a new human Stop.
            const resumed = await performTurnInterruption({ ...options, mode: 'stop' }, progress);
            if (!resumed.success) options.logError(new Error(resumed.error));
          }
        }, options.logError);
      }
      options.logError(error);
      const message = error instanceof Error ? error.message : 'Unable to interrupt the current turn.';
      if (providerReplaced && turnStopped && !replacementDriveIssued) {
        return { success: false, error: `The turn stopped, but queued input could not be scheduled after the provider was replaced: ${message}` };
      }
      return stopRequested && turnStopped
        ? { success: true, method: 'abort', warning: `The turn stopped, but cleanup is incomplete: ${message}` }
        : { success: false, error: message };
    } finally {
      resolveDecision(false);
      if (controls.get(sessionId) === operation) controls.delete(sessionId);
    }
  };
  void run().then(resolveResult, error => resolveResult({ success: false, error: String(error) }));
  return operation.result;
}
