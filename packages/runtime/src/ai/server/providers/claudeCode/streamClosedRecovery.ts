import type { DrainExitCause } from './subagentDrain';

export type StreamClosedContinuationReason =
  | 'retry'
  | 'exhausted'
  | 'not-applicable'
  | 'aborted';

export interface StreamClosedContinuationDecision {
  continue: boolean;
  reason: StreamClosedContinuationReason;
}

export function classifyStreamClosedContinuation(params: {
  sawStreamClosed: boolean;
  retryCount: number;
  maxRetries: number;
  drainExitCause: DrainExitCause;
  hasPendingUserStop: boolean;
}): StreamClosedContinuationDecision {
  if (!params.sawStreamClosed) {
    return { continue: false, reason: 'not-applicable' };
  }
  if (
    params.hasPendingUserStop
    || params.drainExitCause === 'aborted'
    || params.drainExitCause === 'interrupted'
  ) {
    return { continue: false, reason: 'aborted' };
  }
  if (params.retryCount >= params.maxRetries) {
    return { continue: false, reason: 'exhausted' };
  }
  return { continue: true, reason: 'retry' };
}

export function buildStreamClosedContinuationMessage(toolName?: string): string {
  const toolClause = toolName ? ` while running ${toolName}` : '';
  return (
    `[System: A tool call${toolClause} failed with a transient "Stream closed" transport error. `
    + 'This was not a completed tool failure. Re-run the action you were attempting and continue the work.]'
  );
}

export function extractStreamClosedToolName(params: {
  isError: boolean;
  resultText: string;
  toolName?: string;
}): string | null {
  if (!params.isError) return null;
  if (!params.resultText.includes('Stream closed')) return null;
  return params.toolName || null;
}
