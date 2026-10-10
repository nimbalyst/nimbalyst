/**
 * Turn one session's raw `ai_agent_messages` rows into the inputs a page may
 * cite as a person's words (Decision 18): the person's prompts and their
 * answers to AskUserQuestion / PromptForUserInput, including what they typed.
 *
 * Raw rows are the only durable record (canonical events are not persisted),
 * and each provider writes them differently:
 *
 *   - Prompts: Claude Code SDK and the genuine CLI write `{prompt}` JSON, Codex
 *     and most other agents write the plain text. `promptProvenance.actor`
 *     separates a person from an orchestrator's send; rows from before
 *     provenance existed have no actor and are treated as the person's.
 *   - Questions: an assistant `tool_use` block (SDK), a synthetic
 *     `nimbalyst_tool_use` row (SDK canUseTool and the CLI), or a Codex
 *     app-server `mcpToolCall` item.
 *   - Answers: an `ask_user_question_response` / `request_user_input_response`
 *     row (desktop, mobile, Codex), the SDK's `tool_result` block, or the CLI's
 *     synthetic `nimbalyst_tool_result`. The first answer for a call wins; the
 *     same answer often arrives through two of these.
 *
 * Keys are stable across reads, backends and devices: a prompt's key is the id
 * personal sync gives the row (`providerMessageId`, else the content hash in
 * `CollabV3Sync.encryptMessage`), an answer's key is the tool call id the
 * transcript widget answers through.
 */

import { createHash } from 'node:crypto';
import { extractSearchable } from '@nimbalyst/runtime/ai/server/transcript/searchableTextExtractor';
import { citationMarkdown, type CitableInputKind } from './citationMarkdown';

export interface CitableRawRow {
  id: number | string;
  created_at: Date | string;
  source: string;
  direction: string;
  content: string;
  metadata: unknown;
  hidden: unknown;
  provider_message_id: string | null;
}

export interface CitableInput {
  kind: CitableInputKind;
  /** Stable within its kind; see the module header. */
  key: string;
  sessionId: string;
  /** Who said it. */
  by: string;
  /** Their email when known: the stable identity marks and citations are searched by. */
  email?: string;
  /** ISO 8601. */
  at: string;
  /** What it answered: the question, the form title, the commented passage, or "Prompt". */
  context: string;
  /** The person's own words, shortened. */
  quote: string;
  /** Answers: the full answer, every field, when it differs from the quote. */
  answer?: string;
  /** Answers: true when the quote is text the person typed rather than an option they picked. */
  typed?: boolean;
  /** Ready-to-paste citation markdown. Nothing is cited until the agent pastes it. */
  citation: string;
}

export const MAX_QUOTE_LENGTH = 400;

const INTERACTIVE_TOOLS = new Set(['AskUserQuestion', 'PromptForUserInput', 'RequestUserInput']);

/** Agent-written sources whose input rows are never a person's prompt. */
const AGENT_INPUT_SOURCES = new Set(['nimbalyst-meta-agent']);

type JsonRecord = Record<string, any>;

function asRecord(value: unknown): JsonRecord | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as JsonRecord;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  return null;
}

function toMillis(value: Date | string): number {
  return value instanceof Date ? value.getTime() : Date.parse(String(value));
}

function isHidden(value: unknown): boolean {
  return value === true || value === 1 || value === '1' || value === 't';
}

function toolBaseName(name: unknown): string {
  if (typeof name !== 'string') return '';
  const parts = name.split('__');
  return parts[parts.length - 1] || name;
}

