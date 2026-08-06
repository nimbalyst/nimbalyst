import { createHash, randomUUID } from 'crypto';

/** Durable, content-free receipts for the logical composer payload. */
export interface QueuedPromptPayloadReceipt {
  utf8Bytes: number;
  unicodeScalars: number;
  sha256: string;
}

export interface QueuedPromptTruth {
  clientSubmissionId: string;
  queueRowId: string;
  sourceSessionId: string;
  sourceRoomId: string;
  producer: string;
  payload: QueuedPromptPayloadReceipt;
}

/**
 * Receipt the exact JS string supplied by the composer. Array.from counts
 * Unicode scalars (not UTF-16 code units) and Buffer supplies the exact UTF-8
 * bytes that are hashed. Never trim or normalize this input.
 */
export function receiptQueuedPromptPayload(payload: string): QueuedPromptPayloadReceipt {
  const bytes = Buffer.from(payload, 'utf8');
  return {
    utf8Bytes: bytes.byteLength,
    unicodeScalars: Array.from(payload).length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

export function payloadReceiptsMatch(
  payload: string,
  receipt: QueuedPromptPayloadReceipt,
): boolean {
  const actual = receiptQueuedPromptPayload(payload);
  return actual.utf8Bytes === receipt.utf8Bytes
    && actual.unicodeScalars === receipt.unicodeScalars
    && actual.sha256 === receipt.sha256;
}

/** Generate identities once at the producer boundary; callers may supply legacy IDs. */
export function createQueuedPromptTruth(input: {
  queueRowId?: string;
  clientSubmissionId?: string;
  sourceSessionId: string;
  sourceRoomId?: string;
  producer: string;
  payload: string;
}): QueuedPromptTruth {
  const queueRowId = input.queueRowId ?? randomUUID();
  return {
    queueRowId,
    clientSubmissionId: input.clientSubmissionId ?? queueRowId,
    sourceSessionId: input.sourceSessionId,
    sourceRoomId: input.sourceRoomId ?? input.sourceSessionId,
    producer: input.producer,
    payload: receiptQueuedPromptPayload(input.payload),
  };
}

export function queueTruthMismatchError(): Error {
  // Deliberately content-free: prompt text must never escape through errors/logs.
  return new Error('Queued prompt payload receipt mismatch');
}
