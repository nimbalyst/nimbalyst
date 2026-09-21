// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import type { SyncProvider, ProjectConfig } from '@nimbalyst/runtime/sync/types';
import { createProjectConfigSync } from '../sync/projectConfigSync';

const command = { name: 'investigate', source: 'project' as const };
const action = { id: 'review', label: 'Review', body: 'Review this change' };

function setup() {
  const send = vi.fn(async (_path: string, _config: ProjectConfig) => {});
  const provider = { syncProjectConfig: send } as unknown as SyncProvider;
  const deps = {
    getProvider: () => provider,
    getGitRemoteHash: async () => 'remote-hash',
    getEnabledProjects: () => ['/project'],
    isProjectEnabled: (path: string): boolean => path === '/project',
    discoverCommands: vi.fn(async () => [command]),
    discoverActions: vi.fn(async () => [action]),
    warn: vi.fn(),
    subscribeChanges: vi.fn(async (_path: string, _changed: () => void): Promise<() => void> => vi.fn(() => {})),
  };
  return { sync: createProjectConfigSync(deps), deps, send, provider };
}

describe('mobile project config lifecycle', () => {
  it('debounces a burst of file events into one trailing publish', async () => {
    vi.useFakeTimers();
    try {
      const { sync, send, deps } = setup();
      await sync.refresh();
      send.mockClear();
      const changed = deps.subscribeChanges.mock.calls[0][1];
      for (let i = 0; i < 30; i++) changed();
      await vi.advanceTimersByTimeAsync(499);
      expect(send).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(send).toHaveBeenCalledTimes(1);
      sync.stop();
    } finally { vi.useRealTimers(); }
  });

  it('coalesces refresh requests during a blocked publish into one follow-up', async () => {
    const { sync, send, deps } = setup();
    let finish!: (commands: typeof command[]) => void;
    deps.discoverCommands.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const first = sync.refresh();
    await vi.waitFor(() => expect(deps.discoverCommands).toHaveBeenCalled());
    const updates = Array.from({ length: 30 }, () => sync.refresh());
    finish([command]);
    await Promise.all([first, ...updates]);
    expect(send).toHaveBeenCalledTimes(2);
    sync.stop();
  });

  it('spends only one readiness timeout on a burst of offline file edits', async () => {
    vi.useFakeTimers();
    try {
      const { sync, deps, provider } = setup();
      await sync.refresh();
      provider.waitForIndexReady = vi.fn(() => new Promise<void>((_, reject) => setTimeout(() => reject(new Error('offline')), 5000)));
      const changed = deps.subscribeChanges.mock.calls[0][1];
      for (let i = 0; i < 30; i++) changed();
      await vi.advanceTimersByTimeAsync(5500);
      expect(provider.waitForIndexReady).toHaveBeenCalledTimes(1);
      expect(deps.warn).toHaveBeenCalledTimes(1);
      sync.stop();
    } finally { vi.useRealTimers(); }
  });

  it('publishes while watcher setup is blocked, then prunes a disabled project immediately', async () => {
    const { sync, send, deps } = setup();
    const unsubscribe = vi.fn();
    let finish!: (unsubscribe: () => void) => void;
    deps.subscribeChanges.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    await sync.refresh('/project');
    expect(send).toHaveBeenCalledTimes(1);
    deps.isProjectEnabled = () => false;
    await sync.refresh('/project');
    finish(unsubscribe);
    await Promise.resolve();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    sync.stop();
  });

  it('publishes both slices for a persisted bulk selection without incremental session sync', async () => {
    const { sync, send, deps } = setup();
    let selected: string[] = [];
    deps.getEnabledProjects = () => selected;
    deps.isProjectEnabled = path => selected.includes(path);
    await sync.refresh();
    expect(send).not.toHaveBeenCalled();
    selected = ['/one', '/two'];
    await sync.refresh();
    for (const path of selected) {
      expect(send).toHaveBeenCalledWith(path, expect.objectContaining({ commands: [command], actions: [action] }));
    }
    const unsubscribes = await Promise.all(deps.subscribeChanges.mock.results.map(result => result.value));
    selected = [];
    await sync.refresh();
    unsubscribes.forEach(unsubscribe => expect(unsubscribe).toHaveBeenCalledTimes(1));
    expect(send).toHaveBeenCalledTimes(2);
    sync.stop();
  });
  it('rediscovers on an automatic provider reconnect without any desktop action', async () => {
    const { sync, send, deps, provider } = setup();
    let connected: (() => void) | undefined;
    const unsubscribe = vi.fn();
    provider.onConnectionGenerationChange = vi.fn(callback => { connected = () => callback(2); return unsubscribe; });
    await sync.refresh();
    expect(connected).toBeTypeOf('function');
    deps.discoverCommands.mockResolvedValue([]);
    connected!();
    await vi.waitFor(() => expect(send.mock.calls.at(-1)![1].commands).toEqual([]));
    sync.stop();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
  it('starts a fresh enabled project without a composer and keeps both slices current on reconnect', async () => {
    const { sync, send, deps } = setup();
    await sync.refresh();
    expect(send).toHaveBeenLastCalledWith('/project', expect.objectContaining({ commands: [command], actions: [action] }));
    const changed = { ...action, body: 'Updated while disconnected' };
    deps.discoverActions.mockResolvedValue([changed]);
    deps.discoverCommands.mockResolvedValue([]);
    await sync.refresh();
    expect(send).toHaveBeenLastCalledWith('/project', expect.objectContaining({ commands: [], actions: [changed] }));
  });
  it('rediscovers both slices after file changes and releases disabled project subscriptions', async () => {
    const { sync, send, deps } = setup();
    await sync.refresh();
    const changed = deps.subscribeChanges.mock.calls[0][1];
    const unsubscribe = await deps.subscribeChanges.mock.results[0].value;
    deps.discoverActions.mockResolvedValue([]);
    changed();
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    expect(send.mock.calls.at(-1)![1].actions).toBeUndefined();
    deps.isProjectEnabled = () => false;
    await sync.refresh();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    changed();
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('waits for transport readiness and retries a failed connection on the next refresh', async () => {
    const { sync, send, deps, provider } = setup();
    provider.waitForIndexReady = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined);
    await sync.refresh();
    expect(send).not.toHaveBeenCalled();
    expect(deps.warn).toHaveBeenCalledWith(expect.stringContaining('Failed to sync project config'), expect.any(Error));
    await sync.refresh();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('serializes a file change during discovery and publishes the new contents last', async () => {
    const { sync, send, deps } = setup();
    let finish!: (commands: typeof command[]) => void;
    deps.discoverCommands.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const refreshing = sync.refresh();
    await vi.waitFor(() => expect(deps.discoverCommands).toHaveBeenCalled());
    const updated = { name: 'new-command', source: 'project' as const };
    deps.discoverCommands.mockResolvedValue([updated]);
    const update = sync.refresh();
    finish([command]);
    await Promise.all([refreshing, update]);
    expect(send).toHaveBeenLastCalledWith('/project', expect.objectContaining({ commands: [updated], actions: [action] }));
  });

  it('never publishes to a replacement account or a project disabled during discovery', async () => {
    for (const changeAccount of [true, false]) {
      const { sync, send, deps } = setup();
      deps.discoverCommands.mockImplementationOnce(async () => {
        if (changeAccount) deps.getProvider = () => ({}) as SyncProvider;
        else deps.isProjectEnabled = () => false;
        return [command];
      });
      await sync.refresh();
      expect(send).not.toHaveBeenCalled();
    }
  });

  it('seeds a newly enabled project during an existing refresh and stops stale watcher callbacks', async () => {
    const { sync, send, deps } = setup();
    let finish!: (commands: typeof command[]) => void;
    deps.discoverCommands.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const first = sync.refresh();
    await vi.waitFor(() => expect(deps.discoverCommands).toHaveBeenCalled());
    deps.getEnabledProjects = () => ['/project', '/new'];
    deps.isProjectEnabled = () => true;
    const enabled = sync.refresh();
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith('/new', expect.objectContaining({ commands: [command], actions: [action] })));
    finish([command]);
    await Promise.all([first, enabled]);
    sync.stop();
    const sent = send.mock.calls.length;
    deps.subscribeChanges.mock.calls.forEach(([, changed]) => changed());
    await Promise.resolve();
    expect(send).toHaveBeenCalledTimes(sent);
  });

  it('logs discovery failures with the project and retries on the next refresh', async () => {
    const { sync, send, deps } = setup();
    const error = new Error('permission denied');
    deps.discoverActions.mockRejectedValueOnce(error);
    await sync.refresh();
    expect(send).not.toHaveBeenCalled();
    expect(deps.warn).toHaveBeenCalledWith('[SyncManager] Failed to sync project config for /project', error);
    await sync.refresh();
    expect(send).toHaveBeenCalledWith('/project', expect.objectContaining({ commands: [command], actions: [action] }));
  });
});
