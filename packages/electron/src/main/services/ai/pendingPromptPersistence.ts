/**
 * Authoritative persistence for the per-session interactive-prompt state.
 *
 * Writes are serialized per session and clears may carry an expected prompt
 * identity. That prevents a delayed answer/cancel for prompt A from clearing a
 * newer prompt B. Every caller receives a structured local + sync result; no
 * path silently claims that a failed clear was durable.
 */

import { AISessionsRepository } from '@nimbalyst/runtime';
import { getSessionStateManager } from '@nimbalyst/runtime/ai/server/SessionStateManager';
import { getSyncProvider } from '../SyncManager';
import { logger } from '../../utils/logger';
import {
  compareUpdateSessionMetadataWithHostControlAuthority,
  type HostControlMetadataCleanupAuthority,
} from '../PGLiteSessionStore';

export interface PendingPromptPersistenceOptions {
  /** Identity to persist when opening a prompt. */
  promptId?: string;
  /** Turn generation to persist with a newly opened prompt. */
  generation?: string;
  /** Clear only if this is still the current prompt identity. */
  expectedPromptId?: string;
  /** Clear only if this is still the prompt opened by the settled turn. */
  expectedGeneration?: string;
  /** Exact durable Jean cleanup claim consumed by the local metadata UPDATE. */
  durableCleanupAuthority?: HostControlMetadataCleanupAuthority;
}

export interface PendingPromptPersistenceStep {
  attempted: boolean;
  succeeded: boolean;
  skippedReason: string | null;
  error?: string;
}

export interface PendingPromptPersistenceResult {
  sessionId: string;
  hasPendingPrompt: boolean;
  promptId: string | null;
  generation: string | null;
  applied: boolean;
  superseded: boolean;
  local: PendingPromptPersistenceStep;
  sync: PendingPromptPersistenceStep;
  /** True only when the local write and encrypted index frame write succeeded. */
  fullyPropagated: boolean;
}

export interface PendingPromptActionOwnership {
  sessionId: string;
  promptId: string;
  matchedPendingPrompt: boolean;
  attentionGeneration: string | null;
  readSucceeded: boolean;
}

export interface CapturePendingPromptActionOwnershipDeps {
  getSession: (sessionId: string) => Promise<{ metadata?: unknown } | null | undefined>;
}

export interface PromptActionCurrentGenerationDeps {
  getCurrentGeneration: (sessionId: string) => string | null;
}

const sessionLockTails = new Map<string, Promise<void>>();

function boundedError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 500 ? `${message.slice(0, 497)}...` : message;
}

export function readPendingPromptIdentity(metadata: unknown): {
  hasPendingPrompt: boolean;
  promptId?: string;
  generation?: string;
} {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return { hasPendingPrompt: false };
  }
  const record = metadata as Record<string, unknown>;
  const promptId = record.pendingPromptId;
  const generation = record.pendingPromptGeneration;
  return {
    hasPendingPrompt: record.hasPendingPrompt === true,
    ...(typeof promptId === 'string' && promptId ? { promptId } : {}),
    ...(typeof generation === 'string' && generation ? { generation } : {}),
  };
}

/**
 * Consume a claimed Jean prompt-cleanup phase without re-entering the
 * per-session serializer. This narrow entry is intentionally unavailable to
 * ordinary prompt writers: it couples the exact-A metadata transition to the
 * durable receipt phase in one native transaction.
 */
