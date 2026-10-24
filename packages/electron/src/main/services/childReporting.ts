/** Child reporting is deliberate messaging only; lifecycle reports are retired. */
export type ChildReporting = 'none' | 'final' | 'messages';

/** Preserve legacy plan-review choices without enabling automatic final delivery. */
export function resolveChildReporting(reporting: unknown, notifyOnComplete = false): ChildReporting {
  if (reporting === undefined || reporting === null) return notifyOnComplete ? 'final' : 'none';
  if (reporting === 'none' || reporting === 'final' || reporting === 'messages') return reporting;
  throw new Error(`Invalid reporting "${String(reporting)}": expected none, final or messages`);
}

export function childReportingDirective(reporting: ChildReporting, callerSessionId: string): string {
  return reporting === 'messages'
    ? `The session that started you (${callerSessionId}) asked for reports: send each material change once with send_prompt messageKind=report, unless your brief says otherwise. Send a final report deliberately only when warranted; no final response is forwarded automatically.`
    : '';
}

/** Preserve the existing plan-review opt-out independently of retired lifecycle transport. */
export function childReportingMetadata(reporting: ChildReporting, callerSessionId: string): Record<string, unknown> {
  const directive = childReportingDirective(reporting, callerSessionId);
  return { ...(reporting === 'none' ? { notifyParent: false } : {}), ...(directive ? { sessionDirective: directive } : {}) };
}
