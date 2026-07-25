/**
 * Centralized IPC listener for the `claude-code-cli` raw-terminal drawer (NIM-810).
 *
 * Follows the centralized-listener architecture: components NEVER subscribe to IPC
 * directly; this listener updates Jotai atoms that SessionTranscript / TerminalPanel
 * read.
 *
 * Main fires `claude-cli:reveal-terminal` on every CLI submit (and from the PTY
 * picker sniffer). On an interactive signal we reveal + focus the drawer; on a
 * normal prompt we collapse a drawer that we auto-revealed, leaving user/default
 * expansions untouched.
 */

import { store } from '../index';
import {
  cliTerminalExpandedAtom,
  cliTerminalFocusNonceAtom,
  cliTerminalAutoRevealedAtom,
  cliTerminalUserCollapsedAtom,
} from '../atoms/terminals';

interface RevealTerminalPayload {
  sessionId: string;
  interactive: boolean;
  source?: 'input' | 'output';
  command?: string;
}

export interface RevealDrawerState {
  expanded: boolean;
  autoRevealed: boolean;
  /** The user explicitly closed the drawer (NIM-820) — sticky until they reopen or type an interactive command. */
  userCollapsed: boolean;
}

export interface RevealDrawerDecision extends RevealDrawerState {
  /** Whether to pulse focus to the xterm (keyboard nav into the native picker). */
  focus: boolean;
}

/**
 * Pure decision for one reveal signal — kept separate so the branching is
 * unit-testable without the global store or `window`.
 *
 * - interactive (output) + user-collapsed → NO change (NIM-820: the PTY picker
 *   sniffer fires on ordinary output; never reopen a drawer the user closed)
 * - interactive + collapsed  → expand, mark auto-revealed, clear user-collapsed
 * - interactive + expanded   → keep
 * - normal + auto-revealed   → collapse, clear flag (return to where the user was)
 * - normal + user/default    → no change
 *
 * Focus only pulses for input-sourced interactive reveals (the user deliberately
 * submitted an allowlisted command like /model). Output-sourced reveals come from
 * the PTY sniffer, which false-positives on ordinary output containing the Ink
 * caret glyph (vitest, autocomplete dropdowns, fancy prompts); focusing on those
 * yanks the cursor out of the chat input mid-sentence (NIM-828).
 */
export function computeRevealDrawerAction(
  current: RevealDrawerState,
  interactive: boolean,
  source: 'input' | 'output',
): RevealDrawerDecision {
  if (interactive) {
    if (current.userCollapsed && source === 'output') {
      return { ...current, focus: false };
    }
    if (!current.expanded) {
      return { expanded: true, autoRevealed: true, userCollapsed: false, focus: source === 'input' };
    }
    return { ...current, userCollapsed: false, focus: source === 'input' };
  }
  if (current.autoRevealed) {
    return { ...current, expanded: false, autoRevealed: false, focus: false };
  }
  return { ...current, focus: false };
}

export function initClaudeCliTerminalListeners(): () => void {
  const handleReveal = (payload: RevealTerminalPayload) => {
    const { sessionId, interactive } = payload ?? {};
    if (!sessionId) return;

    const current: RevealDrawerState = {
      expanded: store.get(cliTerminalExpandedAtom(sessionId)),
      autoRevealed: store.get(cliTerminalAutoRevealedAtom(sessionId)),
      userCollapsed: store.get(cliTerminalUserCollapsedAtom(sessionId)),
    };
    const next = computeRevealDrawerAction(
      current,
      !!interactive,
      payload?.source === 'output' ? 'output' : 'input',
    );

    if (next.expanded !== current.expanded) {
      store.set(cliTerminalExpandedAtom(sessionId), next.expanded);
    }
    if (next.autoRevealed !== current.autoRevealed) {
      store.set(cliTerminalAutoRevealedAtom(sessionId), next.autoRevealed);
    }
    if (next.userCollapsed !== current.userCollapsed) {
      store.set(cliTerminalUserCollapsedAtom(sessionId), next.userCollapsed);
    }
    if (next.focus) {
      store.set(cliTerminalFocusNonceAtom(sessionId), (n) => n + 1);
    }
  };

  const unsubscribe = window.electronAPI.on('claude-cli:reveal-terminal', handleReveal);

  return () => {
    unsubscribe();
  };
}
