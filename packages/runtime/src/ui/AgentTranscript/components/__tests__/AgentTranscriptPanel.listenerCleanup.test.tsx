/**
 * Regression test for NIM-2019 / issue #943.
 *
 * `AgentTranscriptPanel` used to subscribe to `session-files:updated` itself.
 * `WorkstreamSessionTabs` mounts it with `key={activeSessionId}`, so every
 * session switch is a full remount, and the unsubscribe went through
 * `electronAPI.off()` -- a no-op across Electron's contextBridge. One listener
 * leaked per session switch; the reporter hit 101 of them after 44 hours of
 * uptime, shortly before the renderer crashed.
 *
 * The panel now takes `fileEdits` as a prop and touches no IPC at all, which is
 * what docs/IPC_LISTENERS.md required of it in the first place. The fake
 * `electronAPI` below models the bridge faithfully -- `on()` returns a working
 * unsubscribe, `off()` does nothing -- so a reintroduced subscription shows up
 * as a leak here regardless of which one it uses to clean up.
 */

import React from 'react';
import { render, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentTranscriptPanel } from '../AgentTranscriptPanel';
import type { FileEditSummary } from '../../types';
import type { SessionData } from '../../../../ai/server/types';

vi.mock('virtua', async () => {
  const ReactModule = await import('react');
  return {
    VList: ReactModule.forwardRef(({ children }: { children: React.ReactNode }, ref) => {
      ReactModule.useImperativeHandle(ref, () => ({
        cache: undefined,
        scrollOffset: 0,
        scrollSize: 0,
        viewportSize: 0,
        findItemIndex: () => 0,
        scrollToIndex: vi.fn(),
      }));
      return <div data-testid="mock-vlist">{children}</div>;
    }),
  };
});

/** Listeners currently attached, per channel. */
const listeners = new Map<string, Set<(...args: any[]) => void>>();
let invoke: ReturnType<typeof vi.fn>;

function totalListeners(): number {
  let total = 0;
  for (const set of listeners.values()) total += set.size;
  return total;
}

function installFakeElectronAPI() {
  listeners.clear();
  invoke = vi.fn(async (channel: string) => {
    if (channel === 'session-files:get-by-session') return { success: true, files: [] };
    return { success: true };
  });

  (window as any).electronAPI = {
    invoke,
    on: (channel: string, callback: (...args: any[]) => void) => {
      let set = listeners.get(channel);
      if (!set) {
        set = new Set();
        listeners.set(channel, set);
      }
      // The preload wraps the callback; the wrapper is what actually gets
      // registered, and only the returned closure can remove it.
      const handler = (...args: any[]) => callback(...args);
      set.add(handler);
      return () => set!.delete(handler);
    },
    // Modelled on the old bridge: identity-based removal could not find the
    // wrapper, so this never removed anything.
    off: () => {},
  };
}

function makeSessionData(sessionId: string): SessionData {
  return {
    id: sessionId,
    provider: 'claude-code',
    messages: [],
    createdAt: new Date(1_784_648_445_000),
    updatedAt: new Date(1_784_648_445_000),
    workspacePath: '/tmp/workspace',
    metadata: {},
  } as unknown as SessionData;
}

describe('AgentTranscriptPanel IPC discipline', () => {
  beforeEach(() => {
    installFakeElectronAPI();
    // jsdom has no CSS Custom Highlight API; TranscriptSearchBar uses it.
    (globalThis as any).CSS = { ...(globalThis as any).CSS, highlights: new Map() };
  });

  afterEach(() => {
    cleanup();
    delete (window as any).electronAPI;
  });

  it('subscribes to no IPC channel at all', () => {
    render(
      <AgentTranscriptPanel sessionId="session-a" sessionData={makeSessionData('session-a')} />
    );

    expect(totalListeners()).toBe(0);
  });

  it('does not fetch session files itself -- the host supplies them', () => {
    render(
      <AgentTranscriptPanel sessionId="session-a" sessionData={makeSessionData('session-a')} />
    );

    const fetchedChannels = invoke.mock.calls.map(([channel]) => channel);
    expect(fetchedChannels).not.toContain('session-files:get-by-session');
  });

  it('does not accumulate listeners across repeated session switches', () => {
    // WorkstreamSessionTabs keys the panel by session id, so switching
    // sessions unmounts and remounts it.
    for (let i = 0; i < 50; i++) {
      const sessionId = `session-${i}`;
      const { unmount } = render(
        <AgentTranscriptPanel sessionId={sessionId} sessionData={makeSessionData(sessionId)} />
      );
      unmount();
    }

    expect(totalListeners()).toBe(0);
  });

  it('renders the file edits the host passes in', () => {
    const fileEdits: FileEditSummary[] = [
      { filePath: '/tmp/workspace/src/a.ts', linkType: 'edited', timestamp: '2026-07-22T00:00:00.000Z' },
      { filePath: '/tmp/workspace/src/b.ts', linkType: 'edited', timestamp: '2026-07-22T00:00:01.000Z' },
    ];

    const { container } = render(
      <AgentTranscriptPanel
        sessionId="session-a"
        sessionData={makeSessionData('session-a')}
        fileEdits={fileEdits}
      />
    );

    expect(container.textContent).toContain('a.ts');
    expect(container.textContent).toContain('b.ts');
  });
});
