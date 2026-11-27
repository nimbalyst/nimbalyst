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
import type { SettingValue } from '../../shared/settings/keys';

export type ChildReporting = 'none' | 'final' | 'messages';
export type ChildReportingMode = SettingValue<'ai.childReportingMode'>;

const VALUES: readonly ChildReporting[] = ['none', 'final', 'messages'];

/** Validates the tool argument; an omitted value falls back to the legacy notifyOnComplete flag. */
export function resolveChildReporting(reporting: unknown, notifyOnComplete = false): ChildReporting {
  if (reporting === undefined || reporting === null) return notifyOnComplete ? 'final' : 'none';
  if (VALUES.includes(reporting as ChildReporting)) return reporting as ChildReporting;
  throw new Error(`Invalid reporting "${String(reporting)}": expected none, final or messages`);
}

/** The child's standing instruction, appended to its system prompt as its session directive. */
function childReportingDirective(reporting: ChildReporting, callerSessionId: string, mode: ChildReportingMode): string {
  if (reporting === 'none') return '';
  const progress = reporting === 'messages'
    ? `The session that started you (${callerSessionId}) asked for reports. Send each material change once with send_prompt messageKind=report, unless your brief says otherwise. These reports do not wake an idle parent.`
    : `The session that started you (${callerSessionId}) requested final reporting. Avoid status and acknowledgement messages.`;
  const final = mode === 'automatic'
    ? 'Your final response is delivered to it automatically while automatic reporting is enabled. Avoid duplicating automatic delivery.'
    : 'This child is in manual mode and no final response is forwarded automatically. Send a final report deliberately when warranted or requested.';
  const action = 'If your brief explicitly authorizes or requires a return for parent inspection, a decision, or continuation, send one send_prompt with messageKind=instruction and interrupt=false, stating the requested action and exact artifact link. Keep routine progress informational.';
  return `${progress} ${final} ${action}`;
}

/** Child-row metadata for a reporting mode. Written in the insert, before the first prompt is queued. */
export function childReportingMetadata(reporting: ChildReporting, callerSessionId: string, mode: ChildReportingMode): Record<string, unknown> {
  const directive = childReportingDirective(reporting, callerSessionId, mode);
  return {
    ...(reporting === 'none' ? { notifyParent: false } : {}),
    ...(mode === 'manual' && reporting !== 'none' ? { childReportingMode: mode } : {}),
    ...(directive ? { sessionDirective: directive } : {}),
  };
}
