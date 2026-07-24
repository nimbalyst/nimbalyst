/**
 * Turn-level `ai_response_received` analytics for the Claude CLI proxy path
 * (NIM-806, Phase 4 parity gap).
 *
 * The SDK path fires `ai_response_received` once per turn from
 * `MessageStreamingHandler`, deriving responseType + toolsUsed from the observed
 * stream. The CLI bypasses that handler. The proxy emits one assembled assistant
 * message per API round (tool loops produce several), so the caller accumulates
 * tool names across the turn and calls this on the turn-end message (stopReason
 * other than `tool_use`). Pure so the payload shape is unit-testable.
 */

import { bucketContentLength } from './aiServiceUtils';

/** Chart/display tools, matched to the SDK's `usedChartTool` heuristic. */
const CHART_TOOL_NAMES = new Set([
  'display_chart',
  'mcp__nimbalyst__display_chart',
  'mcp__nimbalyst__display_to_user',
]);

export interface ClaudeCliResponseEvent {
  provider: 'claude-code-cli';
  responseType: 'tool_use' | 'text';
  toolsUsed: string[];
  usedChartTool: boolean;
  totalLength: string;
}

/** Build the `ai_response_received` payload from a turn's accumulated tool names + final text. */
export function buildClaudeCliResponseEvent(opts: {
  toolNames: string[];
  finalText: string;
}): ClaudeCliResponseEvent {
  const toolsUsed = [...new Set(opts.toolNames)];
  return {
    provider: 'claude-code-cli',
    responseType: toolsUsed.length > 0 ? 'tool_use' : 'text',
    toolsUsed,
    usedChartTool: toolsUsed.some((n) => CHART_TOOL_NAMES.has(n)),
    totalLength: bucketContentLength(opts.finalText.length),
  };
}
