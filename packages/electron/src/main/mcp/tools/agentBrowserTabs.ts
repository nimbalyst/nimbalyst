import type { BrowserWindow } from "electron";
import { AISessionsRepository } from "@nimbalyst/runtime/storage/repositories/AISessionsRepository";
import { BrowserSessionService } from "../../services/BrowserSessionService";

export type BrowserMcpToolResult = {
  content: Array<{ type: string; text: string }>;
  isError: boolean;
};

export type BrowserInterceptOutcome =
  | { handled: true; result: BrowserMcpToolResult }
  | { handled: false; rewrittenArgs: Record<string, unknown> }
  | null;

interface AgentBrowserTabMeta {
  tabUrl: string;
  workstreamId: string | null;
  sessionTitle: string;
}

const aliasesByScope = new Map<string, Map<string, string>>();
const tabsBySessionId = new Map<string, AgentBrowserTabMeta>();

function scopeKey(sessionId: string | undefined, workspacePath: string | undefined): string {
  return sessionId || workspacePath || "__global__";
}

export function resolveAgentBrowserAlias(
  scope: string,
  rawId: string,
): string {
  const trimmed = rawId.trim();
  if (!trimmed) return trimmed;
  return aliasesByScope.get(scope)?.get(trimmed) ?? trimmed;
}

function setAgentBrowserAlias(scope: string, alias: string, realId: string): void {
  if (!alias || alias === realId) return;
  let map = aliasesByScope.get(scope);
  if (!map) {
    map = new Map();
    aliasesByScope.set(scope, map);
  }
  map.set(alias, realId);
}

function cleanupAgentBrowserSession(scope: string, rawId: string, realId: string): void {
  tabsBySessionId.delete(realId);
  const map = aliasesByScope.get(scope);
  if (!map) return;
  if (rawId) map.delete(rawId);
  for (const [k, v] of map.entries()) {
    if (v === realId) map.delete(k);
  }
}

export function resetAgentBrowserTabRegistryForTests(): void {
  aliasesByScope.clear();
  tabsBySessionId.clear();
}

async function resolveAgentSessionMeta(
  sessionId: string | undefined,
): Promise<{ workstreamId: string | null; sessionTitle: string }> {
  if (!sessionId) return { workstreamId: null, sessionTitle: "Agent" };
  try {
    let cur = await AISessionsRepository.get(sessionId);
    if (!cur) return { workstreamId: sessionId, sessionTitle: "Agent" };
    let title = typeof cur.title === "string" && cur.title.trim() ? cur.title.trim() : "";
    let rootId = cur.id || sessionId;
    let hops = 0;
    while (cur?.parentSessionId && hops < 10) {
      hops += 1;
      const parent = await AISessionsRepository.get(cur.parentSessionId);
      if (!parent) break;
      rootId = parent.id || rootId;
      if (!title && typeof parent.title === "string" && parent.title.trim()) {
        title = parent.title.trim();
      }
      cur = parent;
    }
    return { workstreamId: rootId, sessionTitle: title || "Agent" };
  } catch {
    return { workstreamId: sessionId, sessionTitle: "Agent" };
  }
}

export function formatAgentTabTitle(sessionTitle: string, urlStr: string): string {
  const cleanTitle = (sessionTitle || "Agent").replace(/\s+/g, " ").trim();
  const shortTitle = cleanTitle.length > 26 ? `${cleanTitle.slice(0, 25)}…` : cleanTitle;
  let host = "Browser";
  try {
    const parsed = new URL(urlStr);
    host = parsed.hostname.replace(/^www\./i, "") || parsed.protocol.replace(/:$/, "") || "Browser";
  } catch {
    // keep default host label
  }
  return `${shortTitle} · ${host}`;
}

export function buildAgentVirtualTabUrl(
  tabId: string,
  opts: { url?: string; title?: string; sid?: string; workstreamId?: string | null },
): string {
  const qs = new URLSearchParams();
  if (opts.url) qs.set("url", opts.url);
  if (opts.title) qs.set("title", opts.title);
  qs.set("agent", "1");
  if (opts.sid) qs.set("sid", opts.sid);
  if (opts.workstreamId) qs.set("session", opts.workstreamId);
  return `virtual://com.nimbalyst.browser/${tabId}?${qs.toString()}`;
}

function formatMcpResult(
  message: string,
  data?: Record<string, unknown> | null,
  isError = false,
): BrowserMcpToolResult {
  const text = data ? `${message}\n\nData: ${JSON.stringify(data, null, 2)}` : message;
  return { content: [{ type: "text", text }], isError };
}

/**
 * Intercept `browser.*` extension tool calls so agent browser sessions appear
 * as visible/background tabs inside the agent's own workstream tab strip
 * (Issue #1728), with self-chosen `sessionId` aliases resolved across all
 * subsequent browser tool calls.
 */
