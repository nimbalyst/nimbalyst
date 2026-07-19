import {
  PRIORITY_PROMPT_MAX_CHARS,
  type DeliverPriorityPromptInput,
  type PriorityPromptDeliveryResult,
} from './PriorityPromptDeliveryService';
import {
  handleInjectAttentionReply,
  type AttentionReplyDependencies,
  type AttentionReplyPromptType,
} from './AttentionReplyInjectionService';

export interface HostControlRequestV1 {
  version: 1;
  operation: 'watcher_obligation_event' | 'inject_attention_reply';
  sessionId?: string;
  prompt?: string;
  obligationId?: string;
  eventKey?: string;
  watchId?: string;
  promptId?: string;
  toolUseId?: string;
  attentionGeneration?: string;
  promptType?: AttentionReplyPromptType;
  answer?: unknown;
}

export interface HostControlDependencies {
  getSession(sessionId: string): Promise<{ id: string; workspacePath: string } | null>;
  deliverPriorityPrompt(
    input: DeliverPriorityPromptInput,
  ): Promise<PriorityPromptDeliveryResult>;
  attentionReply?: AttentionReplyDependencies;
}

export interface HostControlResponse {
  status: number;
  receipt: Record<string, unknown>;
}

// The HTTP transport has a stricter byte cap. These limits also keep direct
// calls to the pure handler from constructing unbounded queue identities.
const IDENTITY_MAX_CHARS = 512;

function reject(
  status: number,
  outcome: string,
  details: Record<string, unknown> = {},
): HostControlResponse {
  return {
    status,
    receipt: { accepted: false, outcome, ...details },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isBoundedNonEmptyString(value: unknown, maxChars: number): value is string {
  return typeof value === 'string'
    && value.trim().length > 0
    && value.length <= maxChars;
}

function classifyDeliveryError(error: unknown): {
  status: number;
  outcome: string;
  errorClass: string;
} {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('idempotency_conflict')) {
    return {
      status: 409,
      outcome: 'delivery_rejected',
      errorClass: 'idempotency_conflict',
    };
  }
  if (/not addressable|archived|retired/i.test(message)) {
    return {
      status: 409,
      outcome: 'delivery_rejected',
      errorClass: 'target_not_addressable',
    };
  }
  return {
    status: 500,
    outcome: 'internal_error',
    errorClass: error instanceof TypeError
      ? 'type_error'
      : error instanceof RangeError
        ? 'range_error'
        : error instanceof Error
          ? 'internal_error'
          : 'unknown_error',
  };
}

export async function handleHostControlRequest(
  deps: HostControlDependencies,
  body: unknown,
): Promise<HostControlResponse> {
  if (!isRecord(body)) {
    return reject(400, 'invalid_request', { errorClass: 'invalid_envelope' });
  }
  if (body.version !== 1) {
    return reject(400, 'invalid_request', { errorClass: 'unsupported_version' });
  }
  if (
    body.operation !== 'watcher_obligation_event'
    && body.operation !== 'inject_attention_reply'
  ) {
    return reject(400, 'invalid_request', { errorClass: 'unknown_operation' });
  }

  if (body.operation === 'inject_attention_reply') {
    if (!deps.attentionReply) return reject(501, 'not_yet_available');
    return handleInjectAttentionReply(
      deps.attentionReply,
      body as unknown as import('./AttentionReplyInjectionService').InjectAttentionReplyRequest,
    );
  }

  if (!isBoundedNonEmptyString(body.sessionId, IDENTITY_MAX_CHARS)) {
    return reject(400, 'invalid_request', { errorClass: 'invalid_session_id' });
  }
  if (!isBoundedNonEmptyString(body.prompt, PRIORITY_PROMPT_MAX_CHARS)) {
    return reject(400, 'invalid_request', { errorClass: 'invalid_prompt' });
  }
  if (!isBoundedNonEmptyString(body.obligationId, IDENTITY_MAX_CHARS)) {
    return reject(400, 'invalid_request', { errorClass: 'invalid_obligation_id' });
  }
  if (!isBoundedNonEmptyString(body.eventKey, IDENTITY_MAX_CHARS)) {
    return reject(400, 'invalid_request', { errorClass: 'invalid_event_key' });
  }

  const sessionId = body.sessionId;
  const prompt = body.prompt;
  const obligationId = body.obligationId;
  const eventKey = body.eventKey;
  try {
    const session = await deps.getSession(sessionId);
    if (!session || session.id !== sessionId || !session.workspacePath?.trim()) {
      return reject(404, 'session_not_found', { errorClass: 'stale_or_missing_session' });
    }

    const result = await deps.deliverPriorityPrompt({
      sessionId,
      workspacePath: session.workspacePath,
      prompt,
      idempotencyKey: `watcher-obligation:${obligationId}:${eventKey}`,
      producer: 'watcher_obligation_event',
      controlOperation: 'watcher_obligation_event',
    });

    if (result.verification.deliveryObserved === true) {
      return {
        status: 200,
        receipt: {
          accepted: true,
          outcome: 'priority_delivery_verified',
        },
      };
    }

    return reject(409, 'delivery_unverified', { action: result.action });
  } catch (error) {
    const classified = classifyDeliveryError(error);
    return reject(classified.status, classified.outcome, {
      errorClass: classified.errorClass,
    });
  }
}
