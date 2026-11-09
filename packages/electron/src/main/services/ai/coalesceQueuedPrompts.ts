/**
 * Drain-time coalescing of queued prompts, user and agent alike.
 *
 * The queue drains one row per turn. That is correct for a human at the
 * composer, but it makes orchestration unbounded: every child report and every
 * [Child Session Update] costs the parent a whole turn, so a parent driving
 * five children falls further behind with each one. Messages then arrive faster
 * than they drain and the parent ends up acting on notes that later rows in the
 * same queue already corrected.
 *
 * Merging at drain time rather than at enqueue time is deliberate. At drain we
 * have the freshest set, so supersession resolves for free -- the agent reads
 * "final, frozen", "frozen again", and "correction to last note" together and
 * acts once. Enqueue-time merging cannot know what is still coming, and the
 * renderer's composer-side merge additionally races the drain.
 *
 * Precedent for the shape: ClaudeCodeProvider.drainAndFormatPendingTeammateMessages
 * and AgentMentionDispatchService's inbox-wake grouping both already collapse
 * many notifications into one turn. This applies the same idea to the queue.
 */

import type { DocumentContext } from '@nimbalyst/runtime/ai/server/types';

export interface CoalescibleQueuedPrompt {
  id: string;
  prompt: string;
  attachments?: unknown[] | null;
  documentContext?: DocumentContext | null;
}

/**
 * Upper bound on rows folded into one turn, so a queue that has been building
 * for an hour cannot produce a single prompt too large to act on. The remainder
 * stays pending and drains on the next turn.
 */
export const MAX_COALESCED_PROMPTS = 20;

type Author = { kind: 'user' } | { kind: 'agent'; originSessionId?: string };

/**
 * Who wrote a row. Rows without a known human or agent author (no provenance,
 * or a `system` actor) return null: they cannot be labeled honestly, so they
 * keep a turn of their own.
 */
function authorOf(prompt: CoalescibleQueuedPrompt): Author | null {
  const provenance = prompt.documentContext?.promptProvenance;
  if (provenance?.actor === 'human') return { kind: 'user' };
  if (provenance?.actor === 'agent') return { kind: 'agent', originSessionId: provenance.originSessionId };
  return null;
}

function authorLabel(author: Author | null): string {
  if (!author || author.kind === 'user') return 'user';
  return author.originSessionId ? `agent: ${author.originSessionId}` : 'agent';
}

/**
 * Slash commands (`/compact`, `/clear`, `/plugin:skill args`) only act as the
 * first thing in a turn, so a command row is never merged in either direction.
 * A leading absolute path ("/Users/me/x.ts is broken") is not a command.
 */
function isSlashCommand(prompt: CoalescibleQueuedPrompt): boolean {
  return /^\s*\/[A-Za-z][\w:.-]*(?=\s|$)/.test(prompt.prompt);
}

/**
 * Context fields that never block a merge. Provenance becomes the per-message
 * author label (and is resolved for the whole turn in mergeClaimedRun);
 * attachments accumulate across the run; the queued-prompt id is set per turn
 * by the dispatcher; a selection timestamp only ages a selection whose text is
 * compared separately. Every other field -- file, content, selection, mode,
 * worktree, origin, and any field added later -- says where or how the turn
 * runs, and only the head's copy survives a merge.
 */
const MERGE_NEUTRAL_CONTEXT_KEYS = new Set([
  'promptProvenance',
  'attachments',
  'queuedPromptId',
  'textSelectionTimestamp',
]);

function isEmptyContextValue(value: unknown): boolean {
  return value === undefined || value === null || value === ''
    || (Array.isArray(value) && value.length === 0);
}

function sameContextValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const aKeys = Object.keys(a).filter((key) => (a as Record<string, unknown>)[key] !== undefined);
  const bKeys = Object.keys(b).filter((key) => (b as Record<string, unknown>)[key] !== undefined);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((key) =>
    sameContextValue((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
}

/**
 * True when merging `row` behind `head` loses nothing: every context field the
 * row sets is set identically on the head. A row that sets nothing (a typical
 * agent report) asserts nothing about the turn and merges under the head's
 * context; a row that sets something the head lacks or sets differently would
 * have its context dropped, so it stays separate.
 */
function contextFitsHead(head: CoalescibleQueuedPrompt, row: CoalescibleQueuedPrompt): boolean {
  const headContext = (head.documentContext ?? {}) as Record<string, unknown>;
  const rowContext = (row.documentContext ?? {}) as Record<string, unknown>;
  return Object.keys(rowContext).every((key) => {
    if (MERGE_NEUTRAL_CONTEXT_KEYS.has(key)) return true;
    const value = rowContext[key];
    if (isEmptyContextValue(value)) return true;
    return sameContextValue(headContext[key], value);
  });
}

function canMerge(prompt: CoalescibleQueuedPrompt): boolean {
  return authorOf(prompt) !== null && !isSlashCommand(prompt);
}

/**
 * The leading run of rows safe to deliver as a single turn.
 *
 * User and agent rows merge alike, oldest first (#1933): a thought typed as
 * several short messages reaches the agent whole, and one Send Now delivers
 * everything pending. "Stop and do this instead" stays safe because the agent
 * reads the whole run, labeled by author, before acting. The run ends at the
 * first row that cannot share a turn: a slash command, a row with no known
 * author, or a row whose context the head's would replace.
 */
export function selectCoalescibleRun<T extends CoalescibleQueuedPrompt>(
  pending: readonly T[],
  maxBatch: number = MAX_COALESCED_PROMPTS,
): T[] {
  const head = pending[0];
  if (!head) return [];
  if (!canMerge(head)) return [head];

  const run: T[] = [head];
  for (let i = 1; i < pending.length && run.length < maxBatch; i++) {
    const next = pending[i];
    if (!canMerge(next) || !contextFitsHead(head, next)) break;
    run.push(next);
  }
  return run;
}

const LABEL_LINE = /^\s*--- message \d+ of \d+/i;

/**
 * A body line shaped like a label is escaped so one message cannot forge
 * another's boundary or claim to be from the user.
 */
function escapeLabelLines(text: string): string {
  return text
    .split('\n')
    .map((line) => (LABEL_LINE.test(line) ? `\\${line}` : line))
    .join('\n');
}

export interface CoalescedMessage {
  prompt: string;
  /** `user`, `agent`, or `agent: <origin session id>`. */
  author?: string;
}

/**
 * Render a merged run. The header matters as much as the joining: without it an
 * agent reads a concatenation as one long instruction rather than as several
 * messages that arrived over time, and misses that the last one may retract the
 * first. Author labels keep agent text from reading as the user's instruction
 * once both share a turn (#934).
 */
export function formatCoalescedPrompt(messages: readonly (string | CoalescedMessage)[]): string {
  const normalized = messages.map((message) => (typeof message === 'string' ? { prompt: message } : message));
  if (normalized.length === 0) return '';
  if (normalized.length === 1) return normalized[0].prompt;

  const header =
    `[${normalized.length} messages arrived while you were working, oldest first. ` +
    `Later messages may correct or supersede earlier ones -- read all of them before acting. ` +
    `Each is labeled with its author; only messages labeled (user) come from the user.]`;

  const body = normalized.map(({ prompt, author }, index) => {
    const label = `--- message ${index + 1} of ${normalized.length}${author ? ` (${author})` : ''} ---`;
    return `${label}\n${escapeLabelLines(prompt)}`;
  });

  return [header, ...body].join('\n\n');
}

/**
 * Collapse a claimed run into the single prompt the turn will deliver. The head
 * row supplies the document context because it is the one whose id becomes the
 * turn's `queuedPromptId`; selectCoalescibleRun only admits rows whose context
 * the head's already covers. Attachments accumulate across the whole run so a
 * merged row never silently drops a file. When any row is the user's, the
 * turn carries that row's provenance: a turn with a person's message in it is
 * a human turn (it supersedes open questions), even behind an agent report.
 */
export function mergeClaimedRun<T extends CoalescibleQueuedPrompt>(run: readonly T[]): T {
  const head = run[0];
  if (run.length === 1) return head;

  const attachments = run.flatMap((row) => row.attachments ?? []);
  const firstHuman = run.find((row) => authorOf(row)?.kind === 'user');
  const documentContext =
    firstHuman && firstHuman !== head && head.documentContext
      ? { ...head.documentContext, promptProvenance: firstHuman.documentContext?.promptProvenance }
      : head.documentContext;

  return {
    ...head,
    documentContext,
    prompt: formatCoalescedPrompt(run.map((row) => ({ prompt: row.prompt, author: authorLabel(authorOf(row)) }))),
    attachments: attachments.length > 0 ? attachments : head.attachments ?? null,
  };
}
