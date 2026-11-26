// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../services/BrowserSessionService', () => ({
  BrowserSessionService: { getInstance: vi.fn() },
}));
vi.mock('@nimbalyst/runtime/storage/repositories/AISessionsRepository', () => ({
  AISessionsRepository: { get: vi.fn(async () => null) },
}));

import {
  __resetAgentBrowserTabsForTests,
  buildAgentBrowserTabPath,
  forgetBrowserAlias,
  formatAgentBrowserTabTitle,
  handleAgentBrowserOpenSession,
  resolveBrowserAlias,
} from '../agentBrowserTabs';
import type { BrowserNavigationState } from '../../../services/BrowserSessionService';

function createFakeService() {
  const sessions = new Map<string, { state: BrowserNavigationState; headless: boolean }>();
  return {
    sessions,
    hasSession: vi.fn((id: string) => sessions.has(id)),
    isHeadlessSession: vi.fn((id: string) => sessions.get(id)?.headless === true),
    getState: vi.fn((id: string) => sessions.get(id)?.state ?? null),
    createSession: vi.fn((opts: { sessionId: string; url: string; headless?: boolean; agentOwned?: boolean }) => {
      const state: BrowserNavigationState = {
        sessionId: opts.sessionId,
        url: opts.url,
        title: '',
        isLoading: true,
        canGoBack: false,
        canGoForward: false,
      };
      sessions.set(opts.sessionId, { state, headless: opts.headless === true });
      return state;
    }),
    destroySession: vi.fn((id: string) => {
      sessions.delete(id);
    }),
  };
}

describe('agentBrowserTabs', () => {
  afterEach(() => {
    __resetAgentBrowserTabsForTests();
    vi.restoreAllMocks();
  });

  it('formats tab titles as "<session> · <host>"', () => {
    expect(formatAgentBrowserTabTitle('Flippa PayPal', 'https://www.paypal.com/login')).toBe(
      'Flippa PayPal · paypal.com',
    );
    expect(formatAgentBrowserTabTitle(undefined, 'https://flippa.com/deal')).toBe(
      'Agent · flippa.com',
    );
  });

  it('passes through pure headless requests when foreground is not set', async () => {
    const service = createFakeService();
    const send = vi.fn();
    const result = await handleAgentBrowserOpenSession({
      args: { url: 'https://example.com', headless: true },
      agentSessionId: 'sess-1',
      targetWindow: { webContents: { send } } as never,
      deps: { service },
    });
    expect(result).toBeNull();
    expect(send).not.toHaveBeenCalled();
  });

  it('opens a background agent tab by default and maps custom sessionId aliases', async () => {
    const service = createFakeService();
    const send = vi.fn();
    const result = await handleAgentBrowserOpenSession({
      args: { url: 'https://paypal.com/entry', sessionId: 'paypal-connect' },
      agentSessionId: 'sess-1',
      targetWindow: { webContents: { send } } as never,
      deps: {
        service,
        getSessionTitle: async () => 'Deal Room',
        generateTabId: () => 'agent-abc',
      },
    });

    expect(result?.isError).toBe(false);
    expect(result?.content[0].text).toContain('Opened browser session paypal-connect');
    expect(resolveBrowserAlias('sess-1', 'paypal-connect')).toBe('browser-virtual:agent-abc');
    expect(service.createSession).toHaveBeenCalledWith({
      sessionId: 'browser-virtual:agent-abc',
      url: 'https://paypal.com/entry',
      agentOwned: true,
      viewport: undefined,
    });
    expect(send).toHaveBeenCalledWith(
      'open-workspace-file',
      buildAgentBrowserTabPath({
        tabId: 'agent-abc',
        url: 'https://paypal.com/entry',
        title: 'Deal Room · paypal.com',
        agentSessionId: 'sess-1',
        foreground: false,
      }),
    );

    // Calling open_session again with foreground: true brings the same tab to front without recreating it.
    send.mockClear();
    const fg = await handleAgentBrowserOpenSession({
      args: { url: 'https://paypal.com/entry', sessionId: 'paypal-connect', foreground: true },
      agentSessionId: 'sess-1',
      targetWindow: { webContents: { send } } as never,
      deps: {
        service,
        getSessionTitle: async () => 'Deal Room',
        generateTabId: () => 'agent-unused',
      },
    });
    expect(fg?.isError).toBe(false);
    expect(service.createSession).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(
      'open-workspace-file',
      expect.stringContaining('virtual://com.nimbalyst.browser/agent-abc?'),
    );
    expect(send.mock.calls[0][1]).toContain('foreground=1');

    forgetBrowserAlias('sess-1', 'paypal-connect');
    expect(resolveBrowserAlias('sess-1', 'paypal-connect')).toBe('paypal-connect');
  });

  it('promotes an existing headless session to a foreground tab at its live URL', async () => {
    const service = createFakeService();
    service.createSession({
      sessionId: 'headless-1',
      url: 'https://www.paypal.com/challenge',
      headless: true,
    });
    const send = vi.fn();

    const result = await handleAgentBrowserOpenSession({
      args: { url: 'https://www.paypal.com/start', sessionId: 'headless-1', foreground: true },
      agentSessionId: 'sess-2',
      targetWindow: { webContents: { send } } as never,
      deps: {
        service,
        getSessionTitle: async () => 'Checkout',
        generateTabId: () => 'agent-promoted',
      },
    });

    expect(result?.isError).toBe(false);
    expect(service.destroySession).toHaveBeenCalledWith('headless-1');
    expect(resolveBrowserAlias('sess-2', 'headless-1')).toBe('browser-virtual:agent-promoted');
    expect(service.createSession).toHaveBeenLastCalledWith({
      sessionId: 'browser-virtual:agent-promoted',
      url: 'https://www.paypal.com/challenge',
      agentOwned: true,
      viewport: undefined,
    });
    expect(send).toHaveBeenCalledWith(
      'open-workspace-file',
      expect.stringContaining('foreground=1'),
    );
  });
});
