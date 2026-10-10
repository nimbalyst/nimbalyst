// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
const db = vi.hoisted(() => ({
  sessions: new Map<string, { workspace_id: string; session_type: string; metadata: string }>(),
  messages: [] as Array<{ session_id: string; direction: string; content: string; metadata: string }>,
}));
vi.mock('../../../database/initialize', () => ({
  getDatabase: () => ({
    query: async (sql: string, params: any[]) => {
      if (sql.startsWith('SELECT workspace_id')) {
        const row = db.sessions.get(params[0]);
        return { rows: row ? [row] : [] };
      }
      if (sql.includes('INSERT INTO ai_sessions')) {
        if (!db.sessions.has(params[0])) db.sessions.set(params[0], { workspace_id: params[1], session_type: 'voice', metadata: params[2] });
        return { rows: [] };
      }
      if (sql.includes('voiceEntryId')) {
        return { rows: db.messages.filter(m => m.session_id === params[0]).map(m => ({ entry_id: JSON.parse(m.metadata).voiceEntryId })) };
      }
      if (sql.includes('INSERT INTO ai_agent_messages')) {
        db.messages.push({ session_id: params[0], direction: params[1], content: params[2], metadata: params[3] });
      }
      return { rows: [] };
    },
  }),
}));
vi.mock('@nimbalyst/runtime/storage/repositories/AISessionsRepository', () => ({
  AISessionsRepository: { get: async (id: string) => (id === 'coding' ? { workspacePath: '/p' } : null) },
}));
vi.mock('../voiceIpcAuthorization', () => ({ isSessionInWorkspace: (s: any, p: string) => s?.workspacePath === p }));
import { appendMobileVoiceLog } from '../mobileVoiceLog';
import type { MobileLiveRequest } from '../mobileLiveRelay';

const CONVERSATION = '6f1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f';
const scope = { version: 1 as const, hostDeviceId: 'host', projectId: '/p', sessionId: null, voiceGeneration: 'g', actionId: 'a', announcingDeviceId: 'phone' };
const entry = (entryId: string, direction = 'input', content = 'what is the question') => ({ entryId, direction, content, timestamp: 1790000000000 });
const log = (args: object) =>
  appendMobileVoiceLog({ scope, tool: 'voice_log', arguments: JSON.stringify(args) } as MobileLiveRequest);

beforeEach(() => {
  db.sessions.clear();
  db.messages.length = 0;
});

describe('phone voice conversation log', () => {
  it('creates one linked voice session and never duplicates a retried batch', async () => {
    const batch = { conversation_id: CONVERSATION, linked_session_id: 'coding', entries: [entry('u1'), entry('a1', 'output', 'It asks which color.')] };
    expect((await log(batch)).success).toBe(true);
    expect((await log(batch)).success).toBe(true);
    expect(db.messages.map(m => [m.direction, m.content])).toEqual([['input', 'what is the question'], ['output', 'It asks which color.']]);
    expect(JSON.parse(db.sessions.get(CONVERSATION)!.metadata)).toMatchObject({ linkedSessionId: 'coding', voiceSource: 'mobile' });
  });

  it('never writes into a coding session or another project, and rejects malformed batches', async () => {
    db.sessions.set(CONVERSATION, { workspace_id: '/p', session_type: 'session', metadata: '{}' });
    expect((await log({ conversation_id: CONVERSATION, entries: [entry('u1')] })).success).toBe(false);
    db.sessions.set(CONVERSATION, { workspace_id: '/other', session_type: 'voice', metadata: '{}' });
    expect((await log({ conversation_id: CONVERSATION, entries: [entry('u1')] })).success).toBe(false);
    expect((await log({ conversation_id: 'coding', entries: [entry('u1')] })).success).toBe(false);
    expect((await log({ conversation_id: CONVERSATION, entries: [entry('u1', 'system')] })).success).toBe(false);
    expect(db.messages).toEqual([]);
  });
});
