import { AISessionsRepository } from '@nimbalyst/runtime/storage/repositories/AISessionsRepository';
import { findWindowByWorkspace } from '../../window/WindowManager';
import { getDatabase } from '../../database/initialize';
import { loadVoiceSession } from './voiceSessionLoader';
import { isSessionInWorkspace } from './voiceIpcAuthorization';
import { voicePresentationAuthority, voicePresentationKey, desktopRealtimeOwnsVoice } from './voicePresentationAuthority';
import type { MobileLiveRequest, MobileLiveResult } from './mobileLiveRelay';

interface VoiceSourceEvent {
  eventId: string;
  kind: 'question' | 'completion';
  sessionId: string;
  hostDeviceId: string;
  projectId: string;
  taskId: string;
  revision: number;
  promptId?: string;
  label: string;
  summary: string;
}

async function eventsFor(request: MobileLiveRequest): Promise<VoiceSourceEvent[]> {
  const { scope } = request;
  // Realtime retains its deferred-call behavior. It does not participate in
  // Live's ownership protocol, so don't start competing mobile announcements.
  if (desktopRealtimeOwnsVoice()) return [];
  const args = JSON.parse(request.arguments) as Record<string, unknown>;
  const candidates = scope.sessionId
    ? [{ id: scope.sessionId }]
    : (await AISessionsRepository.list(scope.projectId)).filter(s => !s.isArchived && (s.hasPendingInteractivePrompt || (args.includeCompletion === true && typeof args.since === 'number' && s.updatedAt >= args.since)));
  const events: VoiceSourceEvent[] = [];
  for (const candidate of candidates) {
    if (events.length >= 10) break;
    const session = await AISessionsRepository.get(candidate.id);
    if (!isSessionInWorkspace(session, scope.projectId) || session?.metadata?.hostDeviceId !== scope.hostDeviceId) continue;
    const loaded = await loadVoiceSession(scope.projectId, candidate.id);
    if ('error' in loaded || loaded.sessionId !== candidate.id) continue;
    const current = await AISessionsRepository.get(candidate.id);
    if (!current || current.updatedAt !== session!.updatedAt || !isSessionInWorkspace(current, scope.projectId) || current.metadata?.hostDeviceId !== scope.hostDeviceId) continue;
    const messages: Array<{ id?: string | number; type: string; text?: string; interactivePrompt?: { status?: string; requestId?: string } }> = loaded.session.messages ?? [];
    const user = [...messages].reverse().find(m => m.type === 'user_message');
    const common = { sessionId: candidate.id, hostDeviceId: scope.hostDeviceId, projectId: scope.projectId, taskId: String(user?.id ?? candidate.id), revision: session!.updatedAt, label: String(session!.title ?? 'Session') };
    for (const message of messages) {
      const prompt = message.type === 'interactive_prompt' ? message.interactivePrompt : null;
      if (prompt?.status !== 'pending' || typeof prompt.requestId !== 'string') continue;
      if (voicePresentationAuthority.wasPresented(voicePresentationKey(scope.hostDeviceId, scope.projectId, prompt.requestId))) continue;
      // The prompt's actual schema is displayed/answered by the app, never interpreted as consent.
      events.push({ ...common, eventId: prompt.requestId, kind: 'question', promptId: prompt.requestId,
        summary: `Needs your input. Open this session's question or approval card: ${JSON.stringify(prompt).slice(0, 1800)}` });
    }
    if (args.includeCompletion === true && !events.some(e => e.sessionId === candidate.id) && user?.id) {
      const { rows } = await getDatabase().query<{ status: string }>('SELECT status FROM ai_sessions WHERE id = $1', [candidate.id]);
      if (!rows[0] || !['idle', 'completed'].includes(rows[0].status)) continue;
      const last = [...messages].reverse().find(m => m.type === 'assistant_message' && typeof m.text === 'string' && m.text.trim());
      if (!last?.id || messages.indexOf(last) < messages.indexOf(user)) continue;
      const eventId = `completion:${candidate.id}:${user.id}:${last.id}`;
      if (!voicePresentationAuthority.wasPresented(voicePresentationKey(scope.hostDeviceId, scope.projectId, eventId))) {
        events.push({ ...common, eventId, kind: 'completion', summary: last.text!.slice(0, 1500) });
      }
    }
  }
  return events;
}

export async function handleMobileVoiceEvent(request: MobileLiveRequest): Promise<MobileLiveResult> {
  const window = findWindowByWorkspace(request.scope.projectId);
  if (!window || window.isDestroyed()) return { success: false, error: 'Voice announcements require the source workspace to be open in the desktop app. Use session notifications for a headless host.' };
  const args = JSON.parse(request.arguments) as Record<string, unknown>;
  const events = await eventsFor(request);
  if (request.tool === 'voice_events') return { success: true, result: JSON.stringify({ events }) };
  const event = events.find(e => e.eventId === args.eventId && e.taskId === args.taskId && e.revision === args.revision);
  if (!event) return { success: false, error: 'This voice event is no longer current.' };
  const current = await AISessionsRepository.get(event.sessionId);
  if (!current || current.updatedAt !== event.revision || !isSessionInWorkspace(current, event.projectId) || current.metadata?.hostDeviceId !== event.hostDeviceId) {
    return { success: false, error: 'This voice event changed before presentation.' };
  }
  const key = voicePresentationKey(request.scope.hostDeviceId, request.scope.projectId, event.eventId);
  if (request.tool === 'voice_event_presented') {
    const accepted = typeof args.token === 'string' && voicePresentationAuthority.presented(key, request.scope.announcingDeviceId, args.token);
    return { success: accepted, result: JSON.stringify({ presented: accepted }) };
  }
  const claim = voicePresentationAuthority.claim(key, request.scope.announcingDeviceId);
  return claim ? { success: true, result: JSON.stringify({ event, token: claim.token, ttlMs: 30000 }) } : { success: false, error: 'Another device owns or already presented this event.' };
}

export interface DesktopVoiceClaim { key: string; token: string; deviceId: string; expiresAt: number }
/** Desktop and mobile consult exactly the same source event and persisted claim. */
export async function claimDesktopVoiceEvent(host: string, workspace: string, sessionId: string, promptId?: string): Promise<DesktopVoiceClaim | null> {
  const request: MobileLiveRequest = { scope: { version: 1, hostDeviceId: host, projectId: workspace, sessionId, voiceGeneration: 'desktop', actionId: 'presentation', announcingDeviceId: host }, tool: 'voice_events', arguments: JSON.stringify({ includeCompletion: !promptId }) };
  const event = (await eventsFor(request)).find(e => promptId ? e.promptId === promptId : e.kind === 'completion');
  // Missing, stale, and already-presented source events never grant permission.
  if (!event) return null;
  const key = voicePresentationKey(host, workspace, event.eventId);
  const claim = voicePresentationAuthority.claim(key, host);
  return claim ? { key, token: claim.token, deviceId: host, expiresAt: claim.expiresAt } : null;
}
