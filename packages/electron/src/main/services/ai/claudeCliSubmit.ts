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

import type { ChatAttachment, PromptProvenance } from '@nimbalyst/runtime/ai/server/types';
import {
  composeClaudeCliPtySubmission,
  type ClaudeCliDocumentContext,
} from './claudeCliPromptComposer';

/** Carriage return = Enter for the CLI's readline (PTYs expect `\r`, not `\n`). */
const SUBMIT_TERMINATOR = '\r';
/** Gap between the text write and the Enter write so the TUI consumes both. */
export const SUBMIT_WRITE_GAP_MS = 25;
/** Upper bound on the scaled gap, so a huge paste can't stall submission. */
export const SUBMIT_WRITE_GAP_MAX_MS = 1000;

/**
 * Bracketed-paste markers. A single large `pty.write` is fragmented by the OS
 * PTY layer, and the CLI's paste detector treats each fragment as a SEPARATE
 * paste — one message becomes several "[Pasted text #N]" placeholders and only
 * the tail stays inline. Wrapping the payload makes the TUI consume it as one
 * atomic paste. Measured on Windows/ConPTY with CLI 2.1.220: a 20k-char prompt
 * produced 8 placeholders unwrapped, 1 wrapped.
 */
const BRACKETED_PASTE_START = '\x1b[200~';
const BRACKETED_PASTE_END = '\x1b[201~';

/**
 * How long to wait between the payload and Enter.
 *
 * The gap was a flat 25ms, which is fine for ordinary prompts but loses large
 * ones: Enter arriving while the payload is still draining submits a partial
 * line. Scale with payload size, keeping 25ms as the floor so short prompts are
 * unaffected. (20k chars needs >25ms; 75ms was sufficient in testing.)
 */
export function submitWriteGapMs(payloadLength: number): number {
  return Math.min(
    SUBMIT_WRITE_GAP_MAX_MS,
    Math.max(SUBMIT_WRITE_GAP_MS, Math.ceil(payloadLength / 100)),
  );
}

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
    promptProvenance?: PromptProvenance;
  }) => Promise<void>;
  sendAnalytics: (payload: {
    messageLength: number;
    hasAttachments: boolean;
    attachmentCount: number;
    hasDocumentContext: boolean;
  }) => void;
  delay: (ms: number) => Promise<void>;
  /**
   * Has the CLI actually started a turn for this session? Read from its PID file
   * (`readClaudePidTurnState`). Omit to skip Enter confirmation entirely, which
   * is what the pure unit tests and any caller without a live PID do.
   */
  hasTurnStarted?: (sessionId: string) => boolean | Promise<boolean>;
}

/** How long to wait between checks that the turn actually started. */
const ENTER_CONFIRM_POLL_MS = 250;
/** Checks per attempt. 8 x 250ms = 2s, well past the ~400ms measured worst case. */
const ENTER_CONFIRM_POLLS = 8;
/** Extra Enters to try. The prompt box is empty once a turn starts, so a
 *  redundant Enter on an already-submitted session is a no-op. */
const ENTER_RETRIES = 2;

/**
 * Press Enter until the CLI actually starts a turn.
 *
 * The CLI ingests an attached file AFTER its bytes land (read + decode), and an
 * Enter arriving during that window is swallowed. Measured on 2.1.220 with real
 * screenshots (`nimbalyst-local/cli-paste-probes/05` and `06`): 25ms and 200ms
 * strand, ~400ms and up submit. `submitWriteGapMs` cannot know that, because it
 * scales with the PAYLOAD LENGTH — a sentence plus one path is ~300 chars and
 * yields the 25ms floor however large the image is.
 *
 * So don't guess a bigger constant, which would be the same bug with a nicer
 * number. Ask the same signal Nimbalyst already trusts for "is this session
 * busy" and re-press if the answer is no.
 */
async function confirmEnterStartedTurn(
  sessionId: string,
  deps: SubmitClaudeCliPromptDeps,
): Promise<void> {
  const hasTurnStarted = deps.hasTurnStarted;
  if (!hasTurnStarted) return;

  for (let attempt = 0; attempt <= ENTER_RETRIES; attempt++) {
    for (let poll = 0; poll < ENTER_CONFIRM_POLLS; poll++) {
      try {
        if (await hasTurnStarted(sessionId)) return;
      } catch {
        // An unreadable PID file is not a reason to spam Enter — treat the
        // confirmation as unavailable and stop.
        return;
      }
      await deps.delay(ENTER_CONFIRM_POLL_MS);
    }
    if (attempt < ENTER_RETRIES) {
      deps.writeToTerminal(sessionId, SUBMIT_TERMINATOR);
    }
  }
}

/**
 * Compose + write + log + analytics for one CLI submission. Returns
 * `{ submitted: false }` (a no-op) when there's nothing to send.
 */
export async function submitClaudeCliPrompt(
  input: SubmitClaudeCliPromptInput,
  deps: SubmitClaudeCliPromptDeps,
): Promise<{ submitted: boolean }> {
  const prompt = (input.prompt ?? '').trim();
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
    if (prompt.length > 1) {
      deps.writeToTerminal(input.sessionId, prompt.slice(1));
      await deps.delay(SUBMIT_WRITE_GAP_MS);
    }
    // NIM-851: writing `/` first opens the claude TUI's slash-command
    // autocomplete menu, and that menu (a) fuzzy-matches command DESCRIPTIONS
    // not just names — typing "implement" surfaces `/investigate` ("...before
    // implementing") and `/session-cleanup` ("...implementing -> validating") —
    // and (b) hijacks Enter to run the HIGHLIGHTED row instead of the literal
    // typed text. For a bare command (no args) the menu stays open through
    // Enter, so a stale/recency-shifted highlight runs the wrong command (real
    // incident: typed `/implement`, ran `/investigate` with empty args). Type a
    // trailing space first: it ends the command token and dismisses the menu
    // (verified on claude 2.1.177), so Enter submits the literal command.
    // Commands WITH args already closed the menu via their separating space;
    // bare `/` and `#` memory mode are different UIs and left untouched.
    const isBareSlashCommand =
      prompt.startsWith('/') && prompt.length > 1 && !/\s/.test(prompt);
    if (isBareSlashCommand) {
      deps.writeToTerminal(input.sessionId, ' ');
      await deps.delay(SUBMIT_WRITE_GAP_MS);
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

    // Wrapped, so the CLI sees one paste instead of one per PTY fragment.
    // The slash/# branch above is deliberately NOT wrapped: the trigger char
    // has to land as a real keystroke to open the TUI's command menu.
    deps.writeToTerminal(
      input.sessionId,
      BRACKETED_PASTE_START + ptyText + BRACKETED_PASTE_END,
    );
    await deps.delay(submitWriteGapMs(ptyText.length));
    deps.writeToTerminal(input.sessionId, SUBMIT_TERMINATOR);
    // An attachment makes the CLI do async work after the bytes land, which can
    // swallow that Enter. Confirm a turn really started; press again if not.
    await confirmEnterStartedTurn(input.sessionId, deps);
  }

  // Log the CLEAN typed prompt (+ attachment chips), NOT the path-augmented PTY
  // line. Best-effort: the CLI turn already started.
  await deps.logUserPrompt({
    sessionId: input.sessionId,
    workspacePath: input.workspacePath,
    prompt,
    attachments,
    promptProvenance: input.documentContext?.promptProvenance,
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
