/**
 * Agent browser tab bridge (issue #1728).
 *
 * Keeps agent browser sessions visible as real Nimbalyst browser tabs inside
 * the calling agent's session strip instead of invisible off-screen windows:
 *
 *  - `browser.open_session` opens a background tab by default (`headless: true`
 *    without `foreground: true` keeps the purely headless path).
 *  - `foreground: true` opens the tab active and reveals the session's editor
 *    pane without stealing the user's current mode or selected session.
 *  - Self-chosen `sessionId` names (e.g. `"paypal-connect"`) act as per-agent
 *    aliases for the underlying `browser-virtual:<tabId>` session across all
 *    `browser.*` tools.
 *  - Calling `open_session({ sessionId, foreground: true })` on an existing
 *    headless session promotes it to a tab at its current URL (cookies are
 *    shared via `persist:preview`) and closes the old headless session.
 */

import { randomUUID } from 'crypto';
import type { BrowserWindow } from 'electron';
import { AISessionsRepository } from '@nimbalyst/runtime/storage/repositories/AISessionsRepository';
import {
  BrowserSessionService,
  type BrowserNavigationState,
} from '../../services/BrowserSessionService';

export const AGENT_BROWSER_VIRTUAL_PREFIX = 'virtual://com.nimbalyst.browser/';

interface AgentBrowserTabMeta {
  tabId: string;
  title: string;
  agentSessionId?: string;
}

const GLOBAL_ALIAS_BUCKET = '__global__';

/** Per-agent-session alias -> real BrowserSessionService sessionId. */
const aliasesByAgentSession = new Map<string, Map<string, string>>();

/** Metadata for live agent-opened browser tabs, keyed by real sessionId. */
const tabMetaByRealSessionId = new Map<string, AgentBrowserTabMeta>();

function aliasBucket(agentSessionId?: string): string {
  return agentSessionId?.trim() || GLOBAL_ALIAS_BUCKET;
}

function getOrCreateBucket(agentSessionId?: string): Map<string, string> {
  const key = aliasBucket(agentSessionId);
  let bucket = aliasesByAgentSession.get(key);
  if (!bucket) {
    bucket = new Map();
    aliasesByAgentSession.set(key, bucket);
  }
  return bucket;
}

/** Resolve an agent-chosen session alias to its backing BrowserSessionService id. */
export function resolveBrowserAlias(agentSessionId: string | undefined, sessionId: string): string {
  const trimmed = sessionId.trim();
  if (!trimmed) return trimmed;
  const scoped = aliasesByAgentSession.get(aliasBucket(agentSessionId))?.get(trimmed);
  if (scoped) return scoped;
  if (agentSessionId) {
    const globalHit = aliasesByAgentSession.get(GLOBAL_ALIAS_BUCKET)?.get(trimmed);
    if (globalHit) return globalHit;
  }
  return trimmed;
}

/** Remove an alias and any tab metadata when a browser session is closed. */
export function forgetBrowserAlias(agentSessionId: string | undefined, sessionId: string): void {
  const trimmed = sessionId.trim();
  if (!trimmed) return;
  const bucket = aliasesByAgentSession.get(aliasBucket(agentSessionId));
  const resolved = bucket?.get(trimmed) ?? trimmed;
  bucket?.delete(trimmed);
  if (bucket) {
    for (const [alias, realId] of bucket.entries()) {
      if (realId === resolved) bucket.delete(alias);
    }
    if (bucket.size === 0) aliasesByAgentSession.delete(aliasBucket(agentSessionId));
  }
  tabMetaByRealSessionId.delete(resolved);
}

/** Format the tab title shown in the tab bar: `<session title> · <host>`. */
export function formatAgentBrowserTabTitle(sessionTitle: string | undefined, url: string): string {
  const cleanTitle = (sessionTitle ?? '').replace(/\s+/g, ' ').trim();
  const shortTitle = cleanTitle.length > 32 ? `${cleanTitle.slice(0, 31).trimEnd()}…` : cleanTitle;
  let host = '';
  try {
    host = new URL(url).hostname.replace(/^www\./, '');
  } catch {
    host = '';
  }
  if (shortTitle && host) return `${shortTitle} · ${host}`;
  if (host) return `Agent · ${host}`;
  return shortTitle || 'Agent Browser';
}

export function buildAgentBrowserTabPath(opts: {
  tabId: string;
  url: string;
  title: string;
  agentSessionId?: string;
  foreground?: boolean;
}): string {
  const params = new URLSearchParams();
  params.set('url', opts.url);
  params.set('title', opts.title);
  params.set('agent', '1');
  if (opts.agentSessionId) params.set('session', opts.agentSessionId);
  if (opts.foreground) params.set('foreground', '1');
  return `${AGENT_BROWSER_VIRTUAL_PREFIX}${opts.tabId}?${params.toString()}`;
}

export interface AgentBrowserOpenDeps {
  service?: Pick<
    BrowserSessionService,
    'hasSession' | 'isHeadlessSession' | 'getState' | 'createSession' | 'destroySession'
  >;
  getSessionTitle?: (agentSessionId: string) => Promise<string | undefined>;
  generateTabId?: () => string;
}

export interface AgentBrowserOpenResult {
  content: Array<{ type: string; text: string }>;
  isError: boolean;
}

function formatOpenResult(returnedSessionId: string, state: BrowserNavigationState): AgentBrowserOpenResult {
  const data = { sessionId: returnedSessionId, state };
  return {
    content: [
      {
        type: 'text',
        text: `Opened browser session ${returnedSessionId}\n\nData: ${JSON.stringify(data, null, 2)}`,
      },
    ],
    isError: false,
  };
}