export async function completeAppliedJeanPromptCleanup(input: {
  sessionId: string;
  eventIdentity: string;
  attentionGeneration: string;
  durableCleanupAuthority: HostControlMetadataCleanupAuthority;
}): Promise<'complete' | 'not_owned' | 'invalid_state'> {
  if (!input.sessionId || !input.eventIdentity || !input.attentionGeneration
    || input.durableCleanupAuthority.step !== 'prompt'
    || input.durableCleanupAuthority.attentionGeneration !== input.attentionGeneration) {
    return 'invalid_state';
  }
  const session = await AISessionsRepository.get(input.sessionId);
  const expectedMetadata = session?.metadata && typeof session.metadata === 'object'
    && !Array.isArray(session.metadata) ? session.metadata as Record<string, unknown> : null;
  if (!expectedMetadata) return 'invalid_state';
  const pending = readPendingPromptIdentity(expectedMetadata);
  const exactA = pending.hasPendingPrompt
    && pending.promptId === input.eventIdentity
    && pending.generation === input.attentionGeneration;
  if (pending.hasPendingPrompt && (!pending.promptId || !pending.generation)) return 'invalid_state';
  const nextMetadata = exactA ? {
    ...expectedMetadata,
    hasPendingPrompt: false,
    pendingPromptId: null,
    pendingPromptGeneration: null,
  } : expectedMetadata;
  try {
    const committed = await compareUpdateSessionMetadataWithHostControlAuthority({
      sessionId: input.sessionId,
      expectedMetadata,
      nextMetadata,
      authority: input.durableCleanupAuthority,
      promptResult: exactA ? 'cleared' : 'already_absent',
      promptEventIdentity: input.eventIdentity,
    });
    return committed ? 'complete' : 'not_owned';
  } catch {
    return 'not_owned';
  }
}

function boundedGeneration(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized && normalized.length <= 300 ? normalized : null;
}

function currentAttentionGeneration(sessionId: string): string | null {
  return boundedGeneration(
    getSessionStateManager().getSessionState(sessionId)?.attentionGeneration,
  );
}

const defaultCaptureOwnershipDeps: CapturePendingPromptActionOwnershipDeps = {
  getSession: (sessionId) => AISessionsRepository.get(sessionId),
};

const defaultCurrentGenerationDeps: PromptActionCurrentGenerationDeps = {
  getCurrentGeneration: currentAttentionGeneration,
};

/**
 * Snapshot the exact durable prompt identity before a delayed renderer action
 * performs any asynchronous persistence or waiter delivery. Missing identity,
 * missing generation, and read failure are all represented explicitly so
 * callers can preserve exact response delivery while failing closed for
 * generation-wide side effects.
 */
export async function capturePendingPromptActionOwnership(
  sessionId: string,
  promptId: string,
  deps: CapturePendingPromptActionOwnershipDeps = defaultCaptureOwnershipDeps,
): Promise<PendingPromptActionOwnership> {
  const normalizedPromptId = typeof promptId === 'string' ? promptId.trim() : '';
  const unproven = (readSucceeded: boolean): PendingPromptActionOwnership => ({
    sessionId,
    promptId: normalizedPromptId,
    matchedPendingPrompt: false,
    attentionGeneration: null,
    readSucceeded,
  });
  if (!sessionId || !normalizedPromptId) return unproven(false);

  try {
    const session = await deps.getSession(sessionId);
    const identity = readPendingPromptIdentity(session?.metadata);
    const attentionGeneration = boundedGeneration(identity.generation);
    const matchedPendingPrompt = Boolean(
      identity.hasPendingPrompt &&
      identity.promptId === normalizedPromptId &&
      attentionGeneration
    );
    return {
      sessionId,
      promptId: normalizedPromptId,
      matchedPendingPrompt,
      attentionGeneration: matchedPendingPrompt ? attentionGeneration : null,
      readSucceeded: true,
    };
  } catch (error) {
    logger.main.warn(
      `[pendingPromptPersistence] Failed to capture prompt ownership for ${sessionId}/${normalizedPromptId}:`,
      error,
    );
    return unproven(false);
  }
}

/**
 * Re-check only the current in-memory generation immediately before a
 * generation-wide action. A durable generation is enough when no active state
 * exists (restart/orphan recovery); an active state must match exactly.
 */
