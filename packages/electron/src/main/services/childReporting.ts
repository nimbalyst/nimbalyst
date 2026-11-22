/**
 * How a spawned child reports back to the session that started it, chosen per
 * spawn (`reporting` on spawn_session / create_session).
 *
 * - none: fire-and-forget. No completion notification, nothing in the child's prompt.
 * - final: the caller gets the automatic completion notification, and the
 *   child's final response is its report.
 * - messages: as final, and the child may also send material changes mid-run
 *   with send_prompt messageKind=report.
 *
 * A child is only ever told to message its caller under `messages`. The shared
 * system prompt says nothing about reporting, so a brief or project rule that
 * forbids messages is never contradicted by injected text.
 */
export type ChildReporting = 'none' | 'final' | 'messages';

const VALUES: readonly ChildReporting[] = ['none', 'final', 'messages'];

/** Validates the tool argument; an omitted value falls back to the legacy notifyOnComplete flag. */
export function resolveChildReporting(reporting: unknown, notifyOnComplete = false): ChildReporting {
  if (reporting === undefined || reporting === null) return notifyOnComplete ? 'final' : 'none';
  if (VALUES.includes(reporting as ChildReporting)) return reporting as ChildReporting;
  throw new Error(`Invalid reporting "${String(reporting)}": expected none, final or messages`);
}

/** The child's standing instruction, appended to its system prompt as its session directive. */
export function childReportingDirective(reporting: ChildReporting, callerSessionId: string): string {
  switch (reporting) {
    case 'final':
      return `Your final response is delivered to the session that started you (${callerSessionId}) as your report. Do not send it status or acknowledgement messages.`;
    case 'messages':
      return `The session that started you (${callerSessionId}) asked for reports: send each material change once with send_prompt messageKind=report, unless your brief says otherwise. Your final response is delivered to it automatically.`;
    default:
      return '';
  }
}

/** Child-row metadata for a reporting mode. Written in the insert, before the first prompt is queued. */
export function childReportingMetadata(reporting: ChildReporting, callerSessionId: string): Record<string, unknown> {
  const directive = childReportingDirective(reporting, callerSessionId);
  return {
    ...(reporting === 'none' ? { notifyParent: false } : {}),
    ...(directive ? { sessionDirective: directive } : {}),
  };
}
