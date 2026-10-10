// @vitest-environment node
/**
 * `onWorkspaceEvent` is the only path an extension panel has to host events, and
 * its filter decides what the Git panel ever hears about.
 *
 * Git watchers are registered PER REPOSITORY, so in a multi-root workspace they
 * name a repo inside an attached folder -- never the primary root. A filter that
 * compares against the primary root alone drops every one of those events, and
 * the panel silently stops refreshing for the attached repo. The Git panel's own
 * tests substitute the host subscription, so only this level can catch it.
 */
import { describe, expect, it, beforeEach, vi } from 'vitest';

const listeners = new Map<string, Array<(data: unknown) => void>>();
const roots: string[] = [];
const invoke = vi.fn(async (..._args: unknown[]) => ({}));

vi.mock('@nimbalyst/runtime/store', () => ({
  store: { get: () => roots },
}));
vi.mock('../ExtensionFileStorageImpl', () => ({
  ExtensionFileStorageImpl: class {},
}));

const { createPanelHost } = await import('../PanelHostImpl');
const { getPanelGutterBadge, prunePanelGutterBadges } = await import('../panelGutterBadges');

function emit(event: string, data: unknown): void {
  for (const listener of listeners.get(event) ?? []) listener(data);
}

function makeHost(workspacePath: string, extra: Record<string, unknown> = {}) {
  return createPanelHost({
    panelId: 'git',
    extensionId: 'nimbalyst.git',
    theme: 'dark',
    workspacePath,
    storage: { get: () => undefined, set: async () => {} } as never,
    onOpenFile: () => {},
    onOpenPanel: () => {},
    onClose: () => {},
    onThemeChange: () => () => {},
    ...extra,
  } as never);
}

beforeEach(() => {
  listeners.clear();
  roots.length = 0;
  invoke.mockClear();
  (globalThis as never as { window: unknown }).window = {
    electronAPI: {
      invoke,
      on: (event: string, callback: (data: unknown) => void) => {
        const forEvent = listeners.get(event) ?? [];
        forEvent.push(callback);
        listeners.set(event, forEvent);
        return () => {};
      },
    },
  };
});

describe('PanelHostImpl.onWorkspaceEvent', () => {
  it('delivers an event naming a repo inside an attached folder', () => {
    roots.push('/repo', '/other/infra');
    const received: unknown[] = [];
    makeHost('/repo').onWorkspaceEvent('git:status-changed', (data) => received.push(data));

    emit('git:status-changed', { workspacePath: '/other/infra/terraform' });

    expect(received).toEqual([{ workspacePath: '/other/infra/terraform' }]);
  });

  it('still drops an event from an unrelated workspace', () => {
    roots.push('/repo', '/other/infra');
    const received: unknown[] = [];
    makeHost('/repo').onWorkspaceEvent('git:status-changed', (data) => received.push(data));

    emit('git:status-changed', { workspacePath: '/somewhere/else' });
    // A sibling directory sharing a prefix is not inside the root.
    emit('git:status-changed', { workspacePath: '/repo-other' });

    expect(received).toEqual([]);
  });

  it('delivers an event with no workspacePath at all', () => {
    roots.push('/repo');
    const received: unknown[] = [];
    makeHost('/repo').onWorkspaceEvent('extension:message', (data) => received.push(data));

    emit('extension:message', { kind: 'ping' });

    expect(received).toEqual([{ kind: 'ping' }]);
  });
});

/**
 * The two panel seams that reach agent state. Main trusts `callerExtensionId`
 * to refuse another extension's backend tools, and the transcript embed must
 * stay on the host's workspace; both hold only because the host fills those
 * values in after the panel's own arguments.
 */
describe('PanelHostImpl agent seams', () => {
  it('stamps backend tool calls with the host extension id, not a panel-supplied one', async () => {
    const host = makeHost('/repo');
    await host.callBackendTool('example.panel_status', { callerExtensionId: 'someone.else' });

    expect(invoke).toHaveBeenCalledWith('extensions:ai-call-backend-tool', {
      toolName: 'example.panel_status',
      args: { callerExtensionId: 'someone.else' },
      workspacePath: '/repo',
      callerExtensionId: 'nimbalyst.git',
    });
  });

  it('offers the transcript only when injected, bound to the host workspace and file opener', () => {
    expect(makeHost('/repo').components).toBeUndefined();

    const opened: string[] = [];
    const Transcript = () => null;
    const host = makeHost('/repo', {
      sessionTranscript: Transcript,
      onOpenFile: (path: string) => opened.push(path),
    });
    const Embed = host.components!.SessionTranscript as (props: object) => { type: unknown; props: Record<string, unknown> };
    const element = Embed({ sessionId: 'session-b', workspacePath: '/elsewhere' });

    expect(element.type).toBe(Transcript);
    expect(element.props.sessionId).toBe('session-b');
    expect(element.props.workspacePath).toBe('/repo');
    (element.props.onOpenFile as (path: string) => void)('/repo/a.ts');
    expect(opened).toEqual(['/repo/a.ts']);
  });
});

describe('PanelHostImpl.setGutterBadge', () => {
  // A fullscreen panel unmounts when the user leaves it; the badge is what
  // brings them back, so it outlives the host. It must not outlive the extension.
  it('keeps the badge after the host is disposed, and drops it once the panel is unregistered', () => {
    const host = makeHost('/repo') as ReturnType<typeof makeHost> & { dispose(): void };
    host.setGutterBadge(3, { tone: 'warning' });
    host.dispose();
    expect(getPanelGutterBadge('git')).toEqual({ count: 3, tone: 'warning' });

    prunePanelGutterBadges(new Set(['other.panel']));
    expect(getPanelGutterBadge('git')).toBeUndefined();

    makeHost('/repo').setGutterBadge(null);
    expect(getPanelGutterBadge('git')).toBeUndefined();
  });
});