export function promptActionOwnsCurrentGeneration(
  ownership: PendingPromptActionOwnership,
  deps: PromptActionCurrentGenerationDeps = defaultCurrentGenerationDeps,
): boolean {
  if (
    !ownership.readSucceeded ||
    !ownership.matchedPendingPrompt ||
    !ownership.attentionGeneration
  ) {
    return false;
  }
  const currentGeneration = boundedGeneration(
    deps.getCurrentGeneration(ownership.sessionId),
  );
  return currentGeneration === null || currentGeneration === ownership.attentionGeneration;
}

async function withSessionLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
  const previousTail = sessionLockTails.get(sessionId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  const nextTail = previousTail.then(() => current);
  sessionLockTails.set(sessionId, nextTail);
  await previousTail;
  try {
    return await fn();
  } finally {
    release();
    if (sessionLockTails.get(sessionId) === nextTail) sessionLockTails.delete(sessionId);
  }
}

async function setSessionPendingPromptInternal(
  sessionId: string,
  hasPendingPrompt: boolean,
  options: PendingPromptPersistenceOptions = {},
  acquireLock = true,
): Promise<PendingPromptPersistenceResult> {
  const promptId = hasPendingPrompt ? options.promptId?.trim() || null : null;
  const explicitGeneration = boundedGeneration(options.generation);
  let generation = hasPendingPrompt
    ? explicitGeneration || currentAttentionGeneration(sessionId)
    : null;
  const emptyStep = (reason: string): PendingPromptPersistenceStep => ({
    attempted: false,
    succeeded: false,
    skippedReason: reason,
  });
  if (!sessionId) {
    return {
      sessionId,
      hasPendingPrompt,
      promptId,
      generation,
      applied: false,
      superseded: false,
      local: emptyStep('session_id_missing'),
      sync: emptyStep('session_id_missing'),
      fullyPropagated: false,
    };
  }

  const persist = async (): Promise<PendingPromptPersistenceResult> => {
    if (hasPendingPrompt && !explicitGeneration) {
      const stateManager = getSessionStateManager();
      const state = stateManager.getSessionState(sessionId);
      if (state?.status === 'idle' || state?.status === 'error') {
        // A prompt can arrive before the long-lived CLI PID file reports the
        // next running transition. Rotate synchronously at this real prompt
        // boundary so a queued terminal event from turn A cannot own prompt B.
        await stateManager.updateActivity({
          sessionId,
          status: 'waiting_for_input',
          isStreaming: false,
        });
        generation = currentAttentionGeneration(sessionId);
      }
    }
    const expectedGeneration = boundedGeneration(options.expectedGeneration);
    if (!hasPendingPrompt && (options.expectedPromptId || expectedGeneration)) {
      try {
        const session = await AISessionsRepository.get(sessionId);
        const current = readPendingPromptIdentity(session?.metadata);
        const promptMismatch = Boolean(
          options.expectedPromptId &&
          current.promptId &&
          current.promptId !== options.expectedPromptId
        );
        const generationMismatch = Boolean(
          expectedGeneration &&
          current.hasPendingPrompt &&
          current.generation !== expectedGeneration
        );
        if (promptMismatch || generationMismatch) {
          return {
            sessionId,
            hasPendingPrompt,
            promptId,
            generation,
            applied: false,
            superseded: true,
            local: emptyStep('newer_prompt_is_pending'),
            sync: emptyStep('newer_prompt_is_pending'),
            fullyPropagated: false,
          };
        }
      } catch (error) {
        const message = boundedError(error);
        logger.main.warn(`[pendingPromptPersistence] Failed to verify prompt identity for ${sessionId}:`, error);
        return {
          sessionId,
          hasPendingPrompt,
          promptId,
          generation,
          applied: false,
          superseded: false,
          local: { attempted: true, succeeded: false, skippedReason: 'identity_read_failed', error: message },
          sync: emptyStep('local_identity_unverified'),
          fullyPropagated: false,
        };
      }
    }

    const local: PendingPromptPersistenceStep = {
      attempted: true,
      succeeded: false,
      skippedReason: null,
    };
    try {
      if (options.durableCleanupAuthority) {
        if (
          hasPendingPrompt
          || !options.expectedPromptId
          || !expectedGeneration
        ) {
          local.skippedReason = 'durable_cleanup_occurrence_mismatch';
        } else {
          const result = await completeAppliedJeanPromptCleanup({
            sessionId,
            eventIdentity: options.expectedPromptId,
            attentionGeneration: expectedGeneration,
            durableCleanupAuthority: options.durableCleanupAuthority,
          });
          local.succeeded = result === 'complete';
          if (!local.succeeded) local.skippedReason = result === 'invalid_state'
            ? 'durable_cleanup_occurrence_mismatch'
            : 'durable_cleanup_authority_lost';
        }
      } else {
        await AISessionsRepository.updateMetadata(sessionId, {
          metadata: {
            hasPendingPrompt,
            pendingPromptId: promptId,
            pendingPromptGeneration: generation,
          },
        });
        local.succeeded = true;
      }
    } catch (error) {
      local.skippedReason = 'local_persistence_failed';
      local.error = boundedError(error);
      logger.main.warn(
        `[pendingPromptPersistence] Failed to persist hasPendingPrompt=${hasPendingPrompt} for session ${sessionId}:`,
        error,
      );
    }

    const sync: PendingPromptPersistenceStep = {
      attempted: false,
      succeeded: false,
      skippedReason: null,
    };
    try {
      if (options.durableCleanupAuthority) {
        sync.skippedReason = 'durable_cleanup_local_only';
      } else {
      const provider = getSyncProvider();
      if (!provider) {
        sync.skippedReason = 'sync_provider_unavailable';
      } else if (provider.pushMetadataChangeWithResult) {
        const writeResult = await provider.pushMetadataChangeWithResult(sessionId, {
          hasPendingPrompt,
        });
        sync.attempted = writeResult.attempted;
        sync.succeeded = writeResult.indexFrameWritten;
        sync.skippedReason = writeResult.skippedReason;
        if (writeResult.error) sync.error = writeResult.error;
      } else {
        sync.attempted = true;
        await Promise.resolve(provider.pushChange(sessionId, {
          type: 'metadata_updated',
          metadata: { hasPendingPrompt },
        }));
        // Legacy providers expose no write receipt. Preserve their best-effort
        // push without claiming the encrypted index frame was accepted.
        sync.skippedReason = 'sync_write_result_unavailable';
      }
      }
    } catch (error) {
      sync.skippedReason = 'sync_push_failed';
      sync.error = boundedError(error);
      logger.main.warn(
        `[pendingPromptPersistence] Failed to push hasPendingPrompt sync change for session ${sessionId}:`,
        error,
      );
    }

    return {
      sessionId,
      hasPendingPrompt,
      promptId,
      generation,
      applied: local.succeeded || sync.succeeded,
      superseded: false,
      local,
      sync,
      fullyPropagated: local.succeeded && sync.succeeded,
    };
  };
  return acquireLock ? withSessionLock(sessionId, persist) : persist();
}

