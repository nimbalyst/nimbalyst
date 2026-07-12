/**
 * Consolidated `claude-code-cli` prompt submission (NIM-806 — input integration).
 *
 * A single place that turns a {prompt, attachments} into a genuine-CLI turn:
 *   1. compose the PTY line (prompt + inline attachment paths) — `claudeCliPromptComposer`
 *   2. write it to the terminal PTY (text, then a separate Enter, mirroring the
 *      terminal key path — a single `text + \r` write can leave the Claude TUI
 *      showing the text without consuming Enter)
 *   3. persist the CLEAN typed prompt (+ attachment chips) as the transcript user row
 *   4. fire `ai_message_sent` analytics with real attachment flags
 *
 * Used by BOTH the immediate-send IPC (`claude-cli:submit-prompt`) and the
 * main-process queue flusher (`claudeCliQueueFlush`), so a queued prompt's
 * attachments flush identically to an immediate one. Pure core + injected deps
 * so it unit-tests without a PTY / DB / analytics; the production wrapper wires
 * the real terminal manager, prompt-log, and analytics.
 */

import type { ChatAttachment } from '@nimbalyst/runtime/ai/server/types';
import {
  composeClaudeCliPtySubmission,
  type ClaudeCliDocumentContext,
} from './claudeCliPromptComposer';

/** Carriage return = Enter for the CLI's readline (PTYs expect `\r`, not `\n`). */
const SUBMIT_TERMINATOR = '\r';
/** Gap between the text write and the Enter write so the TUI consumes both. */
export const SUBMIT_WRITE_GAP_MS = 25;

export interface SubmitClaudeCliPromptInput {
  sessionId: string;
  workspacePath: string;
  prompt: string;
  attachments?: ChatAttachment[];
  /** Active document / selection context (NIM-818) — appended to the PTY line. */
  documentContext?: ClaudeCliDocumentContext | null;
}

export interface SubmitClaudeCliPromptDeps {
  writeToTerminal: (sessionId: string, data: string) => void;
  logUserPrompt: (input: {
    sessionId: string;
    workspacePath: string;
    prompt: string;
    attachments?: ChatAttachment[];
  }) => Promise<void>;
  sendAnalytics: (payload: {
    messageLength: number;
    hasAttachments: boolean;
    attachmentCount: number;
    hasDocumentContext: boolean;
  }) => void;
  delay: (ms: number) => Promise<void>;
}

/**
 * Remove control bytes that can be interpreted by the PTY instead of becoming
 * ordinary prompt text. Tabs and line breaks remain valid for normal prompts;
 * slash-command argument tails are normalized separately below.
 */
function stripPtyControlBytes(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
}

/** A slash-command tail must never contain an embedded submit keystroke. */
function normalizeSlashCommandArgs(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Compose + write + log + analytics for one CLI submission. Returns
 * `{ submitted: false }` (a no-op) when there's nothing to send.
 */
export async function submitClaudeCliPrompt(
  input: SubmitClaudeCliPromptInput,
  deps: SubmitClaudeCliPromptDeps,
): Promise<{ submitted: boolean }> {
  const prompt = stripPtyControlBytes(input.prompt ?? '').trim();
  const attachments = input.attachments ?? [];

  // NIM-819: the claude TUI only opens its slash-command/memory mode when
  // / or # arrives as the FIRST interactive keystroke on an empty prompt — a
  // bulk-pasted "/clear" is treated as literal text. Write the trigger char as
  // its own keystroke, then the remainder, then Enter. Skips the document
  // context block (it would corrupt the command line) and only applies to
  // attachment-free prompts (paths after a command make no sense).
  const isTuiTrigger =
    (prompt.startsWith('/') || prompt.startsWith('#')) && attachments.length === 0;

  if (isTuiTrigger) {
    deps.writeToTerminal(input.sessionId, prompt[0]);
    await deps.delay(SUBMIT_WRITE_GAP_MS);

    const rest = prompt.slice(1);
    const separatorIndex = prompt.startsWith('/') ? rest.search(/\s/) : -1;
    const isSlashCommandWithArgs = separatorIndex > 0;

    if (isSlashCommandWithArgs) {
      const commandName = rest.slice(0, separatorIndex);
      const args = normalizeSlashCommandArgs(rest.slice(separatorIndex));

      // Resolve the autocomplete menu using only the command token. Writing
      // the command and its argument tail in one PTY chunk lets the menu keep
      // fuzzy-matching the entire tail and can submit the wrong highlighted
      // command (or literal chat text) instead.
      deps.writeToTerminal(input.sessionId, commandName);
      await deps.delay(SUBMIT_WRITE_GAP_MS);
      deps.writeToTerminal(input.sessionId, ' ');
      await deps.delay(SUBMIT_WRITE_GAP_MS);
      if (args) {
        deps.writeToTerminal(input.sessionId, args);
        await deps.delay(SUBMIT_WRITE_GAP_MS);
      }
    } else {
      if (rest) {
        deps.writeToTerminal(input.sessionId, rest);
        await deps.delay(SUBMIT_WRITE_GAP_MS);
      }
      // NIM-851: writing `/` first opens the claude TUI's slash-command
      // autocomplete menu, whose highlighted row can hijack Enter. A trailing
      // space resolves a bare command token before Enter is sent. Bare `/` and
      // `#` memory mode are different UIs and remain untouched.
      const isBareSlashCommand =
        prompt.startsWith('/') && prompt.length > 1 && !/\s/.test(prompt);
      if (isBareSlashCommand) {
        deps.writeToTerminal(input.sessionId, ' ');
        await deps.delay(SUBMIT_WRITE_GAP_MS);
      }
    }
    deps.writeToTerminal(input.sessionId, SUBMIT_TERMINATOR);
  } else {
    const ptyText = composeClaudeCliPtySubmission({
      prompt,
      attachments,
      documentContext: input.documentContext,
    });
    if (!ptyText) {
      return { submitted: false };
    }

    deps.writeToTerminal(input.sessionId, ptyText);
    await deps.delay(SUBMIT_WRITE_GAP_MS);
    deps.writeToTerminal(input.sessionId, SUBMIT_TERMINATOR);
  }

  // Log the CLEAN typed prompt (+ attachment chips), NOT the path-augmented PTY
  // line. Best-effort: the CLI turn already started.
  await deps.logUserPrompt({
    sessionId: input.sessionId,
    workspacePath: input.workspacePath,
    prompt,
    attachments,
  });

  deps.sendAnalytics({
    messageLength: prompt.length,
    hasAttachments: attachments.length > 0,
    attachmentCount: attachments.length,
    hasDocumentContext: !!(
      input.documentContext?.filePath ||
      (typeof input.documentContext?.textSelection === 'string'
        ? input.documentContext.textSelection
        : input.documentContext?.textSelection?.text)
    ),
  });

  return { submitted: true };
}
