import type { TranscriptViewMessage } from '@nimbalyst/runtime/ai/server/types';
import type { TranscriptSelectionSource } from '@nimbalyst/runtime';

/** Longer selections are cut, with a marker saying so, instead of flooding the prompt. */
export const MAX_TRANSCRIPT_SELECTION_CHARS = 20_000;

type Author = 'user' | 'assistant';

interface Part {
  author: Author;
  text: string;
}

/** A selection endpoint row; `partialText` is set when only part of the row is selected. */
export interface SelectedRow {
  index: number;
  partialText?: string;
}

export function toolFilePath(message: TranscriptViewMessage | undefined): string | undefined {
  const tool = message?.toolCall;
  const fromArgs = tool?.arguments?.file_path ?? tool?.arguments?.path;
  return tool?.targetFilePath ?? (typeof fromArgs === 'string' ? fromArgs : undefined);
}

export function toolCallMarker(message: TranscriptViewMessage): string {
  const tool = message.toolCall;
  if (!tool) return '';
  const filePath = toolFilePath(message);
  return `[Tool call: ${tool.toolDisplayName || tool.toolName}${filePath ? ` (${filePath})` : ''}]`;
}

/** Context Nimbalyst appended to a sent user message; the transcript hides it too. */
function stripSystemMessages(text: string): string {
  return text.replace(/\s*<NIMBALYST_SYSTEM_MESSAGE>[\s\S]*?<\/NIMBALYST_SYSTEM_MESSAGE>/g, '');
}

/** Drop leading blank lines and trailing whitespace; keep the first line's indent. */
export function tidySelectionText(text: string): string {
  return text.replace(/^(?:[ \t]*\r?\n)+/, '').trimEnd();
}

function partsOf(message: TranscriptViewMessage | undefined): Part[] {
  if (!message) return [];
  if (message.type === 'user_message') return [{ author: 'user', text: stripSystemMessages(message.text ?? '') }];
  if (message.type === 'assistant_message') return [{ author: 'assistant', text: message.text ?? '' }];
  if (message.type === 'tool_call') return [{ author: 'assistant', text: toolCallMarker(message) }];
  return [];
}

function authorOf(message: TranscriptViewMessage | undefined): Author {
  return message?.type === 'user_message' ? 'user' : 'assistant';
}

/** Tool calls are drawn inside the assistant row that follows them, so a whole row includes them. */
function precedingToolParts(messages: readonly TranscriptViewMessage[], index: number): Part[] {
  let first = index;
  while (first > 0 && messages[first - 1].type === 'tool_call') first--;
  return messages.slice(first, index).flatMap(partsOf);
}

function rowParts(messages: readonly TranscriptViewMessage[], row: SelectedRow, isStart: boolean): Part[] {
  if (row.partialText !== undefined) return [{ author: authorOf(messages[row.index]), text: row.partialText }];
  return [...(isStart ? precedingToolParts(messages, row.index) : []), ...partsOf(messages[row.index])];
}

/**
 * Build the text for a chat selection from `start` to `end` (row indexes into
 * `messages`). Whole rows use the message's markdown source, so rows the
 * virtualized list has unmounted are still included; partly selected rows use
 * the rendered text the caller read from the page. A selection spanning both
 * sides labels each part with who wrote it.
 */
export function assembleTranscriptSelection(
  messages: readonly TranscriptViewMessage[],
  start: SelectedRow,
  end: SelectedRow,
): ({ text: string } & TranscriptSelectionSource) | null {
  const parts = start.index === end.index
    ? rowParts(messages, start, true)
    : [
        ...rowParts(messages, start, true),
        ...messages.slice(start.index + 1, end.index).flatMap(partsOf),
        ...rowParts(messages, end, false),
      ];

  const groups: Part[] = [];
  for (const part of parts) {
    const text = tidySelectionText(part.text);
    if (!text) continue;
    const last = groups[groups.length - 1];
    if (last?.author === part.author) last.text += `\n\n${text}`;
    else groups.push({ author: part.author, text });
  }
  if (groups.length === 0) return null;

  const mixed = groups.length > 1;
  const full = mixed
    ? groups.map((g) => `${g.author === 'user' ? '[User]' : '[Your reply]'}\n${g.text}`).join('\n\n')
    : groups[0].text;
  const text = full.length > MAX_TRANSCRIPT_SELECTION_CHARS
    ? `${full.slice(0, MAX_TRANSCRIPT_SELECTION_CHARS)}\n…(selection truncated: showing the first ${MAX_TRANSCRIPT_SELECTION_CHARS} of ${full.length} characters)`
    : full;
  return { text, author: mixed ? 'mixed' : groups[0].author };
}
