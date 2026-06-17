/**
 * Persist a `claude-code-cli` user prompt at SEND time (NIM-806, Phase 3 / BUG 1).
 *
 * The genuine `claude` CLI is driven by its PTY, so the chat input box writes the
 * typed line straight to the terminal (see `claudeCliInputRouting.ts`) — the
 * prompt never reaches the Agent SDK send path that would otherwise log it. The
 * proxy observation backend sees only the `/v1/messages` REQUEST body, whose
 * trailing user message on a real Claude Code turn is the WHOLE injected context
 * (CLAUDE.md, memory, `<system-reminder>`, file context) with the typed text
 * buried inside — scraping it dumped all of that into the transcript.
 *
 * So we persist the clean typed text here, called from `submitClaudeCliPrompt`
 * (the `claude-cli:submit-prompt` IPC, and the queue flusher) right after writing
 * to the PTY. The proxy's request-body parser is kept only for `tool_result`
 * (Slice E). Attachments ride in row metadata (chips), not the PTY-bound text.
 *
 * Deps are injected so the row shape and broadcast are unit-testable without a DB
 * or a BrowserWindow.
 */

import { BrowserWindow } from 'electron';
import { AgentMessagesRepository } from '@nimbalyst/runtime';
import type { ChatAttachment } from '@nimbalyst/runtime/ai/server/types';

export interface LogClaudeCliUserPromptInput {
  sessionId: string;
  workspacePath: string;
  /** The clean typed prompt from the chat box (NOT the API request body). */
  prompt: string;
  /**
   * Draft attachments sent with the prompt. Persisted into row metadata (NOT the
   * `{prompt}` content body) because `ClaudeCodeRawParser.parseInputMessage` reads
   * attachment chips from `msg.metadata.attachments` — same shape the SDK/Codex
   * paths use. The actual file content reaches the CLI via the composed PTY line
   * (see `claudeCliPromptComposer.ts`), not from here.
   */
  attachments?: ChatAttachment[];
}

export interface LogClaudeCliUserPromptDeps {
  createMessage: (row: {
    sessionId: string;
    source: 'claude-code';
    direction: 'input';
    content: string;
    hidden: boolean;
    createdAt: Date;
    metadata?: Record<string, unknown>;
  }) => Promise<unknown>;
  notifyMessageLogged: (sessionId: string, workspacePath: string) => void;
  now: () => Date;
}

/** Broadcast `ai:message-logged` so `sessionStateListeners` reloads the transcript. */
export function broadcastMessageLogged(sessionId: string, workspacePath: string): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send('ai:message-logged', { sessionId, workspacePath });
    }
  }
}

const productionDeps: LogClaudeCliUserPromptDeps = {
  createMessage: (row) => AgentMessagesRepository.create(row),
  notifyMessageLogged: broadcastMessageLogged,
  now: () => new Date(),
};

/**
 * Persist the typed prompt as a `direction:'input'` row in the
 * `{ prompt }` shape `ClaudeCodeRawParser.parseInputMessage` reads (same as the
 * SDK path's user rows), then broadcast a transcript reload. Best-effort: a blank
 * prompt is a no-op and a repository failure is swallowed (never surfaces to the
 * user — the CLI turn already started).
 */
export async function logClaudeCliUserPrompt(
  input: LogClaudeCliUserPromptInput,
  deps: LogClaudeCliUserPromptDeps = productionDeps,
): Promise<void> {
  const prompt = input.prompt?.trim() ?? '';
  const attachments = input.attachments ?? [];
  // Persist a row if there's typed text OR at least one attachment (an
  // image-only submission still has a user turn to show).
  if (!prompt && attachments.length === 0) return;

  try {
    await deps.createMessage({
      sessionId: input.sessionId,
      source: 'claude-code',
      direction: 'input',
      content: JSON.stringify({ prompt }),
      hidden: false,
      createdAt: deps.now(),
      ...(attachments.length > 0 ? { metadata: { attachments } } : {}),
    });
    deps.notifyMessageLogged(input.sessionId, input.workspacePath);
  } catch (err) {
    console.warn('[ClaudeCliUserPromptLog] Failed to persist user prompt:', err);
  }
}
