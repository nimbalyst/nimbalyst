import { createHash, randomUUID } from 'crypto';

export type PriorityTargetStatus =
  | 'idle'
  | 'running'
  | 'waiting_for_input'
  | 'error'
  | 'interrupted'
  | 'missing';

export interface PriorityTargetState {
  status: PriorityTargetStatus;
  generation: string;
  lastActivity: number | null;
  updatedAt: number | null;
}

export function createPriorityTargetGeneration(
  status: PriorityTargetStatus,
  lastActivity: number | null,
  updatedAt: number | null,
): string {
  return `${status}:${lastActivity ?? 'none'}:${updatedAt ?? 'none'}`;
}

export interface PriorityInterruptReceipt {
  generation: string;
  attempted: boolean;
  success: boolean;
  method: string | null;
  error: string | null;
  nativeEntered: boolean;
  recordedAt: number;
}

export interface PriorityControlPrompt {
  id: string;
  sessionId: string;
  status: 'pending' | 'executing' | 'completed' | 'failed';
  deliveryClass: 'control';
  priorityRank: number;
  deliveryReady?: boolean;
  interruptTargetGeneration: string | null;
  interruptReservationOwner: string | null;
  interruptReceipt: PriorityInterruptReceipt | null;
}

interface CreateControlPromptInput {
  id: string;
  sessionId: string;
  prompt: string;
  producer: string;
  idempotencyKey: string;
  requestDigest: string;
  controlOperation: string;
}

interface PriorityPromptDeliveryDependencies {
  createControlPrompt(input: CreateControlPromptInput): Promise<{
    row: PriorityControlPrompt;
    replayed: boolean;
  }>;
  getTargetState(sessionId: string, workspacePath: string): Promise<PriorityTargetState>;
  hasStructuredPendingPrompt(sessionId: string): Promise<boolean>;
  reserveInterrupt(input: {
    promptId: string;
    generation: string;
    owner: string;
  }): Promise<{ row: PriorityControlPrompt; reserved: boolean }>;
  recordInterruptReceipt(input: {
    promptId: string;
    generation: string;
    receipt: PriorityInterruptReceipt;
  }): Promise<PriorityControlPrompt>;
  interruptCurrentTurn(
    sessionId: string,
    expectedState: PriorityTargetState,
  ): Promise<{
    success: boolean;
    method?: string;
    error?: string;
    nativeEntered?: boolean;
  }>;
  triggerProcessing(sessionId: string, workspacePath: string): Promise<boolean>;
  getControlPrompt(promptId: string): Promise<PriorityControlPrompt | null>;
  createReservationOwner?(): string;
  createControlPromptId?(): string;
}

export interface DeliverPriorityPromptInput {
  sessionId: string;
  workspacePath: string;
  prompt: string;
  idempotencyKey: string;
  producer: string;
  controlOperation: string;
  interruptWaitingForInput: boolean;
}

export interface PriorityPromptDeliveryReceipt {
  sessionId: string;
  queuedPromptId: string;
  deliveryClass: 'control';
  priorityRank: number;
  idempotencyKey: string;
  producer: string;
  controlOperation: string;
  replayed: boolean;
  action:
    | 'processing_triggered'
    | 'queued_waiting_for_authority'
    | 'structured_prompt_requires_response'
    | 'interrupt_attempted'
    | 'interrupt_receipt_replayed'
    | 'interrupt_already_reserved'
    | 'stale_generation_rejected';
  targetBefore: PriorityTargetState;
  targetAfter: PriorityTargetState;
  processingTriggerCalled: boolean;
  processingTriggerAccepted: boolean;
  interrupt: {
    attempted: boolean;
    success: boolean | null;
    method: string | null;
    error: string | null;
    nativeEntered: boolean;
    targetGeneration: string | null;
    reservationOwner: string | null;
  };
}

function requireNonEmpty(value: string, field: string): string {
  const normalized = value?.trim();
  if (!normalized) {
    throw new Error(`${field} is required`);
  }
  return normalized;
}

function requestDigest(input: {
  sessionId: string;
  prompt: string;
  producer: string;
  controlOperation: string;
}): string {
  return createHash('sha256')
    .update(JSON.stringify(input))
    .digest('hex');
}

function receiptInterrupt(
  row: PriorityControlPrompt,
  receipt: PriorityInterruptReceipt | null,
) {
  return {
    attempted: receipt?.attempted ?? false,
    success: receipt?.success ?? null,
    method: receipt?.method ?? null,
    error: receipt?.error ?? null,
    nativeEntered: receipt?.nativeEntered ?? false,
    targetGeneration: row.interruptTargetGeneration,
    reservationOwner: row.interruptReservationOwner,
  };
}

