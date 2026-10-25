import { codexQuestionTurns } from './codexQuestionTurns';
import { cancelTurnSetup, hasActiveTurnSetup, TurnSetupCancelledError } from './turnSetupStages';
import type { DriveOutcome } from './QueueDriveService';

export class TurnControlPendingError extends TurnSetupCancelledError {
  constructor() {
    super();
    this.message = 'Cancellation is still finishing. Your message is back in the composer. Stop again to retry; if this persists, reopen the session.';
  }
}

export interface SessionTurn {
  cancelled: boolean;
  providerEntered?: boolean;
  controlDecision?: Promise<boolean>;
  finished: Promise<void>;
  finish(): void;
}

const turns = new Map<string, Set<SessionTurn>>();
const controls = new Map<string, {
  result: Promise<TurnControlResult>;
  stop(): void;
  fenced: boolean;
}>();

const postControlDrives = new Map<string, Set<symbol>>();

export function isDirectTurnAdmissionBlocked(sessionId: string): boolean {
  return isTurnAdmissionBlocked(sessionId) || controls.has(sessionId) || postControlDrives.has(sessionId);
}

const recoveries = new Map<string, { finished: Promise<void> }>();

export function isTurnAdmissionBlocked(sessionId: string): boolean {
  return isTurnControlPending(sessionId) || recoveries.has(sessionId);
}

export function isTurnControlPending(sessionId: string): boolean {
  return controls.get(sessionId)?.fenced === true;
}

/** Registration and the control fence check are synchronous. */
export function beginSessionTurn(sessionId: string): SessionTurn {
  if (isTurnAdmissionBlocked(sessionId)) throw new TurnControlPendingError();
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
        `Cancellation timed out during ${label}. Your message remains queued. Stop again to retry; if this persists, reopen the session.`,
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
    return Promise.resolve({ success: false, error: 'Cancellation is incomplete. Your message remains queued. Stop again to retry; if this persists, reopen the session.' });
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
      if (options.mode === 'stop') existing.stop();
      return existing.result;
    }
  }
  if (!options.isCurrentProvider()) return Promise.resolve({ success: false, error: 'The session provider was replaced.' });

  const captured = [...(turns.get(sessionId) ?? [])];
  const question = codexQuestionTurns.current(sessionId);
  // An active unregistered setup is a proven in-progress owner. A provider
  // object alone is cached state; orphan recovery aborts it before cleanup.
  if (captured.length === 0 && hasActiveTurnSetup(sessionId)) {
    return Promise.resolve({ success: false, error: 'An active setup has no owned host invocation. Stop again to retry; if this persists, reopen the session.' });
  }
  let hard = options.mode === 'stop' || captured.length === 0;
  let driving = false;
  let abortCalled = false;
  let resolveHard!: (value: { method: 'abort' }) => void;
  let rejectHard!: (error: unknown) => void;
  const hardResult = new Promise<{ method: 'abort' }>((resolve, reject) => { resolveHard = resolve; rejectHard = reject; });
  // A rejected escalation is also observed before the operation starts.
  void hardResult.catch(() => {});
  const stop = () => {
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
  const operation = { result: new Promise<TurnControlResult>(resolve => { resolveResult = resolve; }), stop, fenced: true };
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
  const step = async <T>(label: string, work: () => Promise<T>): Promise<T> => {
    const pending = Promise.resolve().then(work);
    pendingSteps.add(pending);
    void pending.then(() => pendingSteps.delete(pending), () => pendingSteps.delete(pending));
    return bounded(pending, label, options.timeouts?.stageMs ?? 10_000);
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
      if (!options.isCurrentProvider()) throw new Error('The session provider was replaced during cancellation.');
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
      // Release admission so this drive can claim its successor. A new
      // control may target that successor once its handle is registered.
      driving = true;
      operation.fenced = false;
      let driven: DriveOutcome | void;
      try { driven = await step('queue drive', driveReserved); }
      catch (error) { timedOutDuringDrive = true; throw error; }
      if (driven?.kind === 'failed') return { success: false, error: 'The turn stopped, but the queued message could not start because the project is unavailable.' };
      if (driven?.kind === 'deferred') return { success: false, error: 'The turn stopped. Your message is still queued and will start when the session is ready.' };
      return { success: true, method: hard ? 'abort' : result.method };
    } catch (error) {
      if (error instanceof TurnControlTimeoutError) {
        // Retire the timed-out driver generation synchronously. Pure reads
        // release their leases on abort; unknown claims/start writes retain
        // registered lifetimes until exact rollback has actually finished.
        if (timedOutDuringDrive) options.invalidateDrive?.(reservedDrive);
        const pending = [...pendingSteps, ...captured.map(turn => turn.finished),
          ...[...(turns.get(sessionId) ?? [])].map(turn => turn.finished)];
        const recovery = { finished: Promise.resolve() };
        recoveries.set(sessionId, recovery);
        recovery.finished = Promise.allSettled(pending).then(async () => {
          if (recoveries.get(sessionId) !== recovery) return;
          recoveries.delete(sessionId);
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
                const retryRecovery = { finished: Promise.resolve() };
                // A newer Stop may already own recovery for these writers.
                if (!recoveries.has(sessionId)) recoveries.set(sessionId, retryRecovery);
                retryRecovery.finished = Promise.allSettled(writers.map(turn => turn.finished)).then(() => {
                  if (recoveries.get(sessionId) === retryRecovery) recoveries.delete(sessionId);
                });
              }
              options.logError(error);
            }
          } else if (options.isCurrentProvider()) {
            const resumed = await performTurnInterruption({ ...options, mode: 'stop' }, progress);
            if (!resumed.success) options.logError(new Error(resumed.error));
          }
        }).catch(options.logError);
      }
      options.logError(error);
      return { success: false, error: error instanceof Error ? error.message : 'Unable to interrupt the current turn.' };
    } finally {
      resolveDecision(false);
      if (controls.get(sessionId) === operation) controls.delete(sessionId);
    }
  };
  void run().then(resolveResult, error => resolveResult({ success: false, error: String(error) }));
  return operation.result;
}
