import { randomUUID } from 'crypto';
import type {
  QueuedPrompt,
  QueuedPromptsStore,
} from './PGLiteQueuedPromptsStore';
import type {
  QueuedPromptDispatchSessionLike,
  QueuedPromptDispatchTarget,
} from './ai/queuedPromptDispatcher';
import {
  type InterruptCurrentTurnOptions,
  type InterruptCurrentTurnResult,
} from './ai/interruptCurrentTurnForSession';

/**
 * No existing services/ai prompt-size limit exists. This cap keeps trusted
 * control requests finite while still allowing detailed delegated prompts.
 */
export const PRIORITY_PROMPT_MAX_CHARS = 50_000;

const INTERRUPT_ERROR_MAX_CHARS = 1_000;
const INTERRUPT_METHOD_MAX_CHARS = 128;

export type PrioritySessionStatus =
  | 'idle'
  | 'running'
  | 'waiting_for_input'
  | 'error'
  | 'missing';

export interface DeliverPriorityPromptInput {
  sessionId: string;
  workspacePath: string;
  prompt: string;
  idempotencyKey: string;
  producer: string;
  controlOperation: string;
}

type PriorityQueueStore = Pick<
  QueuedPromptsStore,
  | 'createPriorityControlQueuedPrompt'
  | 'reserveInterrupt'
  | 'beginInterruptApplication'
  | 'verifyInterruptApplication'
  | 'recordInterruptApplication'
  | 'claimInterruptCleanup'
  | 'enterInterruptApplication'
  | 'recordInterruptReceipt'
  | 'get'
>;

export interface PriorityPromptDeliveryDependencies {
  getSession(
    sessionId: string,
  ): Promise<QueuedPromptDispatchSessionLike | null>;
  resolveDispatchTarget(
    sessionId: string,
    requestedWorkspacePath: string,
    session: QueuedPromptDispatchSessionLike | null,
  ): QueuedPromptDispatchTarget | null;
  queueStore: PriorityQueueStore;
  getCurrentAttentionGeneration(sessionId: string): Promise<string | undefined> | string | undefined;
  getSessionStatus(
    sessionId: string,
  ): Promise<Exclude<PrioritySessionStatus, 'missing'> | undefined>
    | Exclude<PrioritySessionStatus, 'missing'>
    | undefined;
  interruptCurrentTurnForSession(
    sessionId: string,
    options?: InterruptCurrentTurnOptions,
  ): Promise<InterruptCurrentTurnResult>;
  triggerQueuedPromptProcessingForSession(
    sessionId: string,
    workspacePath: string,
  ): Promise<boolean>;
  now?: () => number;
  createInterruptReservationOwner?: () => string;
  interruptReservationLeaseMs?: number;
  onInterruptReconciliationPoint?: (
    point:
      | 'after_interrupt_reserved'
      | 'after_interrupt_fence_verified'
      | 'after_interrupt_application_recorded',
    row: QueuedPrompt,
  ) => Promise<void> | void;
}

export type PriorityDeliveryAction =
  | 'deferred_waiting_for_input'
  | 'idle_dispatch_triggered'
  | 'error_dispatch_triggered'
  | 'missing_status_dispatch_triggered'
  | 'interrupt_attempted'
  | 'interrupt_already_reserved'
  | 'interrupt_reservation_in_progress'
  | 'interrupt_reservation_reconciled'
  | 'reservation_unverified'
  | 'deferred_missing_generation';

export interface PriorityPromptDeliveryResult {
  controlRowId: string;
  routingWorkspacePath: string;
  action: PriorityDeliveryAction;
  processingTriggerCalled: boolean;
  processingTriggerAccepted: boolean;
  interrupt: {
    generation: string;
    reserved: boolean;
    attempted: boolean;
    success: boolean | null;
    method: string | null;
    error: string | null;
  } | null;
  verification: {
    row: {
      id: string;
      status: QueuedPrompt['status'];
      deliveryClass: QueuedPrompt['deliveryClass'];
      priorityRank: number | undefined;
      interruptTargetGeneration: string | null;
      hasInterruptReceipt: boolean;
    } | null;
    sessionStatus: PrioritySessionStatus;
    deliveryObserved: boolean;
  };
}