export function createPriorityPromptDeliveryService(
  deps: PriorityPromptDeliveryDependencies,
) {
  return {
    async deliver(raw: DeliverPriorityPromptInput): Promise<PriorityPromptDeliveryReceipt> {
      const sessionId = requireNonEmpty(raw.sessionId, 'sessionId');
      const workspacePath = requireNonEmpty(raw.workspacePath, 'workspacePath');
      const prompt = requireNonEmpty(raw.prompt, 'prompt');
      const idempotencyKey = requireNonEmpty(raw.idempotencyKey, 'idempotencyKey');
      const producer = requireNonEmpty(raw.producer, 'producer');
      const controlOperation = requireNonEmpty(raw.controlOperation, 'controlOperation');

      const created = await deps.createControlPrompt({
        id: deps.createControlPromptId?.() ?? `control-${randomUUID()}`,
        sessionId,
        prompt,
        producer,
        idempotencyKey,
        requestDigest: requestDigest({ sessionId, prompt, producer, controlOperation }),
        controlOperation,
      });
      let row = created.row;
      const targetBefore = await deps.getTargetState(sessionId, workspacePath);

      const result = (
        action: PriorityPromptDeliveryReceipt['action'],
        targetAfter: PriorityTargetState,
        processingTriggerCalled: boolean,
        processingTriggerAccepted: boolean,
      ): PriorityPromptDeliveryReceipt => ({
        sessionId,
        queuedPromptId: row.id,
        deliveryClass: 'control',
        priorityRank: row.priorityRank,
        idempotencyKey,
        producer,
        controlOperation,
        replayed: created.replayed,
        action,
        targetBefore,
        targetAfter,
        processingTriggerCalled,
        processingTriggerAccepted,
        interrupt: receiptInterrupt(row, row.interruptReceipt),
      });

      if (row.interruptReceipt) {
        const shouldRetryTrigger = row.status === 'pending' && row.interruptReceipt.success;
        const accepted = shouldRetryTrigger
          ? await deps.triggerProcessing(sessionId, workspacePath)
          : false;
        const targetAfter = shouldRetryTrigger
          ? await deps.getTargetState(sessionId, workspacePath)
          : targetBefore;
        return result(
          'interrupt_receipt_replayed',
          targetAfter,
          shouldRetryTrigger,
          accepted,
        );
      }

      if (targetBefore.status === 'waiting_for_input') {
        if (await deps.hasStructuredPendingPrompt(sessionId)) {
          return result('structured_prompt_requires_response', targetBefore, false, false);
        }
        if (!raw.interruptWaitingForInput) {
          return result('queued_waiting_for_authority', targetBefore, false, false);
        }
      }

      if (targetBefore.status === 'missing') {
        throw new Error(`Session ${sessionId} disappeared before priority delivery`);
      }

      const needsInterrupt =
        targetBefore.status === 'running'
        || targetBefore.status === 'waiting_for_input';
      const reservationOwner = deps.createReservationOwner?.() ?? randomUUID();
      const reservation = await deps.reserveInterrupt({
        promptId: row.id,
        generation: targetBefore.generation,
        owner: reservationOwner,
      });
      row = reservation.row;
      if (!reservation.reserved) {
        const durable = await deps.getControlPrompt(row.id);
        if (durable) {
          row = durable;
        }
        const shouldRetryTrigger = Boolean(
          row.interruptReceipt?.success && row.status === 'pending'
        );
        const accepted = shouldRetryTrigger
          ? await deps.triggerProcessing(sessionId, workspacePath)
          : false;
        const targetAfter = await deps.getTargetState(sessionId, workspacePath);
        return result(
          row.interruptReceipt ? 'interrupt_receipt_replayed' : 'interrupt_already_reserved',
          targetAfter,
          shouldRetryTrigger,
          accepted,
        );
      }

      const stateAtInterrupt = await deps.getTargetState(sessionId, workspacePath);
      if (
        stateAtInterrupt.generation !== targetBefore.generation
        || stateAtInterrupt.status !== targetBefore.status
      ) {
        const staleReceipt: PriorityInterruptReceipt = {
          generation: targetBefore.generation,
          attempted: false,
          success: false,
          method: null,
          error: 'stale lifecycle generation',
          nativeEntered: false,
          recordedAt: Date.now(),
        };
        row = await deps.recordInterruptReceipt({
          promptId: row.id,
          generation: targetBefore.generation,
          receipt: staleReceipt,
        });
        const targetAfter = await deps.getTargetState(sessionId, workspacePath);
        return result('stale_generation_rejected', targetAfter, false, false);
      }

      if (!needsInterrupt) {
        const releaseReceipt: PriorityInterruptReceipt = {
          generation: targetBefore.generation,
          attempted: false,
          success: true,
          method: 'not-required',
          error: null,
          nativeEntered: false,
          recordedAt: Date.now(),
        };
        row = await deps.recordInterruptReceipt({
          promptId: row.id,
          generation: targetBefore.generation,
          receipt: releaseReceipt,
        });
        const accepted = await deps.triggerProcessing(sessionId, workspacePath);
        const targetAfter = await deps.getTargetState(sessionId, workspacePath);
        return result('processing_triggered', targetAfter, true, accepted);
      }

      const interruptResult = await deps.interruptCurrentTurn(sessionId, targetBefore);
      const durableReceipt: PriorityInterruptReceipt = {
        generation: targetBefore.generation,
        attempted: true,
        success: interruptResult.success,
        method: interruptResult.method ?? null,
        error: interruptResult.error ?? null,
        nativeEntered: interruptResult.nativeEntered === true,
        recordedAt: Date.now(),
      };
      row = await deps.recordInterruptReceipt({
        promptId: row.id,
        generation: targetBefore.generation,
        receipt: durableReceipt,
      });

      let processingTriggerCalled = false;
      let processingTriggerAccepted = false;
      if (interruptResult.success) {
        processingTriggerCalled = true;
        processingTriggerAccepted = await deps.triggerProcessing(sessionId, workspacePath);
      }
      const targetAfter = await deps.getTargetState(sessionId, workspacePath);
      return result(
        'interrupt_attempted',
        targetAfter,
        processingTriggerCalled,
        processingTriggerAccepted,
      );
    },
  };
}