export async function setSessionPendingPrompt(
  sessionId: string,
  hasPendingPrompt: boolean,
  options: PendingPromptPersistenceOptions = {},
): Promise<PendingPromptPersistenceResult> {
  return setSessionPendingPromptInternal(sessionId, hasPendingPrompt, options, true);
}

export interface ClaimedPendingPromptActionResult<T> {
  ownership: PendingPromptActionOwnership;
  promptClear: PendingPromptPersistenceResult;
  claimed: boolean;
  value?: T;
}

export interface OwnedPendingPromptActionResult<T> {
  ownership: PendingPromptActionOwnership;
  owned: boolean;
  value?: T;
}

function rejectedPromptActionClear(
  ownership: PendingPromptActionOwnership,
  reason: string,
): PendingPromptPersistenceResult {
  const skipped: PendingPromptPersistenceStep = {
    attempted: false,
    succeeded: false,
    skippedReason: reason,
  };
  return {
    sessionId: ownership.sessionId,
    hasPendingPrompt: false,
    promptId: null,
    generation: null,
    applied: false,
    superseded: reason === 'newer_prompt_is_pending',
    local: skipped,
    sync: { ...skipped },
    fullyPropagated: false,
  };
}

/**
 * Validate an exact prompt under the shared prompt lock without forcing an
 * immediate clear. The callback receives a lock-safe compare-clear closure so
 * callers that must persist the exact-A response first can do so without
 * allowing prompt B to open between persistence, clearing, and delivery.
 */
