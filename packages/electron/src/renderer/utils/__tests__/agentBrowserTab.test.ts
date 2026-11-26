import { afterEach, describe, expect, it, vi } from 'vitest';
import { store } from '@nimbalyst/runtime/store';
import {
  AGENT_BROWSER_OPEN_EVENT,
  isSameVirtualBrowserTab,
  openAgentBrowserTabInWorkstream,
  parseAgentBrowserTabPath,
} from '../agentBrowserTab';
import { fileResource, initWorkstreamState, workstreamStateAtom } from '../../store/atoms/workstreamState';

describe('agentBrowserTab helpers', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('parses agent browser tab URIs and ignores non-agent virtual tabs', () => {
    const uri =
      'virtual://com.nimbalyst.browser/agent-123?url=https%3A%2F%2Fpaypal.com&title=PayPal&agent=1&session=sess-a&foreground=1';
    expect(parseAgentBrowserTabPath(uri)).toEqual({
      tabId: 'agent-123',
      baseUri: 'virtual://com.nimbalyst.browser/agent-123',
      agentSessionId: 'sess-a',
      foreground: true,
    });
    expect(
      parseAgentBrowserTabPath('virtual://com.nimbalyst.browser/user-1?title=New+Tab'),
    ).toBeNull();
  });

  it('matches virtual browser tabs by tabId regardless of query params', () => {
    expect(
      isSameVirtualBrowserTab(
        'virtual://com.nimbalyst.browser/agent-1?url=https%3A%2F%2Fa.com&agent=1',
        'virtual://com.nimbalyst.browser/agent-1?url=https%3A%2F%2Fb.com&agent=1&foreground=1',
      ),
    ).toBe(true);
    expect(
      isSameVirtualBrowserTab(
        'virtual://com.nimbalyst.browser/agent-1?agent=1',
        'virtual://com.nimbalyst.browser/agent-2?agent=1',
      ),
    ).toBe(false);
  });

  it('seeds unmounted workstream state in background without stealing active tab or revealing, and reveals on foreground', () => {
    initWorkstreamState('/project');
    const wsId = 'unmounted-ws-browser-test';
    store.set(workstreamStateAtom(wsId), {
      openResources: [{ resource: fileResource('/existing.md') }],
      activeResourceId: '/existing.md',
    });
    const bgUri =
      'virtual://com.nimbalyst.browser/agent-77?url=https%3A%2F%2Fexample.com&title=Test&agent=1&session=unmounted-ws-browser-test';
    const fgUri = `${bgUri}&foreground=1`;

    openAgentBrowserTabInWorkstream({ workstreamId: wsId, filePath: bgUri, foreground: false });
    const afterBg = store.get(workstreamStateAtom(wsId));
    expect(afterBg.openResources.map((r) => r.resource.resourceId)).toEqual(['/existing.md', bgUri]);
    expect(afterBg.activeResourceId).toBe('/existing.md');
    expect(afterBg.layoutMode).toBe('transcript');

    // Foreground re-open focuses the existing tab (no duplicate) and reveals split view.
    openAgentBrowserTabInWorkstream({ workstreamId: wsId, filePath: fgUri, foreground: true });
    const afterFg = store.get(workstreamStateAtom(wsId));
    expect(afterFg.openResources).toHaveLength(2);
    expect(afterFg.activeResourceId).toBe(bgUri);
    expect(afterFg.layoutMode).toBe('split');
  });

  it('dispatches to a mounted workstream via AGENT_BROWSER_OPEN_EVENT without mutating state twice', () => {
    initWorkstreamState('/project');
    const wsId = 'mounted-ws-browser-test';
    const received: unknown[] = [];
    const listener = (e: Event) => {
      e.preventDefault();
      received.push((e as CustomEvent).detail);
    };
    window.addEventListener(AGENT_BROWSER_OPEN_EVENT, listener);
    try {
      const uri = 'virtual://com.nimbalyst.browser/agent-88?url=https%3A%2F%2Fexample.com&agent=1';
      openAgentBrowserTabInWorkstream({ workstreamId: wsId, filePath: uri, foreground: false });
      expect(received).toEqual([{ workstreamId: wsId, filePath: uri, foreground: false }]);
      expect(store.get(workstreamStateAtom(wsId)).openResources).toEqual([]);
    } finally {
      window.removeEventListener(AGENT_BROWSER_OPEN_EVENT, listener);
    }
  });
});
