// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { decodeMobileLiveRequest, MobileLiveActions, type MobileLiveRequest } from '../mobileLiveRelay';

const request: MobileLiveRequest = { scope: { version: 1, hostDeviceId: 'host', projectId: '/project', sessionId: 'session', voiceGeneration: 'generation', actionId: 'action', announcingDeviceId: 'phone' }, tool: 'remember', arguments: '{"text":"fact"}' };
describe('mobile Live relay authority', () => {
  it('rejects another host, project, and substituted session before dispatch', () => {
    expect(decodeMobileLiveRequest(JSON.stringify(request), '/project', 'other')).toBeNull();
    expect(decodeMobileLiveRequest(JSON.stringify(request), '/other', 'host')).toBeNull();
    expect(decodeMobileLiveRequest(JSON.stringify({ ...request, arguments: '{"session_id":"other"}' }), '/project', 'host')).toBeNull();
    expect(decodeMobileLiveRequest(JSON.stringify(request), '/project', 'host')).toEqual(request);
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
