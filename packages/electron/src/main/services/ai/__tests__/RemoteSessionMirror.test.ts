// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RemoteSessionMirror } from '../RemoteSessionMirror';
import type { SessionChange, SyncProvider } from '@nimbalyst/runtime/sync/types';

function fixture() {
  const entry = { sessionId: 'remote', hostDeviceId: 'sandbox-1', projectId: '/repo', title: 'Remote test', provider: 'claude-code', messageCount: 0, createdAt: 100, updatedAt: 200, lastMessageAt: 200 };
  let changes: ((change: SessionChange) => void) | undefined;
  let status: (() => void) | undefined;
  let index: ((id: string) => void) | undefined;
  const offChange = vi.fn(); const offStatus = vi.fn();
  const provider = {
    fetchIndex: vi.fn(async () => ({ sessions: [entry], projects: [] })),
    getCachedIndexEntry: vi.fn(() => entry),
    getLocalDeviceInfo: () => ({ deviceId: 'desktop' }),
    getConnectedDevices: vi.fn(() => [{ deviceId: 'sandbox-1', isOnline: true }]),
    getStatus: () => ({ connected: true, syncing: false }),
    onIndexChange: (cb: typeof index) => { index = cb; return vi.fn(); },
    onRemoteChange: vi.fn((_id, cb) => { changes = cb; return offChange; }),
    onStatusChange: vi.fn((_id, cb) => { status = cb; return offStatus; }),
    connect: vi.fn(async () => {}), disconnect: vi.fn(),
    pushChange: vi.fn(async (_id: string, _change: SessionChange) => ({ published: true })), sendSessionControlMessage: vi.fn(async () => {}),
  };
  const deps = { hasLocalSession: vi.fn(async () => false), listChanged: vi.fn() };
  const mirror = new RemoteSessionMirror(deps);
  mirror.setProvider(provider as unknown as SyncProvider);
  return { mirror, entry, deps, provider, offChange, offStatus,
    change: (change: SessionChange) => changes?.(change), status: () => status?.(), index: () => index?.('remote') };
}

