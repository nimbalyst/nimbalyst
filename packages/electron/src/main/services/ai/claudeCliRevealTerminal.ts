/**
 * Main→renderer signal that drives the `claude-code-cli` raw-terminal drawer
 * (NIM-810).
 *
 * Fired on every CLI submit (with `interactive` reflecting whether the prompt was
 * an interactive slash command) and by the PTY output sniffer (always
 * `interactive: true`). The renderer's central listener reveals + focuses the
 * drawer on `interactive: true`, and auto-collapses an auto-revealed drawer on a
 * normal (`interactive: false`) prompt. Mirrors the `broadcastTokenUsage`
 * fan-out convention in `claudeCliContextUsage.ts`.
 */

import { BrowserWindow } from 'electron';

export type ClaudeCliRevealSource = 'input' | 'output';

export interface ClaudeCliRevealTerminalPayload {
  sessionId: string;
  /** True when a native picker is (about to be) shown and the drawer should reveal. */
  interactive: boolean;
  source: ClaudeCliRevealSource;
  /** Matched command name for `source: 'input'` (diagnostics only). */
  command?: string;
}

export function broadcastClaudeCliRevealTerminal(payload: ClaudeCliRevealTerminalPayload): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed()) continue;
    try {
      window.webContents.send('claude-cli:reveal-terminal', payload);
    } catch {
      // Best-effort: a window mid-teardown is not worth failing the send over.
    }
  }
}
