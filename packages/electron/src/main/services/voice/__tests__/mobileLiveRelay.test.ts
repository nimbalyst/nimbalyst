// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { decodeMobileLiveRequest, isSessionOwnedByScopedHost, MobileLiveActions, type MobileLiveRequest } from '../mobileLiveRelay';

const request: MobileLiveRequest = { scope: { version: 1, hostDeviceId: 'host', projectId: '/project', sessionId: 'session', voiceGeneration: 'generation', actionId: 'action', announcingDeviceId: 'phone' }, tool: 'remember', arguments: '{"text":"fact"}' };
describe('mobile Live relay authority', () => {
  it('rejects another host, project, and substituted session before dispatch', () => {
    expect(decodeMobileLiveRequest(JSON.stringify(request), '/project', 'other')).toBeNull();
    expect(decodeMobileLiveRequest(JSON.stringify(request), '/other', 'host')).toBeNull();
    expect(decodeMobileLiveRequest(JSON.stringify({ ...request, arguments: '{"session_id":"other"}' }), '/project', 'host')).toBeNull();
    expect(decodeMobileLiveRequest(JSON.stringify(request), '/project', 'host')).toEqual(request);
  });
  it('treats a locally created, unattributed session as owned but never another host or a remote mirror', () => {
    expect(isSessionOwnedByScopedHost({ hostDeviceId: 'host' }, 'host')).toBe(true);
    expect(isSessionOwnedByScopedHost({}, 'host')).toBe(true);
    expect(isSessionOwnedByScopedHost(undefined, 'host')).toBe(true);
    expect(isSessionOwnedByScopedHost({ hostDeviceId: 'other' }, 'host')).toBe(false);
    expect(isSessionOwnedByScopedHost({ remoteHostDeviceId: 'other' }, 'host')).toBe(false);
  });
  it('reserves before awaiting execution and survives a dispatcher restart', async () => {
    const persisted = new Set<string>();
    const make = () => new MobileLiveActions(key => persisted.has(key), key => { persisted.add(key); });
    let finish!: () => void;
    const execute = vi.fn(async () => { await new Promise<void>(resolve => { finish = resolve; }); return { success: true }; });
    const first = make().run(request, execute);
    expect((await make().run(request, execute)).success).toBe(false);
    finish();
    expect((await first).success).toBe(true);
    expect((await make().run(request, execute)).success).toBe(false);
    expect(execute).toHaveBeenCalledOnce();
  });
});
