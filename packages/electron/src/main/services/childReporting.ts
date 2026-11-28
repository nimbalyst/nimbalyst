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
 * Only `messages` requests informational progress. Both reporting modes defer
 * actionable returns to explicit authorization in the brief. The shared system
 * prompt says nothing about reporting.
 */
export type ChildReporting = 'none' | 'final' | 'messages';

const VALUES: readonly ChildReporting[] = ['none', 'final', 'messages'];

const ACTIONABLE_RETURN_GUIDANCE = 'If your brief explicitly authorizes or requires parent inspection, a decision, or continuation that the automatic final report will not satisfy, send one ordinary send_prompt with messageKind=instruction and interrupt=false, stating the requested action and exact artifact link. Do not send a manual return merely to duplicate automatic final delivery.';

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
      return `Your final response is delivered to the session that started you (${callerSessionId}) as your report. Do not send it status or acknowledgement messages. ${ACTIONABLE_RETURN_GUIDANCE}`;
    case 'messages':
      return `The session that started you (${callerSessionId}) asked for reports: send each material change once with send_prompt messageKind=report, unless your brief says otherwise. Manual send_prompt reports are informational and do not wake an idle parent. Your final response is delivered to it automatically. ${ACTIONABLE_RETURN_GUIDANCE}`;
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
