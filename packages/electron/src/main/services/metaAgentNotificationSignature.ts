/**
 * Pure helper for MetaAgentService's [Child Session Update] notification
 * dedup gate. Lives in its own file so it can be unit-tested without
 * pulling in Electron, the AI providers, or the PGLite worker.
 */

export type NotificationEventType =
  | 'session:completed'
  | 'session:error'
  | 'session:waiting'
  | 'session:interrupted';

export interface NotificationSignatureInput {
  status: string;
  pendingPrompt?: { promptId: string } | null;
  lastResponse?: string | null;
  errorMessage?: string | null;
}

/**
 * Build a stable dedup key for a parent notification. Two events whose
 * components all match collapse into one notification; any differing
 * component (including errorMessage so two distinct errors with the same
 * lastResponse still get through) produces a distinct signature.
 *
 * The signature is reset on session:started/session:streaming in
 * MetaAgentService so it only collapses duplicates within a single child
 * turn -- not across turns. Without that reset, a child whose two
 * consecutive turns happen to end with the same final text (e.g. "done")
 * would silence the second notification.
 */
export function computeNotificationSignature(
  eventType: NotificationEventType,
  result: NotificationSignatureInput
): string {
  return [
    eventType,
    result.status,
    result.pendingPrompt?.promptId ?? '',
    result.lastResponse ?? '',
    result.errorMessage ?? '',
  ].join(':');
}