function formatErrorResult(message: string): AgentBrowserOpenResult {
  return {
    content: [{ type: 'text', text: `Error: ${message}` }],
    isError: true,
  };
}

async function lookupSessionTitle(
  agentSessionId: string | undefined,
  deps?: AgentBrowserOpenDeps,
): Promise<string | undefined> {
  if (!agentSessionId) return undefined;
  if (deps?.getSessionTitle) {
    return deps.getSessionTitle(agentSessionId);
  }
  try {
    const session = await AISessionsRepository.get(agentSessionId);
    return session?.title || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Intercept `browser.open_session` to open an agent browser tab in the
 * workspace window. Returns `null` only when the caller explicitly requested
 * `headless: true` without `foreground: true` (handled by the extension's
 * standard headless flow).
 */
export async function handleAgentBrowserOpenSession(opts: {
  args: Record<string, unknown>;
  agentSessionId?: string;
  targetWindow: Pick<BrowserWindow, 'webContents'>;
  deps?: AgentBrowserOpenDeps;
}): Promise<AgentBrowserOpenResult | null> {
  const { args, agentSessionId, targetWindow, deps } = opts;
  const foreground = args.foreground === true;
  const headless = args.headless === true;

  if (headless && !foreground) {
    return null;
  }

  const service = deps?.service ?? BrowserSessionService.getInstance();
  const requestedName = typeof args.sessionId === 'string' ? args.sessionId.trim() : '';
  const resolvedId = requestedName
    ? resolveBrowserAlias(agentSessionId, requestedName)
    : '';
  const url = typeof args.url === 'string' ? args.url.trim() : '';
  const viewport =
    typeof args.width === 'number' && typeof args.height === 'number'
      ? { width: args.width, height: args.height }
      : undefined;

  // Reuse or promote an existing live session referenced by name or real id.
  if (resolvedId && service.hasSession(resolvedId)) {
    const liveState = service.getState(resolvedId);
    if (service.isHeadlessSession(resolvedId) && foreground) {
      // Promote headless -> visible tab at its current URL; persist:preview
      // shares cookies seamlessly across the transition.
      const promoteUrl = liveState?.url || url;
      if (!promoteUrl) {
        return formatErrorResult('url is required');
      }
      const tabId = deps?.generateTabId ? deps.generateTabId() : `agent-${randomUUID().slice(0, 8)}`;
      const realSessionId = `browser-virtual:${tabId}`;
      const sessionTitle = await lookupSessionTitle(agentSessionId, deps);
      const title = formatAgentBrowserTabTitle(sessionTitle, promoteUrl);
      try {
        const state = service.createSession({
          sessionId: realSessionId,
          url: promoteUrl,
          agentOwned: true,
          viewport,
        });
        service.destroySession(resolvedId);
        tabMetaByRealSessionId.set(realSessionId, { tabId, title, agentSessionId });
        if (requestedName) {
          getOrCreateBucket(agentSessionId).set(requestedName, realSessionId);
        }
        const tabPath = buildAgentBrowserTabPath({
          tabId,
          url: promoteUrl,
          title,
          agentSessionId,
          foreground: true,
        });
        targetWindow.webContents.send('open-workspace-file', tabPath);
        return formatOpenResult(requestedName || realSessionId, state);
      } catch (err) {
        return formatErrorResult(err instanceof Error ? err.message : String(err));
      }
    }

    // Already a live tab session: keep its current page intact. Re-send with
    // foreground=1 when bringing it to the front.
    if (foreground) {
      const existingMeta = tabMetaByRealSessionId.get(resolvedId);
      const tabId =
        existingMeta?.tabId ??
        (resolvedId.startsWith('browser-virtual:')
          ? resolvedId.slice('browser-virtual:'.length)
          : '');
      if (tabId) {
        const currentUrl = liveState?.url || url || 'about:blank';
        const title =
          existingMeta?.title ||
          formatAgentBrowserTabTitle(await lookupSessionTitle(agentSessionId, deps), currentUrl);
        const tabPath = buildAgentBrowserTabPath({
          tabId,
          url: currentUrl,
          title,
          agentSessionId: existingMeta?.agentSessionId ?? agentSessionId,
          foreground: true,
        });
        targetWindow.webContents.send('open-workspace-file', tabPath);
      }
    }
    if (liveState) {
      return formatOpenResult(requestedName || resolvedId, liveState);
    }
  }

  // Fresh agent-owned browser tab.
  if (!url) {
    return formatErrorResult('url is required');
  }

  const tabId = deps?.generateTabId ? deps.generateTabId() : `agent-${randomUUID().slice(0, 8)}`;
  const realSessionId = `browser-virtual:${tabId}`;
  const sessionTitle = await lookupSessionTitle(agentSessionId, deps);
  const title = formatAgentBrowserTabTitle(sessionTitle, url);

  try {
    const state = service.createSession({
      sessionId: realSessionId,
      url,
      agentOwned: true,
      viewport,
    });
    tabMetaByRealSessionId.set(realSessionId, { tabId, title, agentSessionId });
    if (requestedName) {
      getOrCreateBucket(agentSessionId).set(requestedName, realSessionId);
    }
    const tabPath = buildAgentBrowserTabPath({
      tabId,
      url,
      title,
      agentSessionId,
      foreground,
    });
    targetWindow.webContents.send('open-workspace-file', tabPath);
    return formatOpenResult(requestedName || realSessionId, state);
  } catch (err) {
    return formatErrorResult(err instanceof Error ? err.message : String(err));
  }
}

/** Tests only: clear alias and tab-metadata registries. */
export function __resetAgentBrowserTabsForTests(): void {
  aliasesByAgentSession.clear();
  tabMetaByRealSessionId.clear();
}
