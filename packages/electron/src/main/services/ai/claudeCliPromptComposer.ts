/**
 * Compose the text that gets typed into the genuine `claude` CLI's PTY for a
 * `claude-code-cli` submission (NIM-806 — input integration).
 *
 * The CLI is driven by keystrokes, not the Agent SDK, so attachments can't be
 * sent as structured image/document content blocks. Instead we reference each
 * attached file by its absolute on-disk path inline in the prompt line; the
 * CLI's own Read tool reads them (it handles images too). We keep the whole
 * submission on a SINGLE logical line (paths appended after the prompt) so we
 * don't depend on multi-line bracketed-paste handling.
 *
 * Pure + dependency-free so it unit-tests without a PTY or DB. The CLEAN typed
 * prompt (without the path refs) is logged separately as the transcript user
 * row — see `claudeCliUserPromptLog.ts`; this output is ONLY for the PTY.
 */

/**
 * Active-document context for a CLI submission (NIM-818). The SDK path sends
 * this via the per-message NIMBALYST_SYSTEM_MESSAGE preamble
 * (DocumentContextService.buildDocumentContextPrompt); the CLI path appends a
 * compact single-line equivalent to the PTY line. URI + selection only, never
 * full document content — the CLI reads the document itself (Read for file
 * paths, the readCollabDoc MCP tool for collab:// URIs).
 */
export interface ClaudeCliDocumentContext {
  filePath?: string | null;
  fileType?: string | null;
  /**
   * Selection captured at submit/queue time. The renderer serializes
   * `{ text, filePath, timestamp }`; older/SDK shapes use a plain string —
   * tolerate both (mirrors DocumentContextService.normalizeTextSelection).
   */
  textSelection?: { text?: string | null } | string | null;
}

/** Extract the selection text from either supported textSelection shape. */
function selectionTextOf(context: ClaudeCliDocumentContext | null | undefined): string {
  const sel = context?.textSelection;
  if (!sel) return '';
  if (typeof sel === 'string') return sel.trim();
  return (sel.text ?? '').trim();
}

export interface ComposeClaudeCliInput {
  /** The user's typed prompt (already trimmed by the caller, but we re-trim defensively). */
  prompt?: string | null;
  /** Draft attachments; only the `filepath` is used to build a path reference. */
  attachments?: ReadonlyArray<{ filepath?: string | null }> | null;
  /** Active document / selection context (NIM-818). */
  documentContext?: ClaudeCliDocumentContext | null;
}

/** Selections longer than this are truncated in the PTY line (the CLI can re-read the file). */
const MAX_SELECTION_CHARS = 2000;

/** Flatten to one logical line: the composer never sends real newlines through the PTY. */
function flattenToSingleLine(text: string): string {
  return text.replace(/\r\n|\r|\n/g, '\\n');
}

/**
 * Build the compact single-line context block appended after the typed prompt
 * (NIM-818). Empty string when there is no usable context. Wording mirrors the
 * SDK's buildDocumentContextPrompt, condensed to one line.
 */
export function composeClaudeCliContextPreamble(
  context: ClaudeCliDocumentContext | null | undefined,
): string {
  const filePath = (context?.filePath ?? '').trim();
  const rawSelection = selectionTextOf(context);
  if (!filePath && !rawSelection) return '';

  const parts: string[] = ['[Nimbalyst context — appended automatically, not typed by the user]'];

  if (filePath) {
    parts.push(
      `The user is currently looking at this document: <ACTIVE_DOCUMENT>${filePath}</ACTIVE_DOCUMENT>.`,
      'They are not necessarily asking about it — use your judgement.',
    );
    const isCollab = context?.fileType === 'collab-markdown' || filePath.startsWith('collab://');
    parts.push(
      isCollab
        ? 'This is a shared collaborative document: READ it with the readCollabDoc MCP tool and MODIFY it with applyCollabDocEdit — filesystem Read/Edit/Write do not work for collab:// URIs.'
        : 'Read it with the Read tool if their request refers to it.',
    );
  }

  if (rawSelection) {
    let selection = flattenToSingleLine(rawSelection);
    if (selection.length > MAX_SELECTION_CHARS) {
      selection = `${selection.slice(0, MAX_SELECTION_CHARS)} …(selection truncated)`;
    }
    parts.push(
      `The user currently has this text selected (newlines shown as \\n): <SELECTED_TEXT>${selection}</SELECTED_TEXT>`,
      'When the user refers to "this", "this text", or "here", they mean this selected text.',
    );
  }

  return parts.join(' ');
}

/**
 * Build the single-line PTY submission: `<prompt> <context block> <path1> <path2> …`.
 *
 * - No attachments/context → just the trimmed prompt.
 * - Document context (NIM-818) → compact context block after the prompt.
 * - Attachments → space-separated absolute paths at the end.
 * - Attachments without a usable `filepath` are skipped.
 * - Returns `''` when there is nothing to SEND (no prompt and no attachments) —
 *   context alone is not a submission.
 */
export function composeClaudeCliPtySubmission(input: ComposeClaudeCliInput): string {
  const trimmed = (input.prompt ?? '').trim();

  const paths = (input.attachments ?? [])
    .map((a) => (a && typeof a.filepath === 'string' ? a.filepath.trim() : ''))
    .filter((p) => p.length > 0);

  if (!trimmed && paths.length === 0) {
    return '';
  }

  const preamble = composeClaudeCliContextPreamble(input.documentContext);

  return [trimmed, preamble, ...paths].filter((part) => part.length > 0).join(' ');
}