export async function runOwnedPendingPromptAction<T>(
  sessionId: string,
  promptId: string,
  action: (state: {
    ownership: PendingPromptActionOwnership;
    clearPrompt: (
      durableCleanupAuthority?: HostControlMetadataCleanupAuthority,
    ) => Promise<PendingPromptPersistenceResult>;
  }) => Promise<T> | T,
): Promise<OwnedPendingPromptActionResult<T>> {
  return withSessionLock(sessionId, async () => {
    const ownership = await capturePendingPromptActionOwnership(sessionId, promptId);
    if (
      !ownership.readSucceeded ||
      !ownership.matchedPendingPrompt ||
      !ownership.attentionGeneration ||
      !promptActionOwnsCurrentGeneration(ownership)
    ) {
      return { ownership, owned: false };
    }
    let promptClear: PendingPromptPersistenceResult | undefined;
    const clearPrompt = async (durableCleanupAuthority?: HostControlMetadataCleanupAuthority) => {
      if (!promptClear) {
        promptClear = promptActionOwnsCurrentGeneration(ownership)
          ? await setSessionPendingPromptInternal(sessionId, false, {
              expectedPromptId: ownership.promptId,
              expectedGeneration: ownership.attentionGeneration!,
              ...(durableCleanupAuthority ? { durableCleanupAuthority } : {}),
            }, false)
          : rejectedPromptActionClear(ownership, 'newer_prompt_is_pending');
      }
      return promptClear;
    };
    const value = await action({ ownership, clearPrompt });
    return { ownership, owned: true, value };
  });
}

/**
 * Claim and settle one prompt-specific action under the same per-session lock
 * used by prompt opening. Mobile/provider/waiter side effects run only after
 * the exact durable prompt id + generation was compare-cleared, and the lock
 * remains held until those effects finish so prompt B cannot open mid-action.
 */
export async function runClaimedPendingPromptAction<T>(
  sessionId: string,
  promptId: string,
  action: (state: {
    ownership: PendingPromptActionOwnership;
    promptClear: PendingPromptPersistenceResult;
  }) => Promise<T> | T,
): Promise<ClaimedPendingPromptActionResult<T>> {
  return withSessionLock(sessionId, async () => {
    const ownership = await capturePendingPromptActionOwnership(sessionId, promptId);
    if (!ownership.readSucceeded) {
      return {
        ownership,
        promptClear: rejectedPromptActionClear(ownership, 'identity_read_failed'),
        claimed: false,
      };
    }
    if (
      !ownership.matchedPendingPrompt ||
      !ownership.attentionGeneration ||
      !promptActionOwnsCurrentGeneration(ownership)
    ) {
      return {
        ownership,
        promptClear: rejectedPromptActionClear(ownership, 'newer_prompt_is_pending'),
        claimed: false,
      };
    }

    const promptClear = await setSessionPendingPromptInternal(sessionId, false, {
      expectedPromptId: ownership.promptId,
      expectedGeneration: ownership.attentionGeneration,
    }, false);
    if (
      promptClear.superseded ||
      !promptClear.local.succeeded ||
      !promptActionOwnsCurrentGeneration(ownership)
    ) {
      return { ownership, promptClear, claimed: false };
    }

    const value = await action({ ownership, promptClear });
    return { ownership, promptClear, claimed: true, value };
  });
}