function requireNonEmptyString(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${field} must be a non-empty string`);
  }
}

function boundedOptional(value: string | undefined, maxChars: number): string | null {
  if (!value) return null;
  return value.length > maxChars ? value.slice(0, maxChars) : value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const DEFAULT_INTERRUPT_LEASE_MS = 30_000;

interface DurableInterruptReceipt {
  method: string | null;
  error: string | null;
  success: boolean;
  generation: string;
  certainty: 'not_applied' | 'unknown' | 'applied';
  nativeEntered: boolean;
  attemptedAt: string;
  resultAt: string;
}

function readDurableInterruptReceipt(value: unknown): DurableInterruptReceipt | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const receipt = value as Partial<DurableInterruptReceipt>;
  if (
    typeof receipt.success !== 'boolean'
    || typeof receipt.generation !== 'string'
    || typeof receipt.attemptedAt !== 'string'
    || typeof receipt.resultAt !== 'string'
  ) return null;
  return {
    success: receipt.success,
    generation: receipt.generation,
    certainty: receipt.certainty === 'not_applied' || receipt.certainty === 'applied'
      ? receipt.certainty
      : 'unknown',
    nativeEntered: receipt.nativeEntered === true,
    attemptedAt: receipt.attemptedAt,
    resultAt: receipt.resultAt,
    method: typeof receipt.method === 'string' ? receipt.method : null,
    error: typeof receipt.error === 'string' ? receipt.error : null,
  };
}

export function createPriorityPromptDeliveryService(
  deps: PriorityPromptDeliveryDependencies,
): {
  deliverPriorityPrompt(input: DeliverPriorityPromptInput): Promise<PriorityPromptDeliveryResult>;
} {
  const classifyStatus = async (
    status: Exclude<PrioritySessionStatus, 'missing'> | undefined,
    sessionId: string,
  ): Promise<PrioritySessionStatus> => {
    if (status === undefined) return 'missing';
    if (status !== 'idle') return status;
    return await deps.getCurrentAttentionGeneration(sessionId) ? 'idle' : 'missing';
  };

  return {
    async deliverPriorityPrompt(input): Promise<PriorityPromptDeliveryResult> {
      requireNonEmptyString(input?.sessionId, 'sessionId');
      requireNonEmptyString(input?.prompt, 'prompt');
      if (input.prompt.length > PRIORITY_PROMPT_MAX_CHARS) {
        throw new RangeError(`prompt exceeds ${PRIORITY_PROMPT_MAX_CHARS} characters`);
      }
      requireNonEmptyString(input?.idempotencyKey, 'idempotencyKey');
      requireNonEmptyString(input?.producer, 'producer');
      requireNonEmptyString(input?.controlOperation, 'controlOperation');

      const session = await deps.getSession(input.sessionId);
      const target = deps.resolveDispatchTarget(
        input.sessionId,
        input.workspacePath,
        session,
      );
      if (!target) {
        throw new Error(`Priority delivery target ${input.sessionId} is not addressable`);
      }

      const controlRow = await deps.queueStore.createPriorityControlQueuedPrompt({
        sessionId: input.sessionId,
        prompt: input.prompt,
        idempotencyKey: input.idempotencyKey,
        producer: input.producer,
        controlOperation: input.controlOperation,
      });

      // Terminal interrupt receipts are immutable idempotency results. Replay
      // them before consulting volatile session status or ordinary dispatch.
      const replayedReceipt = readDurableInterruptReceipt(controlRow.interruptReceipt);
      if (replayedReceipt) {
        const finalRow = await deps.queueStore.get(controlRow.id);
        const observedStatus = await classifyStatus(
          await deps.getSessionStatus(input.sessionId),
          input.sessionId,
        );
        return {
          controlRowId: controlRow.id,
          routingWorkspacePath: target.routingWorkspacePath,
          action: 'interrupt_already_reserved',
          processingTriggerCalled: false,
          processingTriggerAccepted: false,
          interrupt: {
            generation: replayedReceipt.generation,
            reserved: false,
            attempted: replayedReceipt.nativeEntered,
            success: replayedReceipt.success,
            method: boundedOptional(replayedReceipt.method ?? undefined, INTERRUPT_METHOD_MAX_CHARS),
            error: boundedOptional(replayedReceipt.error ?? undefined, INTERRUPT_ERROR_MAX_CHARS),
          },
          verification: {
            row: finalRow ? {
              id: finalRow.id,
              status: finalRow.status,
              deliveryClass: finalRow.deliveryClass,
              priorityRank: finalRow.priorityRank,
              interruptTargetGeneration: finalRow.interruptTargetGeneration ?? null,
              hasInterruptReceipt: true,
            } : null,
            sessionStatus: observedStatus,
            deliveryObserved: Boolean(
              finalRow && (finalRow.status === 'executing' || finalRow.status === 'completed'),
            ),
          },
        };
      }

      const status = await classifyStatus(
        await deps.getSessionStatus(input.sessionId),
        input.sessionId,
      );
      let action: PriorityDeliveryAction;
      let processingTriggerCalled = false;
      let processingTriggerAccepted = false;
      let interrupt: PriorityPromptDeliveryResult['interrupt'] = null;

      if (status === 'waiting_for_input') {
        // A native prompt owns the turn. Leave the control row pending and do
        // not prod the ordinary dispatcher until that prompt is resolved.
        action = 'deferred_waiting_for_input';
      } else if (status === 'running') {
        // A replay with an unfinished durable reservation must reconcile that
        // captured generation, never retarget the row to the currently-running
        // replacement generation B.
        const expectedGeneration = controlRow.interruptTargetGeneration
          ?? await deps.getCurrentAttentionGeneration(input.sessionId);
        if (!expectedGeneration) {
          action = 'deferred_missing_generation';
          processingTriggerCalled = true;
          processingTriggerAccepted = await deps.triggerQueuedPromptProcessingForSession(
            input.sessionId,
            target.routingWorkspacePath,
          );
        } else {
          const freshStatus = await classifyStatus(
            await deps.getSessionStatus(input.sessionId),
            input.sessionId,
          );
          if (freshStatus !== 'running') {
            if (freshStatus === 'waiting_for_input') {
              action = 'deferred_waiting_for_input';
            } else {
              action = freshStatus === 'idle'
                ? 'idle_dispatch_triggered'
                : freshStatus === 'error'
                  ? 'error_dispatch_triggered'
                  : 'missing_status_dispatch_triggered';
              processingTriggerCalled = true;
              processingTriggerAccepted = await deps.triggerQueuedPromptProcessingForSession(
                input.sessionId,
                target.routingWorkspacePath,
              );
            }
          } else {
            const reserveNowMs = deps.now?.() ?? Date.now();
            const requestedOwner = deps.createInterruptReservationOwner?.()
              ?? `priority-interrupt-owner:${randomUUID()}`;
            const reservation = await deps.queueStore.reserveInterrupt({
              id: controlRow.id,
              expectedGeneration,
              reservationOwner: requestedOwner,
              now: new Date(reserveNowMs),
              leaseExpiresAt: new Date(
                reserveNowMs
                + Math.max(1, deps.interruptReservationLeaseMs ?? DEFAULT_INTERRUPT_LEASE_MS),
              ),
            });

            const reservationOwner = reservation.row.interruptReservationOwner ?? requestedOwner;
            const reservedGeneration = reservation.row.interruptTargetGeneration
              ?? expectedGeneration;
            const operationId = reservation.row.interruptOperationId;
            const fence = reservation.row.interruptFence;
            if (!operationId || fence === undefined) {
              throw new Error('interrupt_reservation_identity_missing');
            }
            if (
              reservation.reserved
              && reservation.takenOver
              && reservation.row.interruptApplicationState !== 'not_started'
            ) {
              let receipt = (
                reservation.row.interruptApplicationState === 'applied'
                || reservation.row.interruptApplicationState === 'not_applied'
              )
                ? readDurableInterruptReceipt(reservation.row.interruptApplicationReceipt)
                : null;
              if (!receipt) {
                const reconciledAt = new Date(deps.now?.() ?? Date.now()).toISOString();
                receipt = {
                  method: null,
                  error: reservation.row.interruptApplicationState === 'unknown'
                    ? 'interrupt outcome unconfirmed after reservation owner loss'
                    : 'legacy interrupt outcome is unknown and was not retried',
                  success: false,
                  generation: reservedGeneration,
                  certainty: 'unknown',
                  nativeEntered: false,
                  attemptedAt: reservation.row.interruptStartedAt
                    ? new Date(reservation.row.interruptStartedAt).toISOString()
                    : reconciledAt,
                  resultAt: reconciledAt,
                };
              }
              await deps.queueStore.claimInterruptCleanup({
                id: controlRow.id,
                expectedGeneration: reservedGeneration,
                reservationOwner,
                operationId,
                fence,
              });
              await deps.queueStore.recordInterruptReceipt({
                id: controlRow.id,
                expectedGeneration: reservedGeneration,
                reservationOwner,
                operationId,
                fence,
                receipt,
                finalizedAt: new Date(deps.now?.() ?? Date.now()),
              });
              action = 'interrupt_reservation_reconciled';
              interrupt = {
                generation: receipt.generation,
                reserved: false,
                attempted: receipt.nativeEntered,
                success: receipt.success,
                method: boundedOptional(receipt.method ?? undefined, INTERRUPT_METHOD_MAX_CHARS),
                error: boundedOptional(receipt.error ?? undefined, INTERRUPT_ERROR_MAX_CHARS),
              };
            } else if (reservation.reserved) {
              action = 'interrupt_attempted';
              await deps.onInterruptReconciliationPoint?.(
                'after_interrupt_reserved',
                reservation.row,
              );
              const startedAt = new Date(deps.now?.() ?? Date.now());
              const application = await deps.queueStore.beginInterruptApplication({
                id: controlRow.id,
                expectedGeneration: reservedGeneration,
                reservationOwner,
                operationId,
                fence,
                now: startedAt,
              });
              if (!application.started) {
                throw new Error('interrupt_application_fence_unavailable');
              }
              const attemptedAt = startedAt.toISOString();
              let result: InterruptCurrentTurnResult;
              try {
                result = await deps.interruptCurrentTurnForSession(input.sessionId, {
                  expectedGeneration: reservedGeneration,
                  priorityRowId: controlRow.id,
                  operationId,
                  fence,
                  assertInterruptFence: () => deps.queueStore.verifyInterruptApplication({
                    id: controlRow.id,
                    expectedGeneration: reservedGeneration,
                    reservationOwner,
                    operationId,
                    fence,
                    now: new Date(deps.now?.() ?? Date.now()),
                  }),
                  ...(deps.queueStore.enterInterruptApplication ? {
                    enterInterruptApplication: <T>(action: () => Promise<T>) =>
                      deps.queueStore.enterInterruptApplication!({
                        id: controlRow.id,
                        expectedGeneration: reservedGeneration,
                        reservationOwner,
                        operationId,
                        fence,
                      }, action),
                  } : {}),
                  beforeNativeEntry: deps.onInterruptReconciliationPoint
                    ? () => Promise.resolve(
                        deps.onInterruptReconciliationPoint!(
                          'after_interrupt_fence_verified',
                          reservation.row,
                        ),
                      )
                    : undefined,
                });
              } catch (error) {
                result = {
                  success: false,
                  error: errorMessage(error),
                  nativeCertainty: 'unknown',
                  nativeEntered: false,
                };
              }
              const resultAtDate = new Date(deps.now?.() ?? Date.now());
              const resultAt = resultAtDate.toISOString();
              const method = boundedOptional(result.method, INTERRUPT_METHOD_MAX_CHARS);
              const error = boundedOptional(result.error, INTERRUPT_ERROR_MAX_CHARS);

              interrupt = {
                generation: reservedGeneration,
                reserved: true,
                attempted: result.nativeEntered === true,
                success: result.success,
                method,
                error,
              };
              const durableReceipt: DurableInterruptReceipt = {
                method,
                error,
                success: result.success,
                generation: reservedGeneration,
                certainty: result.nativeCertainty ?? 'unknown',
                nativeEntered: result.nativeEntered === true,
                attemptedAt,
                resultAt,
              };
              if (durableReceipt.certainty !== 'unknown') {
                const appliedRow = await deps.queueStore.recordInterruptApplication({
                  id: controlRow.id,
                  expectedGeneration: reservedGeneration,
                  reservationOwner,
                  operationId,
                  fence,
                  certainty: durableReceipt.certainty,
                  receipt: durableReceipt,
                  appliedAt: resultAtDate,
                });
                await deps.onInterruptReconciliationPoint?.(
                  'after_interrupt_application_recorded',
                  appliedRow,
                );
              }
              await deps.queueStore.claimInterruptCleanup({
                id: controlRow.id,
                expectedGeneration: reservedGeneration,
                reservationOwner,
                operationId,
                fence,
              });
              await deps.queueStore.recordInterruptReceipt({
                id: controlRow.id,
                expectedGeneration: reservedGeneration,
                reservationOwner,
                operationId,
                fence,
                receipt: durableReceipt,
                finalizedAt: new Date(deps.now?.() ?? Date.now()),
              });
            } else if (reservation.row.interruptReceipt !== undefined) {
              const receipt = reservation.row.interruptReceipt as {
                method?: string | null;
                error?: string | null;
                success: boolean;
                generation: string;
              };
              action = 'interrupt_already_reserved';
              interrupt = {
                generation: receipt.generation,
                reserved: false,
                attempted: false,
                success: receipt.success,
                method: boundedOptional(receipt.method ?? undefined, INTERRUPT_METHOD_MAX_CHARS),
                error: boundedOptional(receipt.error ?? undefined, INTERRUPT_ERROR_MAX_CHARS),
              };
            } else {
              action = 'interrupt_reservation_in_progress';
              interrupt = {
                generation: reservedGeneration,
                reserved: false,
                attempted: false,
                success: null,
                method: null,
                error: 'interrupt reservation is owned by an unexpired lease',
              };
            }

            processingTriggerCalled = true;
            processingTriggerAccepted = await deps.triggerQueuedPromptProcessingForSession(
              input.sessionId,
              target.routingWorkspacePath,
            );
          }
        }
      } else {
        action = status === 'idle'
          ? 'idle_dispatch_triggered'
          : status === 'error'
            ? 'error_dispatch_triggered'
            : 'missing_status_dispatch_triggered';
        processingTriggerCalled = true;
        processingTriggerAccepted = await deps.triggerQueuedPromptProcessingForSession(
          input.sessionId,
          target.routingWorkspacePath,
        );
      }

      const finalRow = await deps.queueStore.get(controlRow.id);
      const finalStatus = await classifyStatus(
        await deps.getSessionStatus(input.sessionId),
        input.sessionId,
      );

      return {
        controlRowId: controlRow.id,
        routingWorkspacePath: target.routingWorkspacePath,
        action,
        processingTriggerCalled,
        processingTriggerAccepted,
        interrupt,
        verification: {
          row: finalRow
            ? {
                id: finalRow.id,
                status: finalRow.status,
                deliveryClass: finalRow.deliveryClass,
                priorityRank: finalRow.priorityRank,
                interruptTargetGeneration: finalRow.interruptTargetGeneration ?? null,
                hasInterruptReceipt: finalRow.interruptReceipt !== undefined,
              }
            : null,
          sessionStatus: finalStatus,
          deliveryObserved: Boolean(
            finalRow && (finalRow.status === 'executing' || finalRow.status === 'completed'),
          ),
        },
      };
    },
  };
}
