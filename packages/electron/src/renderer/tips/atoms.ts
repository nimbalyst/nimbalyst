/**
 * Jotai atoms for the Contextual Tips System
 *
 * Tips share persistence with the walkthrough system (walkthroughStateAtom),
 * but have their own transient atoms for session-level state.
 */

import { atom } from 'jotai';

/**
 * ID of the currently active (visible) tip.
 * null means no tip is showing.
 */
export const activeTipIdAtom = atom<string | null>(null);

/**
 * Command atom for requesting a new worktree session from a tip action.
 * AgentMode watches this and performs the actual worktree creation.
 */
export const tipCreateWorktreeSessionRequestAtom = atom<number>(0);

/**
 * Reference count of empty AI transcripts currently visible.
 *
 * The TipProvider gates tip activation on this being > 0 so tips only fire
 * when there is somewhere inline to render them (the empty panel of a new
 * AI session). The bottom-left floating TipCard is currently disabled --
 * see TipProvider for the rendering policy.
 */
export const emptyTranscriptVisibleCountAtom = atom<number>(0);