afterEach(() => vi.useRealTimers());
describe('remote desktop mirrors', () => {
  it('reconnects an observed transcript before queueing after an idle socket expires', async () => {
    const f = fixture();
    const stop = await f.mirror.watch('remote', '/repo', vi.fn());
    f.provider.getStatus = () => ({connected: false, syncing: false});
    await f.mirror.queue('remote', '/repo', 'first turn after idle');
    expect(f.provider.connect).toHaveBeenCalledTimes(2);
    expect(f.provider.pushChange).toHaveBeenCalledTimes(1);
    stop();
  });

  it('serializes submissions while the preceding queue publication is in flight', async () => {
    const f = fixture();
    let release!: () => void;
    const gate = new Promise<void>(resolve => {release = resolve;});
    f.provider.pushChange.mockImplementation(async (_id: string, change: any) => {
      await gate;
      Object.assign(f.entry, {queuedPrompts: change.metadata.queuedPrompts});
      return {published: true};
    });
    const first = f.mirror.queue('remote', '/repo', 'first');
    const second = f.mirror.queue('remote', '/repo', 'second');
    await vi.waitFor(() => expect(f.provider.pushChange).toHaveBeenCalled());
    expect(f.provider.pushChange).toHaveBeenCalledTimes(1);
    release();
    await Promise.all([first, second]);
    expect((f.entry as any).queuedPrompts.map((row: any) => row.prompt)).toEqual(['first', 'second']);
  });

  it('merges remote metadata only in its workspace, with local collisions taking precedence', async () => {
    const f = fixture();
    expect(await f.mirror.list('/other', [])).toEqual([]);
    expect(await f.mirror.list('/repo', [])).toEqual([expect.objectContaining({ id: 'remote', remoteHostDeviceId: 'sandbox-1', workspaceId: '/repo' })]);
    f.deps.hasLocalSession.mockResolvedValue(true);
    expect(await f.mirror.list('/repo', [])).toEqual([]);
    expect(await f.mirror.get('remote', '/repo')).toBeNull();
    await expect(f.mirror.watch('remote', '/repo', vi.fn())).rejects.toThrow('not available');
    expect(f.provider.connect).not.toHaveBeenCalled();
  });

  it('subscribes before connect, renders real canonical messages, deduplicates replay and releases the last viewer', async () => {
    vi.useFakeTimers();
    const f = fixture(); const received = vi.fn();
    f.provider.connect.mockImplementation(async () => {
      f.change({ type: 'message_added', message: { id: 1, sessionId: 'remote', source: 'user', direction: 'input', content: 'Read only, please', createdAt: new Date(100) } });
    });
    const stop = await f.mirror.watch('remote', '/repo', received);
    const stop2 = await f.mirror.watch('remote', '/repo', vi.fn());
    f.change({ type: 'message_added', message: { id: 1, sessionId: 'remote', source: 'user', direction: 'input', content: 'duplicate', createdAt: new Date(100) } });
    await vi.advanceTimersByTimeAsync(200);
    expect(received).toHaveBeenCalled();
    const snapshot = received.mock.lastCall![0];
    expect(snapshot.session.messages).toHaveLength(1);
    expect(JSON.stringify(snapshot.session.messages)).toContain('Read only, please');
    expect(f.provider.connect).toHaveBeenCalledTimes(1);
    stop(); expect(f.provider.disconnect).not.toHaveBeenCalled();
    stop2(); expect(f.provider.disconnect).toHaveBeenCalledWith('remote');
    expect(f.offChange).toHaveBeenCalled(); expect(f.offStatus).toHaveBeenCalled();
    f.mirror.setProvider(null);
  });

  it('rejects workspace mismatches and sends queue/cancel only to the owning host', async () => {
    const f = fixture();
    await expect(f.mirror.queue('remote', '/other', 'hello')).rejects.toThrow('not available');
    expect(f.provider.pushChange).not.toHaveBeenCalled();
    Object.assign(f.entry, { queuedPrompts: [{ id: 'existing', prompt: 'first', timestamp: 1 }] });
    const sent = await f.mirror.queue('remote', '/repo', 'second');
    expect(f.provider.pushChange).toHaveBeenCalledWith('remote', { type: 'metadata_updated', metadata: { queuedPrompts: [
      { id: 'existing', prompt: 'first', timestamp: 1 }, expect.objectContaining({ id: sent.promptId, prompt: 'second' }),
    ] } });
    await f.mirror.cancel('remote', '/repo');
    expect(f.provider.sendSessionControlMessage).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'remote', targetDeviceId: 'sandbox-1', type: 'cancel' }));
    f.provider.getConnectedDevices.mockReturnValue([]);
    await expect(f.mirror.queue('remote', '/repo', 'keep this')).rejects.toThrow('offline');
    expect(f.provider.pushChange).toHaveBeenCalledTimes(1);
  });

  it('publishes encrypted attachments only after encryption and rejects an account change during staging', async () => {
    const f = fixture();
    const key = await crypto.subtle.generateKey({name: 'AES-GCM', length: 256}, false, ['encrypt', 'decrypt']);
    const encrypted = [{id: 'file', filename: 'f.png', mimeType: 'image/png', encryptedData: 'cipher', iv: 'nonce', size: 5}];
    const encryptAttachments = vi.fn(async () => encrypted);
    Object.assign(f.deps, {encryptAttachments});
    f.mirror.setProvider(f.provider as unknown as SyncProvider, key);
    const attachments = [{id: 'file', filename: 'f.png', filepath: '/staged/f.png', mimeType: 'image/png', size: 5, type: 'image' as const, addedAt: 1}];
    await f.mirror.queue('remote', '/repo', 'read it', attachments);
    expect(encryptAttachments).toHaveBeenCalledWith(attachments, '/repo', key);
    expect(f.provider.pushChange).toHaveBeenCalledWith('remote', expect.objectContaining({metadata: {queuedPrompts: [expect.objectContaining({attachments: encrypted})]}}));
    encryptAttachments.mockImplementation(async () => {f.mirror.setProvider(null); return encrypted;});
    await expect(f.mirror.queue('remote', '/repo', 'retain this', attachments)).rejects.toThrow('sync changed');
    expect(f.provider.pushChange).toHaveBeenCalledTimes(1);
  });

  it('keeps history readable but rejects controls after the ephemeral host restarts', async () => {
    vi.useFakeTimers();
    const f = fixture(); const received = vi.fn();
    f.provider.getConnectedDevices.mockReturnValue([{ deviceId: 'sandbox-1', isOnline: true, type: 'headless', connectedAt: 150 }] as any);
    const stop = await f.mirror.watch('remote', '/repo', received);
    await vi.advanceTimersByTimeAsync(200);
    expect(received.mock.lastCall![0].readOnlyReason).toContain('restarted');
    await expect(f.mirror.queue('remote', '/repo', 'keep this')).rejects.toThrow('restarted');
    await expect(f.mirror.cancel('remote', '/repo')).rejects.toThrow('restarted');
    expect(f.provider.pushChange).not.toHaveBeenCalled();
    expect(f.provider.sendSessionControlMessage).not.toHaveBeenCalled();
    stop();
  });

  it('clears transcript content on account change and rejects a stale in-flight authorization', async () => {
    vi.useFakeTimers();
    const f = fixture(); const received = vi.fn();
    await f.mirror.watch('remote', '/repo', received);
    f.mirror.setProvider(null);
    expect(received).toHaveBeenCalledWith(expect.objectContaining({ connected: false, session: expect.objectContaining({ messages: [] }) }));
    expect(await f.mirror.list('/repo', [])).toEqual([]);
    await expect(f.mirror.queue('remote', '/repo', 'hello')).rejects.toThrow('not available');
    const second = fixture();
    let release!: (value: boolean) => void;
    second.deps.hasLocalSession.mockReturnValueOnce(new Promise(resolve => { release = resolve; }));
    const pending = second.mirror.queue('remote', '/repo', 'must not send');
    await vi.advanceTimersByTimeAsync(0);
    second.mirror.setProvider(null); release(false);
    await expect(pending).rejects.toThrow('sync changed');
    expect(second.provider.pushChange).not.toHaveBeenCalled();
  });
});
