/**
 * What the person at a terminal typed in one Claude Code session, as citable
 * inputs: their prompts (and slash-command arguments) and their answers to
 * AskUserQuestion. Everything else in a transcript is excluded on purpose:
 * programmatic prompts (`-p`, SDK hosts, orchestrators), task notifications
 * and peer messages, injected context (`isMeta`), compaction summaries, local
 * command output, tool results, and subagent records. Pasted blocks become
 * `[pasted]`: they are usually logs, which can hold secrets, and they are not
 * the person's words.
 *
 * Same entry shape and answer rules as the desktop's citable inputs, with
 * citations built by the shared citation syntax so the page editor reads them
 * back as a Claude Code session citation.
 *
 * Pure: takes the JSONL text, returns the entries.
 */

import { createHumanCitation, formatCitationMarkdown } from '@nimbalyst/runtime/core/citationSyntax';

export type SessionInputKind = 'prompt' | 'answer';

export const MAX_QUOTE_LENGTH = 400;

export interface SessionCitableInput {
  kind: SessionInputKind;
  /** Prompt record `uuid`, or the AskUserQuestion `toolu_` id (with `~<index>` when it asked several). */
  key: string;
  /** The Claude Code session id. */
  sessionId: string;
  agent: 'claude-code';
  by: string;
  email?: string;
  /** ISO 8601. */
  at: string;
  context: string;
  quote: string;
  answer?: string;
  typed?: boolean;
  /** Ready-to-paste citation markdown. */
  citation: string;
}

export interface TranscriptAuthor {
  sessionId: string;
  /** The person at the terminal: every prompt and answer in the main chain is theirs. */
  by: string;
  email?: string;
}

type JsonRecord = Record<string, any>;

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : null;
}

