/**
 * Records a phone voice conversation into a desktop voice session.
 *
 * The phone's Live conversation otherwise lives only in its memory, so nobody
 * could see what was said or what the tools returned. Entries use the exact
 * format desktop voice writes (see VoiceRawParser): `input` for the user,
 * `output` for the agent, `[system] ...` lines, and `voiceToolCall` JSON.
 *
 * The phone retries unacknowledged batches, so appends are idempotent by entry
 * id, and a conversation id may only ever name a voice session in this project.
 */

import { getDatabase } from '../../database/initialize';
import { AISessionsRepository } from '@nimbalyst/runtime/storage/repositories/AISessionsRepository';
import { isSessionInWorkspace } from './voiceIpcAuthorization';
import type { MobileLiveRequest, MobileLiveResult } from './mobileLiveRelay';

export interface MobileVoiceLogEntry {
  entryId: string;
  direction: 'input' | 'output';
  content: string;
  timestamp: number;
}

const MAX_ENTRIES = 50;
const MAX_CONTENT = 20000;
const CONVERSATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Validate the phone's batch; anything malformed rejects the whole batch. */
export function parseMobileVoiceLog(argsJson: string): { conversationId: string; linkedSessionId?: string; entries: MobileVoiceLogEntry[] } | null {
  try {
    const args = JSON.parse(argsJson);
    const conversationId = args?.conversation_id;
    if (typeof conversationId !== 'string' || !CONVERSATION_ID.test(conversationId)) return null;
    const entries = args.entries;
    if (!Array.isArray(entries) || entries.length === 0 || entries.length > MAX_ENTRIES) return null;
    const valid = entries.every((e: any) =>
      typeof e?.entryId === 'string' && e.entryId.length > 0 && e.entryId.length <= 200
      && (e.direction === 'input' || e.direction === 'output')
      && typeof e.content === 'string' && e.content.length <= MAX_CONTENT
      && typeof e.timestamp === 'number' && Number.isFinite(e.timestamp));
    if (!valid) return null;
    const linked = typeof args.linked_session_id === 'string' && args.linked_session_id ? args.linked_session_id : undefined;
    return { conversationId: conversationId.toLowerCase(), linkedSessionId: linked, entries };
  } catch {
    return null;
  }
}

export async function appendMobileVoiceLog(request: MobileLiveRequest): Promise<MobileLiveResult> {
  const parsed = parseMobileVoiceLog(request.arguments);
  if (!parsed) return { success: false, error: 'Invalid voice log batch.' };
  const { projectId } = request.scope;
  const db = getDatabase();

  const { rows: existing } = await db.query<{ workspace_id: string; session_type: string }>(
    'SELECT workspace_id, session_type FROM ai_sessions WHERE id = $1', [parsed.conversationId]);
  if (existing.length === 0) {
    // Link only to a session this project actually has; the link is navigation, not authority.
    const linked = parsed.linkedSessionId && isSessionInWorkspace(await AISessionsRepository.get(parsed.linkedSessionId), projectId)
      ? parsed.linkedSessionId : undefined;
    await db.query(
      `INSERT INTO ai_sessions (id, workspace_id, provider, title, session_type, metadata, created_at, updated_at)
       VALUES ($1, $2, 'openai-realtime', 'Phone Voice Session', 'voice', $3, NOW(), NOW())
       ON CONFLICT (id) DO NOTHING`,
      [parsed.conversationId, projectId, JSON.stringify({
        ...(linked ? { linkedSessionId: linked } : {}),
        voiceSource: 'mobile',
        announcingDeviceId: request.scope.announcingDeviceId,
      })]);
  } else if (existing[0].session_type !== 'voice' || existing[0].workspace_id !== projectId) {
    return { success: false, error: 'This voice log does not belong to this project.' };
  }

  const { rows: logged } = await db.query<{ entry_id: string | null }>(
    `SELECT metadata->>'voiceEntryId' AS entry_id FROM ai_agent_messages WHERE session_id = $1 AND source = 'voice'`,
    [parsed.conversationId]);
  const seen = new Set(logged.map(r => r.entry_id).filter(Boolean));
  let appended = 0;
  for (const entry of parsed.entries) {
    if (seen.has(entry.entryId)) continue;
    seen.add(entry.entryId);
    await db.query(
      `INSERT INTO ai_agent_messages (session_id, source, direction, content, metadata, created_at)
       VALUES ($1, 'voice', $2, $3, $4, $5)`,
      [parsed.conversationId, entry.direction, entry.content,
        JSON.stringify({ voiceEntryId: entry.entryId }), new Date(entry.timestamp).toISOString()]);
    appended += 1;
  }
  if (appended > 0) {
    await db.query('UPDATE ai_sessions SET updated_at = NOW() WHERE id = $1', [parsed.conversationId]);
  }
  return { success: true, result: JSON.stringify({ accepted: parsed.entries.map(e => e.entryId), appended }) };
}
