/**
 * The one path that creates a session wakeup, whoever asked for it (#1497).
 *
 * Three callers used to insert rows themselves -- the Claude Code
 * ScheduleWakeup hook, the `schedule_wakeup` MCP tool, and the "Run later"
 * IPC handler -- and each decided replacement and broadcasting on its own. The
 * agent paths cancelled *every* active wakeup in the session, which silently
 * destroyed prompts the user had scheduled, and none of them told the renderer
 * about the rows it cancelled.
 *
 * Rules, in one place:
 * - An agent wakeup replaces the session's previous agent wakeup (a
 *   self-pacing loop re-schedules every turn and must not pile up).
 * - A user wakeup replaces nothing.
 * - Every row that changes is broadcast, cancelled ones included.
 */

import { BrowserWindow } from 'electron';
import type { ChatAttachment, PromptProvenance } from '@nimbalyst/runtime/ai/server/types';
import type { SessionWakeupOrigin } from '../../shared/sessionWakeups';
import { getSessionWakeupsStore } from './RepositoryManager';
import { SessionWakeupScheduler } from './SessionWakeupScheduler';
import type { SessionWakeup, SessionWakeupsStore } from './PGLiteSessionWakeupsStore';

export interface ScheduleSessionWakeupInput {
  sessionId: string;
  workspaceId: string;
  prompt: string;
  fireAt: Date | number;
  origin: SessionWakeupOrigin;
  reason?: string;
  attachments?: ChatAttachment[];
}

export interface ScheduleSessionWakeupDeps {
  store: Pick<SessionWakeupsStore, 'create' | 'cancelActiveForSession'>;
  onCreated: (row: SessionWakeup) => void;
  broadcast: (row: SessionWakeup) => void;
}

/** Send a wakeup row to every renderer window. */
export function broadcastWakeupChanged(row: SessionWakeup): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      try {
        window.webContents.send('wakeup:changed', row);
      } catch {
        // ignore -- destroyed window
      }
    }
  }
}

function defaultDeps(): ScheduleSessionWakeupDeps {
  return {
    store: getSessionWakeupsStore(),
    onCreated: (row) => SessionWakeupScheduler.getInstance().onCreated(row),
    broadcast: broadcastWakeupChanged,
  };
}

export async function scheduleSessionWakeup(
  input: ScheduleSessionWakeupInput,
  deps: ScheduleSessionWakeupDeps = defaultDeps(),
): Promise<SessionWakeup> {
  const replaced = input.origin === 'agent'
    ? await deps.store.cancelActiveForSession(input.sessionId, 'agent')
    : [];
  // Announced before the insert: the cancel is already committed, so a failed
  // insert must not leave the banner showing a wakeup that no longer exists.
  for (const cancelled of replaced) deps.broadcast(cancelled);

  const row = await deps.store.create({
    id: `wakeup-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    sessionId: input.sessionId,
    workspaceId: input.workspaceId,
    prompt: input.prompt,
    reason: input.reason,
    fireAt: input.fireAt,
    attachments: input.attachments,
    origin: input.origin,
  });

  deps.onCreated(row);
  deps.broadcast(row);
  return row;
}

/**
 * How a fired wakeup's prompt enters the session. An agent wakeup is a resume
 * marker the transcript renders as a system line; a user's scheduled prompt is
 * their own message and must render (and be searchable) as one.
 */
export function wakeupPromptDelivery(origin: SessionWakeupOrigin): {
  promptOrigin: string;
  promptProvenance: PromptProvenance;
} {
  return origin === 'user'
    ? { promptOrigin: 'scheduled_prompt', promptProvenance: { actor: 'human', origin: 'composer' } }
    : { promptOrigin: 'wakeup_resume', promptProvenance: { actor: 'system', origin: 'automation' } };
}