export async function interceptAgentBrowserTool(
  toolName: string,
  rawArgs: unknown,
  sessionId: string | undefined,
  workspacePath: string | undefined,
  targetWindow: BrowserWindow,
): Promise<BrowserInterceptOutcome> {
  if (!toolName.startsWith("browser.")) return null;

  const args = (rawArgs && typeof rawArgs === "object" ? rawArgs : {}) as Record<string, unknown>;
  const scope = scopeKey(sessionId, workspacePath);
  const service = BrowserSessionService.getInstance();

  if (toolName === "browser.open_session") {
    const wantForeground = args.foreground === true || args.headless === false;
    const explicitHeadless = args.headless === true;
    if (explicitHeadless && !wantForeground) {
      return null;
    }

    const rawId = typeof args.sessionId === "string" ? args.sessionId.trim() : "";
    const resolvedId = rawId ? resolveAgentBrowserAlias(scope, rawId) : "";
    const meta = await resolveAgentSessionMeta(sessionId);
    const viewport =
      typeof args.width === "number" && typeof args.height === "number"
        ? { width: args.width, height: args.height }
        : { width: 1280, height: 900 };

    // 1. Existing live agent tab: keep its page intact, re-foreground if requested.
    if (resolvedId && service.hasSession(resolvedId) && tabsBySessionId.has(resolvedId)) {
      const info = tabsBySessionId.get(resolvedId)!;
      const state = service.getState(resolvedId);
      if (wantForeground) {
        targetWindow.webContents.send("open-workspace-file", `${info.tabUrl}&foreground=1`);
      }
      const externalId = rawId || resolvedId;
      const msg = wantForeground
        ? `Brought browser tab ${externalId} to the front in session "${info.sessionTitle}". Tell the user to open session "${info.sessionTitle}" if they are viewing another session.`
        : `Reusing existing browser tab ${externalId} (current page kept intact).`;
      return { handled: true, result: formatMcpResult(msg, { sessionId: externalId, state }) };
    }

    // 2. Existing live headless session: promote in-place to a tab without reloading.
    if (rawId && service.hasSession(rawId)) {
      const promotedState = service.promoteToAgentTab(rawId, targetWindow);
      const liveUrl =
        promotedState?.url || (typeof args.url === "string" ? args.url : "about:blank");
      const tabId = `agent-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`;
      const title = formatAgentTabTitle(meta.sessionTitle, liveUrl);
      const tabUrl = buildAgentVirtualTabUrl(tabId, {
        url: liveUrl,
        title,
        sid: rawId,
        workstreamId: meta.workstreamId,
      });
      tabsBySessionId.set(rawId, {
        tabUrl,
        workstreamId: meta.workstreamId,
        sessionTitle: meta.sessionTitle,
      });
      targetWindow.webContents.send(
        "open-workspace-file",
        wantForeground ? `${tabUrl}&foreground=1` : tabUrl,
      );
      const msg = wantForeground
        ? `Opened live browser session ${rawId} in visible tab in session "${meta.sessionTitle}" (page state preserved). Tell the user to open session "${meta.sessionTitle}" if needed.`
        : `Attached live browser session ${rawId} as background tab in session "${meta.sessionTitle}".`;
      return {
        handled: true,
        result: formatMcpResult(msg, { sessionId: rawId, state: promotedState }),
      };
    }

    // 3. New agent tab session.
    const url = typeof args.url === "string" ? args.url.trim() : "";
    if (!url) {
      return {
        handled: true,
        result: formatMcpResult(
          "Error: url is required when opening a new browser session",
          null,
          true,
        ),
      };
    }

    const tabId = `agent-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`;
    const browserSessionId = `browser-virtual:${tabId}`;
    try {
      const state = service.createSession({
        sessionId: browserSessionId,
        url,
        agentOwned: true,
        viewport,
        ownerWindow: targetWindow,
      });
      const title = formatAgentTabTitle(meta.sessionTitle, url);
      const tabUrl = buildAgentVirtualTabUrl(tabId, {
        url,
        title,
        workstreamId: meta.workstreamId,
      });
      tabsBySessionId.set(browserSessionId, {
        tabUrl,
        workstreamId: meta.workstreamId,
        sessionTitle: meta.sessionTitle,
      });
      if (rawId) setAgentBrowserAlias(scope, rawId, browserSessionId);
      targetWindow.webContents.send(
        "open-workspace-file",
        wantForeground ? `${tabUrl}&foreground=1` : tabUrl,
      );
      const externalId = rawId || browserSessionId;
      const msg = wantForeground
        ? `Opened visible browser tab ${externalId} in session "${meta.sessionTitle}". Tell the user to open session "${meta.sessionTitle}" if they are viewing another session.`
        : `Opened background browser tab ${externalId} in session "${meta.sessionTitle}".`;
      return { handled: true, result: formatMcpResult(msg, { sessionId: externalId, state }) };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { handled: true, result: formatMcpResult(`Error: ${message}`, null, true) };
    }
  }

  // Resolve aliases for all other browser.* tools (click, type, evaluate, close_session, etc.).
  if (typeof args.sessionId === "string" && args.sessionId.trim()) {
    const rawId = args.sessionId.trim();
    const realId = resolveAgentBrowserAlias(scope, rawId);
    if (toolName === "browser.close_session") {
      cleanupAgentBrowserSession(scope, rawId, realId);
    }
    if (realId !== rawId) {
      return { handled: false, rewrittenArgs: { ...args, sessionId: realId } };
    }
  }

  return null;
}
