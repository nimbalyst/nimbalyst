// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ get: vi.fn(), list: vi.fn(), load: vi.fn(), query: vi.fn(), window: vi.fn(), presented: vi.fn(), claim: vi.fn(), receipt: vi.fn() }));
vi.mock('@nimbalyst/runtime/storage/repositories/AISessionsRepository', () => ({ AISessionsRepository: { get: mocks.get, list: mocks.list } }));
vi.mock('../../../database/initialize', () => ({ getDatabase: () => ({ query: mocks.query }) }));
vi.mock('../../../window/WindowManager', () => ({ findWindowByWorkspace: mocks.window }));
vi.mock('../voiceSessionLoader', () => ({ loadVoiceSession: mocks.load }));
vi.mock('../voiceIpcAuthorization', () => ({ isSessionInWorkspace: (s: any, project: string) => s?.workspacePath === project }));
vi.mock('../voicePresentationAuthority', () => ({ desktopRealtimeOwnsVoice: () => false, voicePresentationKey: (...args: string[]) => args.join(':'), voicePresentationAuthority: { wasPresented: mocks.presented, claim: mocks.claim, presented: mocks.receipt } }));
import { handleMobileVoiceEvent, claimDesktopVoiceEvent } from '../mobileVoiceEvents';
import type { MobileLiveRequest } from '../mobileLiveRelay';
const request: MobileLiveRequest = { scope: { version: 1, hostDeviceId: 'host', projectId: '/p', voiceGeneration: 'g', actionId: 'a', announcingDeviceId: 'phone' }, tool: 'voice_events', arguments: '{}' };
const session = (id: string, revision = 1) => ({ id, title: id, workspacePath: '/p', updatedAt: revision, metadata: { hostDeviceId: 'host' }, hasPendingInteractivePrompt: true });
beforeEach(() => {
  vi.resetAllMocks();
  mocks.window.mockReturnValue({ isDestroyed: () => false });
  mocks.get.mockImplementation(async id => session(id));
  mocks.list.mockResolvedValue([session('s')]);
  mocks.load.mockImplementation(async (_, id) => ({ sessionId: id, session: { messages: [{ id: 'task', type: 'user_message' }, { id: 'p', type: 'interactive_prompt', interactivePrompt: { requestId: 'q-' + id, status: 'pending' } }] } }));
  mocks.presented.mockReturnValue(false);
  mocks.claim.mockReturnValue({ token: 'token' });
  mocks.receipt.mockReturnValue(true);
});
describe('mobile source events', () => {
  it('finds pending questions beyond an already-presented first page', async () => {
    mocks.list.mockResolvedValue(Array.from({ length: 12 }, (_, i) => session(String(i))));
    mocks.presented.mockImplementation(key => !key.endsWith('q-11'));
    const result = await handleMobileVoiceEvent(request);
    expect(JSON.parse(result.result!).events.map((e: any) => e.eventId)).toEqual(['q-11']);
  });
  it('rejects a source revision change during loading and before claim', async () => {
    mocks.get.mockResolvedValueOnce(session('s')).mockResolvedValueOnce(session('s', 2));
    expect(JSON.parse((await handleMobileVoiceEvent(request)).result!).events).toEqual([]);
    mocks.get.mockResolvedValueOnce(session('s')).mockResolvedValueOnce(session('s')).mockResolvedValueOnce(session('s', 2));
    const result = await handleMobileVoiceEvent({ ...request, tool: 'voice_event_claim', arguments: JSON.stringify({ eventId: 'q-s', taskId: 'task', revision: 1 }) });
    expect(result.success).toBe(false);
    expect(mocks.claim).not.toHaveBeenCalled();
  });
  it('rejects an answered question and never records a stale receipt', async () => {
    mocks.load.mockResolvedValue({ sessionId: 's', session: { messages: [{ type: 'interactive_prompt', interactivePrompt: { requestId: 'q-s', status: 'answered' } }] } });
    expect((await handleMobileVoiceEvent({ ...request, tool: 'voice_event_presented', arguments: JSON.stringify({ eventId: 'q-s', taskId: 'task', revision: 1, token: 'token' }) })).success).toBe(false);
    expect(mocks.receipt).not.toHaveBeenCalled();
  });
  it('denies desktop duplicates after the phone presented an event', async () => {
    mocks.presented.mockReturnValue(true);
    expect(await claimDesktopVoiceEvent('host', '/p', 's', 'q-s')).toBeNull();
    expect(mocks.claim).not.toHaveBeenCalled();
  });
  it('reports the headless limitation explicitly', async () => {
    mocks.window.mockReturnValue(undefined);
    expect(await handleMobileVoiceEvent(request)).toMatchObject({ success: false, error: expect.stringContaining('headless') });
    expect(mocks.list).not.toHaveBeenCalled();
  });
});
