/**
 * Project rail badge state.
 *
 * Uses the same rule as the Agent gutter bubble (`agentBubbleStateAtom`):
 * each session counts once under its highest-priority state, and the badge
 * shows the highest state present with that state's count. Awaiting input is
 * orange, running is green, unread is blue.
 *
 * Lives in its own module because it reads both `sessionActivity` (which
 * covers every project in the window, not only the active one) and the
 * per-session pending-prompt flag in `sessions`, and `sessions` already
 * imports `sessionActivity`.
 */

import { atom } from 'jotai';
import { globalSessionActivityAtom } from './sessionActivity';
import { sessionHasPendingInteractivePromptAtom, type AgentBubbleColor } from './sessions';

export interface ProjectRailBadge {
  color: AgentBubbleColor;
  count: number;
}

export const projectRailBadgesAtom = atom<Map<string, ProjectRailBadge>>((get) => {
  const out = new Map<string, ProjectRailBadge>();
  for (const [path, entry] of get(globalSessionActivityAtom)) {
    let awaiting = 0;
    let running = 0;
    let unread = 0;
    for (const sessionId of new Set([...entry.streaming, ...entry.unread])) {
      if (get(sessionHasPendingInteractivePromptAtom(sessionId))) awaiting++;
      else if (entry.streaming.has(sessionId)) running++;
      else unread++;
    }
    if (awaiting > 0) out.set(path, { color: 'orange', count: awaiting });
    else if (running > 0) out.set(path, { color: 'green', count: running });
    else if (unread > 0) out.set(path, { color: 'blue', count: unread });
  }
  return out;
});
