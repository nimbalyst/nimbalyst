import { isParentNotificationSuppressed } from '../extensionSessions/sessionOwnership';

interface SessionLike {
  id: string;
  createdBySessionId?: string | null;
  workspacePath?: string;
  metadata?: Record<string, unknown>;
}

/**
 * After a child's queued-prompt chain settles, wake the session that spawned
 * it so the parent processes the child's update. Runs from the queue driver's
 * `onAfterSettled` hook; the matching child-update prompt itself is queued by
 * MetaAgentService.handleChildSessionEvent.
 */
export async function wakeParentAfterChildSettle(args: {
  childSessionId: string;
  source: string;
  /** The chain ended in 'error'; captured before endSession evicted the child's state. */
  settledChildErrored: boolean;
  getSession: (sessionId: string) => Promise<SessionLike | null>;
  getSessionStatus: (sessionId: string) => string | undefined;
  requestQueueDrive: (sessionId: string, workspacePath: string) => void;
  logInfo: (message: string) => void;
}): Promise<void> {
  const child = await args.getSession(args.childSessionId);
  if (!child?.createdBySessionId) return;

  // Honor fire-and-forget (spawn_session sets notifyParent=false) and owners
  // that route child settles to themselves. Without this every child settle
  // wakes the parent and re-drives a meta-agent in a loop. Same gate as
  // MetaAgentService.handleChildSessionEvent.
  if (isParentNotificationSuppressed(child.metadata)) return;

  // A failed child (e.g. an antigravity 429) has no result to deliver, and
  // waking the parent on every such settle is the meta-agent spin loop.
  if (args.settledChildErrored) return;

  const parent = await args.getSession(child.createdBySessionId);
  if (!parent?.workspacePath) return;

  const status = args.getSessionStatus(parent.id) || 'idle';
  if (status === 'idle' || status === 'error') {
    args.logInfo(`[AIService] ${args.source}: waking meta-agent ${parent.id} after child ${args.childSessionId} completed`);
    args.requestQueueDrive(parent.id, parent.workspacePath);
  }
}
