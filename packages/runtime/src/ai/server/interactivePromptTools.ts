/**
 * Which tools are interactive prompts, and how to recognise the harness's
 * "I moved this call to the background" acknowledgement.
 *
 * Both live here rather than next to a single consumer because three layers
 * need them and they must agree: the transcript parser (persisted/reload path),
 * the live Claude Code stream path, and the transcript UI.
 */

/**
 * Interactive tool widgets that require the user to act. These render even when
 * `settings.showToolCalls` is false, so the user can still respond to prompts
 * (permission grants, plan-mode exits, question answers, structured input
 * prompts, commit proposals).
 */
export const INTERACTIVE_WIDGET_TOOLS = new Set([
  'ToolPermission',
  'ExitPlanMode',
  'AskUserQuestion',
  'PromptForUserInput',
  'RequestUserInput',
  'GitCommitProposal',
  'git_commit_proposal',
  'developer_git_commit_proposal',
  'developer.git_commit_proposal',
]);

/**
 * MCP tools arrive as `mcp__<server>__<toolName>` (server name may contain
 * dashes or underscores). When the tool was registered with a bare name like
 * `AskUserQuestion` on the in-app MCP server, the SDK forwards it as
 * `mcp__nimbalyst-mcp__AskUserQuestion`. Strict equality against the bare set
 * misses, so callers compare the un-prefixed name.
 */
export function stripMcpPrefix(toolName: string): string {
  const match = toolName.match(/^mcp__[^_]+(?:_[^_]+)*__(.+)$/);
  return match ? match[1] : toolName;
}

export function isInteractiveWidgetTool(toolName: string | null | undefined): boolean {
  if (!toolName) return false;
  return INTERACTIVE_WIDGET_TOOLS.has(stripMcpPrefix(toolName));
}

/**
 * Interactive tools that ask the user a question. Permission, plan-mode and
 * commit prompts have their own lifecycle and navigation and are excluded.
 */
const QUESTION_TOOLS = new Set(['AskUserQuestion', 'PromptForUserInput', 'RequestUserInput']);

export function isQuestionTool(toolName: string | null | undefined): boolean {
  if (!toolName) return false;
  return QUESTION_TOOLS.has(stripMcpPrefix(toolName));
}

export interface UnansweredQuestion {
  /** The tool call's providerToolCallId (the id the answer IPC keys on). */
  id: string;
  toolName: string;
  /** Index of the question's row in the input array (its last occurrence). */
  index: number;
}

interface QuestionScanMessage {
  type?: string;
  text?: string;
  promptActor?: string;
  promptOrigin?: string;
  optimistic?: boolean;
  toolCall?: { toolName?: string; providerToolCallId?: string | null; result?: unknown } | null;
}

/**
 * The answer auto-resume (desktop and Codex recovery) sends this prefix. Rows
 * recorded before prompt provenance was carried onto transcript events are
 * recognised by it.
 */
const ANSWER_RESUME_PREFIX = '[Resuming after answering a question]';

/**
 * Whether a message is a human turn, the only thing that closes an open
 * question. Agent sends (`send_prompt`, child-session updates), system sends
 * and the answer auto-resume leave questions open, and so does an optimistic
 * row the send has not persisted yet. A user message with no provenance is
 * treated as human: older human rows never recorded it.
 */
function isHumanTurnBoundary(message: QuestionScanMessage): boolean {
  if (message.type !== 'user_message' || message.optimistic) return false;
  if (message.promptActor === 'agent' || message.promptActor === 'system') return false;
  if (message.promptOrigin === 'interactive-question') return false;
  return !message.text?.startsWith(ANSWER_RESUME_PREFIX);
}

/**
 * Split question tool calls that have no result by the last human turn (see
 * `isHumanTurnBoundary`).
 *
 * A question asked before the user's latest message was superseded by it: the
 * user chose to start a new turn instead of answering, so the question is
 * closed even when no terminal result was ever written for it. Only questions
 * after the last user message are still open. (Stopping a turn writes no user
 * message, so a question left open by a cancel stays answerable.)
 *
 * Provider echoes can repeat a tool call; the last occurrence wins, matching
 * the transcript's own de-duplication. A backgrounded-ack result (#1341) has
 * already been blanked by the projector, so it counts as no result here.
 */
export function partitionUnansweredQuestions(messages: readonly QuestionScanMessage[]): {
  open: UnansweredQuestion[];
  superseded: UnansweredQuestion[];
} {
  const open: UnansweredQuestion[] = [];
  const superseded: UnansweredQuestion[] = [];
  const seen = new Set<string>();
  let afterLastUserMessage = true;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.type === 'user_message') {
      if (isHumanTurnBoundary(message)) afterLastUserMessage = false;
      continue;
    }
    const tool = message.toolCall;
    const id = tool?.providerToolCallId;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    if (!isQuestionTool(tool.toolName) || tool.result) continue;
    (afterLastUserMessage ? open : superseded).push({ id, toolName: stripMcpPrefix(tool.toolName ?? ''), index });
  }
  return { open: open.reverse(), superseded: superseded.reverse() };
}

/**
 * Claude Code parks a call that is taking too long and puts a synthetic
 * acknowledgement in the tool_result slot. It is a launch acknowledgement, not
 * a completion — the call keeps running and its real result arrives later as a
 * task notification.
 *
 * Two families of wording, both prose-only because the harness attaches no
 * structured marker to either:
 *
 * - Bash / sub-agents (NIM-1470, NIM-1556): "Command did not complete within
 *   its 120s timeout and was moved to the background (ID: …)", "Task is now
 *   running in the background", "Async agent launched successfully…".
 * - MCP tool calls (#1341, harness symbol `callMcpToolWithAutoBackground`,
 *   default 120s): `MCP tool "<server> - <tool> (MCP)" is still running after
 *   120s. It was moved to the background as task <id> and keeps running; …`.
 *
 * The wording has been widened twice already, so match loosely and let callers
 * decide how much to trust it.
 */
const BACKGROUNDED_TOOL_ACK =
  /moved to the background|running in (?:the )?background|working in the background|async agent launched/i;

/**
 * Whether a tool result is one of those acknowledgements rather than a real
 * result.
 *
 * Interactive prompts settle with a JSON payload (`{"answers":…}`,
 * `{"cancelled":true}`), so anything that parses as JSON is a genuine result —
 * that guard is what keeps a user who literally types "moved to the background"
 * into an Other field from wedging their own prompt.
 */
export function isBackgroundedToolAck(resultText: unknown): boolean {
  if (typeof resultText !== 'string') return false;
  const trimmed = resultText.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return false;
  return BACKGROUNDED_TOOL_ACK.test(trimmed);
}
