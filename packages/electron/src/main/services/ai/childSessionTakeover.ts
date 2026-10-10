import type { SessionData } from '@nimbalyst/runtime/ai/server/types';
import { AISessionsRepository } from '@nimbalyst/runtime/storage/repositories/AISessionsRepository';
import { deletePendingChildUpdates } from './pendingChildUpdates';
import { isParentNotificationSuppressed } from '../extensionSessions/sessionOwnership';

export async function disableParentNotificationsAfterDirectTakeover(session: SessionData): Promise<void> {
  if (!session.createdBySessionId) {
    return;
  }

  // Already opted out, or the owning extension receives this child's settles
  // instead of the parent: there is no parent update to turn off.
  if (isParentNotificationSuppressed(session.metadata)) {
    return;
  }

  await AISessionsRepository.updateMetadata(session.id, {
    metadata: {
      notifyParent: false,
      notifyParentDisabledBy: 'child-user-takeover',
    },
  });

  await deletePendingChildUpdates(session.createdBySessionId, session.id);
}
