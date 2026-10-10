import { expect, it } from 'vitest';
import { selectSessionsForIndexSync } from '../selectSessionsForIndexSync';

it('heals a stale manager after process restart even when parent and activity timestamps match', () => {
  const local = { id: 'child', workspaceId: '/p', provider: 'claude-code', title: 'Child', messageCount: 0, createdAt: 10000, updatedAt: 10000, parentSessionId: 'root', createdBySessionId: 'root' };
  const remote = { ...local, sessionId: 'child', projectId: '/p', lastMessageAt: 10000, createdBySessionId: 'previous-manager' };
  const result = selectSessionsForIndexSync([local], { complete: true, sessions: [remote], projects: [] }, 10000);
  expect(result.sessionsNeedingIndexUpdate).toEqual([local]);
  expect(result.sessionsNeedingMessageSync).toEqual([]);
});
