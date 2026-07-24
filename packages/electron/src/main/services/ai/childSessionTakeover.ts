import type { SessionData } from '@nimbalyst/runtime/ai/server/types';
import { AISessionsRepository } from '@nimbalyst/runtime';
import { database as databaseWorker } from '../../database/PGLiteDatabaseWorker';

export async function disableParentNotificationsAfterDirectTakeover(session: SessionData): Promise<void> {
  if (!session.createdBySessionId) {
    return;
  }

  const metadata = (session.metadata as Record<string, unknown> | undefined) ?? {};
  if (metadata.notifyParent === false) {
    return;
  }

  await AISessionsRepository.updateMetadata(session.id, {
    metadata: {
      notifyParent: false,
      notifyParentDisabledBy: 'child-user-takeover',
    },
  });

  await databaseWorker.query(
    `DELETE FROM queued_prompts
     WHERE session_id = $1
       AND status = 'pending'
       AND prompt LIKE '[Child Session Update]%'
       AND prompt LIKE $2`,
    [session.createdBySessionId, `%(${session.id})%`]
  );
}