export function shortenQuote(text: string, max = MAX_QUOTE_LENGTH): string {
  const clean = text.trim().replace(/\s+\n/g, '\n');
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

const PASTED = /<pasted_content\b[^>]*>[\s\S]*?<\/pasted_content>/g;
const COMMAND_NAME = /<command-name>\s*(\/[^<\s]+)\s*<\/command-name>/;
const COMMAND_ARGS = /<command-args>([\s\S]*?)<\/command-args>/;

/** The text of a user message, or null when it holds anything but text and images. */
function messageText(content: unknown): string | null {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  const texts: string[] = [];
  for (const block of content) {
    const record = asRecord(block);
    if (record?.type === 'text' && typeof record.text === 'string') texts.push(record.text);
    else if (record?.type !== 'image') return null;
  }
  return texts.join('\n');
}

/** Whether a main-chain user record is a person typing, by the markers Claude Code writes. */
function isTypedByPerson(record: JsonRecord): boolean {
  if (record.isMeta || record.isCompactSummary || record.toolUseResult !== undefined) return false;
  if (record.entrypoint === 'sdk-cli') return false;
  if (record.turnOrigin !== undefined && record.turnOrigin !== 'human') return false;
  if (record.promptSource !== undefined) return record.promptSource === 'typed';
  // Older transcripts carry no source; injected text there starts with a tag.
  return true;
}

function promptEntry(record: JsonRecord): { context: string; quote: string } | null {
  const raw = messageText(record.message?.content);
  if (raw === null) return null;
  const command = COMMAND_NAME.exec(raw);
  if (command) {
    // A slash command the person typed: only its arguments are their words.
    const args = (COMMAND_ARGS.exec(raw)?.[1] ?? '').trim();
    return args ? { context: command[1]!, quote: shortenQuote(args.replace(PASTED, '[pasted]')) } : null;
  }
  if (record.promptSource === undefined && raw.trimStart().startsWith('<')) return null;
  if (/^\s*<(local-command-|task-notification|system-reminder)/.test(raw)) return null;
  const text = raw.replace(PASTED, '[pasted]').trim();
  if (!text || text === '[pasted]') return null;
  return { context: 'Prompt', quote: shortenQuote(text) };
}

function optionLabels(question: JsonRecord | undefined): string[] {
  const options = Array.isArray(question?.options) ? question!.options : [];
  return options
    .map((option: unknown) => (typeof option === 'string' ? option : asRecord(option)?.label))
    .filter((label: unknown): label is string => typeof label === 'string');
}

interface AnswerEntry {
  key: string;
  context: string;
  quote: string;
  answer?: string;
  typed: boolean;
}

/** AskUserQuestion answers, with the desktop's key and typed-text rules. */
function answerEntries(callId: string, askedQuestions: JsonRecord[], result: JsonRecord): AnswerEntry[] {
  const answers = asRecord(result.answers);
  if (!answers) return [];
  const questions: JsonRecord[] = Array.isArray(result.questions) ? result.questions : askedQuestions;
  const annotations = asRecord(result.annotations) ?? {};
  const answered = Object.keys(answers).filter((question) => typeof answers[question] === 'string' && answers[question].trim());
  return answered.map((questionText, index) => {
    const position = questions.findIndex((question) => question?.question === questionText);
    const labels = optionLabels(questions[position]);
    const answer = String(answers[questionText]).trim();
    // Compare the whole answer with the labels first: a label may contain ", ".
    const otherParts = labels.length === 0 || labels.includes(answer)
      ? []
      : answer.split(', ').filter((part) => !labels.includes(part));
    const note = typeof asRecord(annotations[questionText])?.notes === 'string' ? asRecord(annotations[questionText])!.notes.trim() : '';
    const typedText = [otherParts.join(', '), note].filter(Boolean).join(' / ');
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

function toolResultBlock(record: JsonRecord): JsonRecord | null {
  const content = record.message?.content;
  const first = Array.isArray(content) ? asRecord(content[0]) : null;
  return first?.type === 'tool_result' ? first : null;
}

/** Every citable input in a session's main transcript, oldest first. */
export function citableInputsFromTranscript(jsonl: string, author: TranscriptAuthor): SessionCitableInput[] {
  const askCalls = new Map<string, JsonRecord[]>();
  const answeredCalls = new Set<string>();
  const inputs: SessionCitableInput[] = [];

  const push = (kind: SessionInputKind, at: string, entry: { key: string; context: string; quote: string; answer?: string; typed?: boolean }) => {
    inputs.push({
      kind,
      key: entry.key,
      sessionId: author.sessionId,
      agent: 'claude-code',
      by: author.by,
      ...(author.email ? { email: author.email } : {}),
      at,
      context: entry.context,
      quote: entry.quote,
      ...(entry.answer !== undefined ? { answer: entry.answer } : {}),
      ...(entry.typed !== undefined ? { typed: entry.typed } : {}),
      citation: formatCitationMarkdown(createHumanCitation({
        agent: 'claude-code',
        sessionId: author.sessionId,
        inputKind: kind,
        key: entry.key,
        by: author.by,
        ...(author.email ? { email: author.email } : {}),
        at,
        ...(kind === 'answer' ? { context: `answering ${shortenQuote(entry.context, 80)}` } : entry.context !== 'Prompt' ? { context: entry.context } : {}),
        quote: entry.quote,
      })),
    });
  };

  for (const line of jsonl.split('\n')) {
    if (!line.trim()) continue;
    let record: JsonRecord | null;
    try {
      record = asRecord(JSON.parse(line));
    } catch {
      continue;
    }
    if (!record || record.isSidechain === true) continue;
    const at = typeof record.timestamp === 'string' ? record.timestamp : '';

    if (record.type === 'assistant') {
      for (const block of Array.isArray(record.message?.content) ? record.message.content : []) {
        if (block?.type === 'tool_use' && block.name === 'AskUserQuestion' && typeof block.id === 'string') {
          askCalls.set(block.id, Array.isArray(block.input?.questions) ? block.input.questions : []);
        }
      }
      continue;
    }
    if (record.type !== 'user' || !at) continue;

    const result = toolResultBlock(record);
    if (result) {
      const callId = typeof result.tool_use_id === 'string' ? result.tool_use_id : '';
      const asked = askCalls.get(callId);
      const payload = asRecord(record.toolUseResult);
      if (!asked || answeredCalls.has(callId) || result.is_error === true || !payload) continue;
      const entries = answerEntries(callId, asked, payload);
      if (entries.length === 0) continue;
      answeredCalls.add(callId);
      for (const entry of entries) push('answer', at, entry);
      continue;
    }

    if (!isTypedByPerson(record) || typeof record.uuid !== 'string') continue;
    const prompt = promptEntry(record);
    if (prompt) push('prompt', at, { key: record.uuid, ...prompt });
  }
  return inputs;
}

export interface InputSelection {
  kinds?: readonly SessionInputKind[];
  query?: string;
  /** Default 50, at most 200; the newest are kept. */
  limit?: number;
}

export function selectInputs(inputs: readonly SessionCitableInput[], selection: InputSelection = {}): SessionCitableInput[] {
  const kinds = selection.kinds && selection.kinds.length > 0 ? new Set(selection.kinds) : null;
  const query = selection.query?.trim().toLowerCase();
  const limit = Math.min(Math.max(1, Math.floor(selection.limit ?? 50)), 200);
  const matched = inputs.filter((input) =>
    (!kinds || kinds.has(input.kind))
    && (!query || `${input.quote}\n${input.context}\n${input.answer ?? ''}`.toLowerCase().includes(query)));
  return matched.slice(-limit);
}