export function shortenQuote(text: string, max = MAX_QUOTE_LENGTH): string {
  const clean = text.trim().replace(/\s+\n/g, '\n');
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/** The id `CollabV3Sync.encryptMessage` gives a row that has no provider id. */
export function personalSyncMessageId(row: Pick<CitableRawRow, 'provider_message_id' | 'created_at' | 'direction' | 'content'>, sessionId: string): string {
  if (row.provider_message_id) return row.provider_message_id;
  const hashInput = `${sessionId}:${toMillis(row.created_at)}:${row.direction}:${row.content.substring(0, 100)}`;
  return createHash('sha256').update(hashInput).digest('hex').slice(0, 32);
}

function humanPromptText(row: CitableRawRow, metadata: JsonRecord | null): string | null {
  if (row.direction !== 'input' || isHidden(row.hidden) || AGENT_INPUT_SOURCES.has(row.source)) return null;
  const actor = metadata?.promptProvenance?.actor;
  if (actor === 'agent' || actor === 'system') return null;
  if (metadata?.messageType === 'teammate_message_injected') return null;
  const { messageKind, searchableText } = extractSearchable({
    source: row.source,
    direction: 'input',
    content: row.content,
    metadata,
  });
  if (messageKind !== 'user' || !searchableText?.trim()) return null;
  return searchableText;
}

interface InteractiveCall {
  toolName: string;
  args: JsonRecord;
}

interface AnswerPayload {
  answers: JsonRecord;
}

/** Record every interactive tool call a row carries, by its call id. */
function collectCalls(parsed: JsonRecord, calls: Map<string, InteractiveCall>): void {
  const add = (id: unknown, name: unknown, args: unknown) => {
    const toolName = toolBaseName(name);
    if (typeof id !== 'string' || !id || !INTERACTIVE_TOOLS.has(toolName) || calls.has(id)) return;
    calls.set(id, { toolName, args: asRecord(args) ?? {} });
  };
  if (parsed.type === 'nimbalyst_tool_use') add(parsed.id, parsed.name, parsed.input);
  if (parsed.type === 'ask_user_question_request') {
    add(parsed.questionId, 'AskUserQuestion', { questions: parsed.questions });
  }
  if (parsed.type === 'assistant' && Array.isArray(parsed.message?.content)) {
    for (const block of parsed.message.content) {
      if (block?.type === 'tool_use') add(block.id, block.name, block.input ?? block.arguments);
    }
  }
  // Codex app-server notifications carry an MCP call as an item.
  const item = parsed.params?.item ?? parsed.item;
  if (item?.type === 'mcpToolCall' || item?.type === 'mcp_tool_call') {
    add(item.id, item.tool ?? item.name, item.arguments);
  }
}

function answersFromResultContent(content: unknown): AnswerPayload | null {
  if (typeof content === 'string') {
    const parsed = asRecord(content);
    if (parsed) return answersFromResultContent(parsed);
    // The SDK's AskUserQuestion result: `"question"="answer"` pairs.
    const answers: JsonRecord = {};
    for (const match of content.matchAll(/"([^"]+)"="([^"]*)"/g)) answers[match[1]!] = match[2];
    return Object.keys(answers).length > 0 ? { answers } : null;
  }
  if (Array.isArray(content)) {
    for (const block of content) {
      const text = block?.type === 'text' ? block.text : undefined;
      const found = typeof text === 'string' ? answersFromResultContent(text) : null;
      if (found) return found;
    }
    return null;
  }
  const record = asRecord(content);
  if (!record || record.cancelled === true) return null;
  const answers = asRecord(record.answers);
  return answers && Object.keys(answers).length > 0 ? { answers } : null;
}

/** The answer a row carries, keyed by the call it answers. */
function answerInRow(parsed: JsonRecord, calls: Map<string, InteractiveCall>): Array<{ callId: string; payload: AnswerPayload }> {
  const found: Array<{ callId: string; payload: AnswerPayload }> = [];
  const pick = (...ids: unknown[]): string | null => {
    const candidates = ids.filter((id): id is string => typeof id === 'string' && id.length > 0);
    return candidates.find((id) => calls.has(id)) ?? candidates[0] ?? null;
  };
  if (parsed.type === 'ask_user_question_response' || parsed.type === 'request_user_input_response') {
    const callId = parsed.type === 'ask_user_question_response'
      ? pick(parsed.questionId, parsed.rawQuestionId)
      : pick(parsed.promptId, parsed.rawPromptId);
    const answers = asRecord(parsed.answers);
    if (callId && parsed.cancelled !== true && answers && Object.keys(answers).length > 0) {
      found.push({ callId, payload: { answers } });
    }
    return found;
  }
  if (parsed.type === 'nimbalyst_tool_result' && typeof parsed.tool_use_id === 'string' && calls.has(parsed.tool_use_id)) {
    if (parsed.is_error !== true) {
      const payload = answersFromResultContent(parsed.result);
      if (payload) found.push({ callId: parsed.tool_use_id, payload });
    }
    return found;
  }
  const blocks = Array.isArray(parsed.message?.content) ? parsed.message.content : [];
  for (const block of blocks) {
    if (block?.type !== 'tool_result' || block.is_error === true) continue;
    const callId = block.tool_use_id ?? block.id;
    if (typeof callId !== 'string' || !calls.has(callId)) continue;
    const payload = answersFromResultContent(block.content);
    if (payload) found.push({ callId, payload });
  }
  const item = parsed.params?.item ?? parsed.item;
  if ((item?.type === 'mcpToolCall' || item?.type === 'mcp_tool_call') && typeof item.id === 'string' && calls.has(item.id)) {
    const payload = answersFromResultContent(item.result?.content ?? item.result);
    if (payload) found.push({ callId: item.id, payload });
  }
  return found;
}

interface AnswerEntry {
  key: string;
  context: string;
  quote: string;
  answer?: string;
  typed: boolean;
}

function optionLabels(question: JsonRecord | undefined): string[] {
  const options = Array.isArray(question?.options) ? question!.options : [];
  return options
    .map((option: unknown) => (typeof option === 'string' ? option : asRecord(option)?.label))
    .filter((label: unknown): label is string => typeof label === 'string');
}

function askUserQuestionEntries(callId: string, call: InteractiveCall | undefined, answers: JsonRecord): AnswerEntry[] {
  const questions: JsonRecord[] = Array.isArray(call?.args.questions) ? call!.args.questions : [];
  const answered = Object.keys(answers).filter((question) => typeof answers[question] === 'string' && answers[question].trim());
  return answered.map((questionText, index) => {
    const position = questions.findIndex((question) => question?.question === questionText);
    const labels = optionLabels(questions[position]);
    const answer = String(answers[questionText]).trim();
    // An "Other" answer replaces the picks, or follows them in a multi-select.
    const typedParts = labels.length === 0 || labels.includes(answer)
      ? []
      : answer.split(', ').filter((part) => !labels.includes(part));
    const typedText = typedParts.join(', ');
    const typed = typedText.length > 0;
    return {
      key: answered.length > 1 ? `${callId}~${position >= 0 ? position : index}` : callId,
      context: questionText,
      quote: shortenQuote(typed ? typedText : answer),
      ...(typed && typedText !== answer ? { answer } : {}),
      typed,
    };
  });
}

function fieldValue(field: JsonRecord | undefined, value: JsonRecord): { text: string; typed: string | null } | null {
  const optionTitle = (list: unknown, id: string): string => {
    const match = (Array.isArray(list) ? list : []).find((entry: JsonRecord) => entry?.id === id);
    return match?.label ?? match?.title ?? id;
  };
  switch (value.type) {
    case 'editText': {
      const text = typeof value.text === 'string' ? value.text.trim() : '';
      if (!text) return null;
      // An untouched draft is the agent's text that the person accepted.
      return { text, typed: value.edited === false ? null : text };
    }
    case 'singleSelect': {
      const other = typeof value.otherText === 'string' ? value.otherText.trim() : '';
      if (other) return { text: other, typed: other };
      return typeof value.selectedId === 'string' ? { text: optionTitle(field?.options, value.selectedId), typed: null } : null;
    }
    case 'multiSelect':
      return Array.isArray(value.selectedIds) && value.selectedIds.length > 0
        ? { text: value.selectedIds.map((id: string) => optionTitle(field?.items, id)).join(', '), typed: null }
        : null;
    case 'reorder':
      return Array.isArray(value.orderedIds) && value.orderedIds.length > 0
        ? { text: value.orderedIds.map((id: string) => optionTitle(field?.items, id)).join(' > '), typed: null }
        : null;
    case 'confirm':
      return typeof value.value === 'boolean' ? { text: value.value ? 'Yes' : 'No', typed: null } : null;
    default:
      return null;
  }
}

function promptForUserInputEntry(callId: string, call: InteractiveCall | undefined, answers: JsonRecord): AnswerEntry | null {
  const fields: JsonRecord[] = Array.isArray(call?.args.fields) ? call!.args.fields : [];
  const fieldIds = fields.length > 0 ? fields.map((field) => field?.id).filter((id): id is string => typeof id === 'string') : Object.keys(answers);
  const lines: string[] = [];
  const typedTexts: string[] = [];
  for (const fieldId of fieldIds) {
    const value = asRecord(answers[fieldId]);
    if (!value) continue;
    const field = fields.find((candidate) => candidate?.id === fieldId);
    const rendered = fieldValue(field, value);
    if (!rendered) continue;
    lines.push(`${field?.label ?? fieldId}: ${rendered.text}`);
    if (rendered.typed) typedTexts.push(rendered.typed);
  }
  if (lines.length === 0) return null;
  const title = typeof call?.args.title === 'string' && call.args.title.trim()
    ? call.args.title.trim()
    : typeof call?.args.intro === 'string' && call.args.intro.trim()
      ? call.args.intro.trim().split('\n')[0]!
      : 'Input requested';
  const answer = lines.join('; ');
  const typed = typedTexts.length > 0;
  return {
    key: callId,
    context: title,
    quote: shortenQuote(typed ? typedTexts.join(' / ') : answer),
    answer,
    typed,
  };
}

export interface CollectCitableInputsOptions {
  sessionId: string;
  /** The person this session belongs to; prompts and answers are theirs. */
  author: string;
  /** Their email, the stable identity citations are searched by. */
  authorEmail?: string;
}

/** Rows must be in insertion order (`ORDER BY id`). */
export function collectCitableInputsFromRows(rows: CitableRawRow[], options: CollectCitableInputsOptions): CitableInput[] {
  const { sessionId, author, authorEmail } = options;
  const calls = new Map<string, InteractiveCall>();
  const answeredCalls = new Set<string>();
  const inputs: CitableInput[] = [];

  const push = (kind: CitableInputKind, row: CitableRawRow, entry: Omit<CitableInput, 'kind' | 'sessionId' | 'by' | 'email' | 'at' | 'citation'>) => {
    const at = new Date(toMillis(row.created_at)).toISOString();
    inputs.push({
      kind,
      sessionId,
      by: author,
      ...(authorEmail ? { email: authorEmail } : {}),
      at,
      ...entry,
      citation: citationMarkdown({
        sessionId,
        kind,
        key: entry.key,
        by: author,
        email: authorEmail,
        at,
        ...(kind === 'answer' ? { context: `answering ${shortenQuote(entry.context, 80)}` } : {}),
        quote: entry.quote,
      }),
    });
  };

  for (const row of rows) {
    const metadata = asRecord(row.metadata);
    const promptText = humanPromptText(row, metadata);
    if (promptText) {
      push('prompt', row, {
        key: personalSyncMessageId(row, sessionId),
        context: 'Prompt',
        quote: shortenQuote(promptText),
      });
      continue;
    }
    if (row.direction === 'input') continue;
    const parsed = asRecord(row.content);
    if (!parsed) continue;
    collectCalls(parsed, calls);
    for (const { callId, payload } of answerInRow(parsed, calls)) {
      if (answeredCalls.has(callId)) continue;
      const call = calls.get(callId);
      const isForm = call ? call.toolName !== 'AskUserQuestion' : parsed.type === 'request_user_input_response';
      const entries = isForm
        ? [promptForUserInputEntry(callId, call, payload.answers)].filter((entry): entry is AnswerEntry => entry !== null)
        : askUserQuestionEntries(callId, call, payload.answers);
      if (entries.length === 0) continue;
      answeredCalls.add(callId);
      for (const entry of entries) push('answer', row, entry);
    }
  }
  return inputs;
}
