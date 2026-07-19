import type {
  QueuedPrompt,
  QueuedPromptsStore,
} from './PGLiteQueuedPromptsStore';
import type {
  QueuedPromptDispatchSessionLike,
  QueuedPromptDispatchTarget,
} from './ai/queuedPromptDispatcher';
import type {
  InterruptCurrentTurnOptions,
  InterruptCurrentTurnResult,
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
  | 'error';

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
  getSessionStatus(sessionId: string): Promise<PrioritySessionStatus> | PrioritySessionStatus;
  interruptCurrentTurnForSession(
    sessionId: string,
    options?: InterruptCurrentTurnOptions,
  ): Promise<InterruptCurrentTurnResult>;
  triggerQueuedPromptProcessingForSession(
    sessionId: string,
    workspacePath: string,
  ): Promise<boolean>;
}

export type PriorityDeliveryAction =
  | 'deferred_waiting_for_input'
  | 'idle_dispatch_triggered'
  | 'interrupt_attempted'
  | 'interrupt_already_reserved'
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

export function createPriorityPromptDeliveryService(
  deps: PriorityPromptDeliveryDependencies,
): {
  deliverPriorityPrompt(input: DeliverPriorityPromptInput): Promise<PriorityPromptDeliveryResult>;
} {
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

      const status = await deps.getSessionStatus(input.sessionId);
      let action: PriorityDeliveryAction;
      let processingTriggerCalled = false;
      let processingTriggerAccepted = false;
      let interrupt: PriorityPromptDeliveryResult['interrupt'] = null;

      if (status === 'waiting_for_input') {
        // A native prompt owns the turn. Leave the control row pending and do
        // not prod the ordinary dispatcher until that prompt is resolved.
        action = 'deferred_waiting_for_input';
      } else if (status === 'running') {
        const expectedGeneration = await deps.getCurrentAttentionGeneration(input.sessionId);
        if (!expectedGeneration) {
          action = 'deferred_missing_generation';
          processingTriggerCalled = true;
          processingTriggerAccepted = await deps.triggerQueuedPromptProcessingForSession(
            input.sessionId,
            target.routingWorkspacePath,
          );
        } else {
          const freshStatus = await deps.getSessionStatus(input.sessionId);
          if (freshStatus === 'waiting_for_input') {
            action = 'deferred_waiting_for_input';
            // A native prompt opened after the initial status read. Leave the
            // control row pending for processing after that prompt resolves.
          } else {
            const reservation = await deps.queueStore.reserveInterrupt({
              id: controlRow.id,
              expectedGeneration,
            });

            if (reservation.reserved) {
              action = 'interrupt_attempted';
              const attemptedAt = new Date().toISOString();
              let result: InterruptCurrentTurnResult;
              try {
                result = await deps.interruptCurrentTurnForSession(input.sessionId, {
                  expectedGeneration,
                  priorityRowId: controlRow.id,
                });
              } catch (error) {
                result = { success: false, error: errorMessage(error) };
              }
              const resultAt = new Date().toISOString();
              const method = boundedOptional(result.method, INTERRUPT_METHOD_MAX_CHARS);
              const error = boundedOptional(result.error, INTERRUPT_ERROR_MAX_CHARS);

              interrupt = {
                generation: expectedGeneration,
                reserved: true,
                attempted: true,
                success: result.success,
                method,
                error,
              };
              await deps.queueStore.recordInterruptReceipt({
                id: controlRow.id,
                receipt: {
                  method,
                  error,
                  success: result.success,
                  generation: expectedGeneration,
                  attemptedAt,
                  resultAt,
                },
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
              action = 'reservation_unverified';
              interrupt = {
                generation: expectedGeneration,
                reserved: false,
                attempted: false,
                success: null,
                method: null,
                error: 'reservation exists without a terminal receipt; delivery unverified',
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
        action = 'idle_dispatch_triggered';
        processingTriggerCalled = true;
        processingTriggerAccepted = await deps.triggerQueuedPromptProcessingForSession(
          input.sessionId,
          target.routingWorkspacePath,
        );
      }

      const finalRow = await deps.queueStore.get(controlRow.id);
      const finalStatus = await deps.getSessionStatus(input.sessionId);

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
