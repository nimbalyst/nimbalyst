import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { createServer, IncomingMessage, ServerResponse } from "http";
import { parse as parseUrl } from "url";
import { randomUUID } from "crypto";
import * as fs from "fs";
import * as path from "path";
import { BrowserWindow } from "electron";
import { getMostRecentlyFocusedWorkspaceWindow, windowStates, windowFocusOrder } from "../window/WindowManager";
import { windows } from "../window/windowState";
import { workspaceToWindowMap } from "./mcpWorkspaceResolver";
import { requireMcpAuth } from "./mcpAuth";
import { getAllowedClipOrigin, hasAllowedClipContentType } from "./clipRequestGuards";

// Extracted modules
import {
  documentStateBySession,
  getAvailableExtensionTools,
  getAvailableBackendTools,
  resolveBackendWorkspacePath,
  registerWorkspaceMappingForConnection,
  ExtensionToolDefinition,
} from "./mcpWorkspaceResolver";
import { handleBackendTool, isBackendTool } from "./tools/backendToolHandler";
import { setBackendToolsChangeNotifier } from "./backendToolRegistry";

// Tool handlers + schemas
import { handleVoiceAgentSpeak, handleVoiceAgentStop, voiceToolSchemas } from "./tools/voiceToolHandlers";
import { handleDisplayToUser, displayToolSchemas } from "./tools/displayToolHandler";
import {
  handleApplyDiff,
  handleApplyCollabDocEdit,
  handleReadCollabDoc,
  handleStreamContent,
  handleCaptureEditorScreenshot,
  handleGetSessionEditedFiles,
  getEditorToolSchemas,
} from "./tools/editorToolHandlers";
import {
  handleTrackerList,
  handleTrackerGet,
  handleTrackerListTypes,
  handleTrackerDefineType,
  handleTrackerDeleteType,
  handleTrackerCreate,
  handleTrackerUpdate,
  handleTrackerLinkSession,
  handleTrackerUnlinkSession,
  handleTrackerLinkFile,
  handleTrackerAddComment,
  handleTrackerImporterList,
  handleTrackerImporterSearch,
  handleTrackerImport,
  handleTrackerResnapshot,
  handleTrackerGetByUrn,
  trackerToolSchemas,
} from "./tools/trackerToolHandlers";
import {
  handleAskUserQuestion,
  handleToolPermission,
  handleGitCommitProposal,
  handleRequestUserInput,
  getInteractiveToolSchemas,
} from "./tools/interactiveToolHandlers";
import {
  handleFeedbackAnonymizeText,
  handleFeedbackGetEnvironment,
  handleFeedbackOpenGithubIssue,
  feedbackToolSchemas,
} from "./tools/feedbackToolHandlers";
import { handleExtensionTool } from "./tools/extensionToolHandler";
// Host + core tool surfaces folded onto the unified server (MCP consolidation
// Phase 5). Each standalone server still runs (legacy ports, retired in Phase 7)
// but exports its schemas + a dispatch fn so the unified `/mcp/host` (and core
// `update_session_meta`) endpoints serve the same tools via the same handlers.
import { settingsToolSchemas, dispatchSettingsTool } from "./settingsServer";
import {
  SESSION_CONTEXT_TOOL_SCHEMAS,
  dispatchSessionContextTool,
} from "./sessionContextServer";
import { META_AGENT_TOOL_DEFS, dispatchMetaAgentTool } from "./metaAgentServer";
import {
  buildSessionMetaToolSchemas,
  dispatchSessionMetaTool,
} from "./sessionNamingServer";
import {
  McpEndpointSelection,
  resolveMcpEndpoint,
  isMcpEndpoint,
  selectFirstPartyToolsForEndpoint,
  selectExtensionToolsForEndpoint,
  applyCoreAlwaysLoadMeta,
} from "./mcpEndpointRouting";

// Re-export functions that don't need transport state
export {
  registerWorkspaceWindow,
  unregisterWindow,
  unregisterExtensionTools,
  getActiveExtensionShortNames,
} from "./mcpWorkspaceResolver";

// ---- Transport State ----

let mcpServer: Server | null = null;

// Store active SSE transports by session ID
const activeTransports = new Map<string, SSEServerTransport>();

interface StreamableTransportMetadata {
  transport: StreamableHTTPServerTransport;
  nimbalystSessionId?: string;
}
const activeStreamableTransports = new Map<
  string,
  StreamableTransportMetadata
>();

// Store MCP Server instances by Nimbalyst session ID
// Used to send notifications (e.g., tools/list_changed) when document state changes
const serverByNimbalystSession = new Map<string, Server>();

// Store MCP Server instances by workspace path
// Used to send tools/list_changed notifications when extension tools are registered
const serversByWorkspace = new Map<string, Set<Server>>();

// Store the HTTP server instance
let httpServerInstance: any = null;

// ---- Re-export wrappers that inject transport state ----
// Callers import these from httpServer.ts with original 2-arg signatures.
// We wrap to inject the serverByNimbalystSession / serversByWorkspace maps.

import {
  updateDocumentState as _updateDocumentState,
  registerExtensionTools as _registerExtensionTools,
} from "./mcpWorkspaceResolver";

export { documentStateBySession };

/**
 * Update document state for a session.
 * Wraps the resolver's version to inject the server map for tool list notifications.
 */
export function updateDocumentState(state: any, sessionId?: string) {
  _updateDocumentState(state, sessionId, serverByNimbalystSession);
}

/**
 * Register extension tools from a workspace window.
 * Wraps the resolver's version to inject the servers map for notifications.
 */
export function registerExtensionTools(
  workspacePath: string,
  tools: ExtensionToolDefinition[]
) {
  _registerExtensionTools(workspacePath, tools, serversByWorkspace);
}

// When a backend module (re)registers its MCP tools, tell connected sessions to
// re-fetch their tool list. Notifying all connected servers is cheap and
// idempotent (clients just re-list), so we skip per-workspace path resolution.
setBackendToolsChangeNotifier((_workspacePath: string) => {
  for (const servers of serversByWorkspace.values()) {
    for (const server of servers) {
      server.sendToolListChanged().catch(() => {
        // Ignore - client may have disconnected.
      });
    }
  }
});

// ---- Server Lifecycle ----

export async function cleanupMcpServer() {
  // Close all active SSE transports
  for (const [sessionId, transport] of activeTransports.entries()) {
    try {
      if (transport.onclose) {
        transport.onclose();
      }
      const res = (transport as any).res;
      if (res && !res.headersSent) {
        res.end();
      }
    } catch (error) {
      console.error(
        `[MCP Server] Error closing transport ${sessionId}:`,
        error
      );
    }
  }
  activeTransports.clear();
  for (const [
    streamableSessionId,
    metadata,
  ] of activeStreamableTransports.entries()) {
    try {
      await metadata.transport.close().catch((error) => {
        console.error(
          `[MCP Server] Error closing streamable transport ${streamableSessionId}:`,
          error
        );
      });
    } catch (error) {
      console.error(
        `[MCP Server] Error closing streamable transport ${streamableSessionId}:`,
        error
      );
    }
  }
  activeStreamableTransports.clear();
  serverByNimbalystSession.clear();
  serversByWorkspace.clear();

  if (mcpServer) {
    mcpServer = null;
  }
}

export async function shutdownHttpServer(): Promise<void> {
  if (!httpServerInstance) {
    return;
  }

  try {
    await cleanupMcpServer();
  } catch (error) {
    console.error("[MCP Server] Error cleaning up transports:", error);
  }

  return new Promise((resolve) => {
    let hasResolved = false;
    const safeResolve = () => {
      if (!hasResolved) {
        hasResolved = true;
        resolve();
      }
    };

    try {
      if (
        httpServerInstance &&
        typeof httpServerInstance.closeAllConnections === "function"
      ) {
        httpServerInstance.closeAllConnections();
      }
    } catch (error) {
      console.error("[MCP Server] Error closing connections:", error);
    }

    try {
      if (
        httpServerInstance &&
        typeof httpServerInstance.close === "function"
      ) {
        httpServerInstance.close((err?: Error) => {
          if (err) {
            console.error("[MCP Server] Error closing HTTP server:", err);
          }
          httpServerInstance = null;
          safeResolve();
        });
      } else {
        httpServerInstance = null;
        safeResolve();
      }
    } catch (error) {
      console.error("[MCP Server] Error in server close:", error);
      httpServerInstance = null;
      safeResolve();
    }

    const isProduction = process.env.NODE_ENV === "production";
    const timeout = isProduction ? 300 : 1000;

    setTimeout(() => {
      if (httpServerInstance) {
        console.log("[MCP Server] Force destroying HTTP server after timeout");
        httpServerInstance = null;
      }
      safeResolve();
    }, timeout);
  });
}

export async function startMcpHttpServer(
  startPort: number = 3456
): Promise<{ httpServer: any; port: number }> {
  let port = startPort;
  let httpServer: any = null;
  let maxAttempts = 100;

  while (maxAttempts > 0) {
    try {
      httpServer = await tryCreateServer(port);
      break;
    } catch (error: any) {
      if (error.code === "EADDRINUSE") {
        port++;
        maxAttempts--;
      } else {
        throw error;
      }
    }
  }

  if (!httpServer) {
    throw new Error(
      `[MCP Server] Could not find an available port after trying ${100} ports starting from ${startPort}`
    );
  }

  httpServerInstance = httpServer;
  return { httpServer, port };
}

/**
 * Sanitize a tool name so it matches the Claude API pattern ^[a-zA-Z0-9_-]{1,128}$.
 * Extension tools use dots as namespace separators (e.g. "automations.list"),
 * which Claude API rejects. Replace dots with underscores.
 */
function sanitizeToolName(name: string): string {
  return name.replace(/\./g, '_');
}

/**
 * Log (but do not drop) any duplicate tool names in an endpoint's ListTools
 * result. Duplicates indicate a topology/schema wiring bug; we surface them in
 * the logs rather than silently shipping a malformed surface to the agent.
 */
function dedupeAndWarn<T extends { name: string }>(tools: T[], serverName: string): T[] {
  const names = tools.map((t) => t.name);
  const duplicates = names.filter((name, idx) => names.indexOf(name) !== idx);
  if (duplicates.length > 0) {
    console.error(`[MCP:${serverName}] DUPLICATE TOOL NAMES DETECTED:`, duplicates);
    console.error(`[MCP:${serverName}] All tool names:`, names.join(", "));
  }
  return tools;
}

// Host-tool name sets for CallTool routing (MCP consolidation Phase 5). The
// dispatch is endpoint-agnostic — a host tool resolves the same regardless of
// which endpoint surfaced it — so we route by tool name to the owning server's
// extracted dispatch fn. Derived from the same schema arrays listed in
// ListTools so the two never drift.
const SETTINGS_TOOL_NAMES = new Set(settingsToolSchemas.map((t) => t.name));
const SESSION_CONTEXT_TOOL_NAMES = new Set(
  SESSION_CONTEXT_TOOL_SCHEMAS.map((t) => t.name)
);
const META_AGENT_TOOL_NAMES = new Set(META_AGENT_TOOL_DEFS.map((t) => t.name));

// ---- MCP Server Factory ----

function createSharedMcpServer(
  workspacePath: string | undefined,
  sessionId: string | undefined,
  endpoint: McpEndpointSelection = { kind: "legacy" },
  // Phase 5: when true, the `/mcp/host` endpoint omits the settings tools
  // (set for the meta-agent profile and when the settings kill-switch is on)
  // while still serving session-context + meta-agent. Session-context and
  // meta-agent are unaffected.
  excludeHostSettings: boolean = false
): Server {
  // Name the server after the endpoint it serves so multi-endpoint logs are
  // distinguishable. The SDK namespaces tools by the client's config-key, not
  // this self-reported name.
  const serverName =
    endpoint.kind === "firstParty"
      ? endpoint.configKey
      : endpoint.kind === "extension"
        ? `nimbalyst-${endpoint.extensionShortName}`
        : "nimbalyst-fallback";

  const server = new Server(
    { name: serverName, version: "1.0.0" },
    { capabilities: { tools: { listChanged: true } } }
  );

  (server as { onerror?: (error: Error) => void }).onerror = (error: Error) => {
    console.error(`[MCP:${serverName}] Server error:`, error);
  };

  // Register tool list handler
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    let allTools: Array<{ name: string; description: string; inputSchema: any }>;

    if (endpoint.kind === "extension") {
      // Per-extension endpoint: only this extension's tools, no first-party.
      // Return before building the first-party `builtInTools` array — in
      // particular `buildSessionMetaToolSchemas` does an async tag lookup that
      // would otherwise run (and be discarded) on every extension endpoint.
      const currentFilePath = sessionId
        ? documentStateBySession.get(sessionId)?.filePath
        : undefined;
      const extensionTools = await getAvailableExtensionTools(
        workspacePath,
        currentFilePath
      );
      // Backend-module-registered tools (executed by the module, not the
      // renderer) live in a parallel registry; merge them in for this endpoint.
      const backendTools = await getAvailableBackendTools(
        workspacePath,
        currentFilePath
      );
      allTools = [
        ...selectExtensionToolsForEndpoint(extensionTools, endpoint.extensionShortName),
        ...selectExtensionToolsForEndpoint(backendTools, endpoint.extensionShortName),
      ].map((tool) => ({
        name: sanitizeToolName(tool.name),
        description: tool.description,
        inputSchema: tool.inputSchema,
      }));
      return { tools: dedupeAndWarn(allTools, serverName) };
    }

    // update_session_meta carries a dynamic description (workspace tag list);
    // built async per session. Folded into the eager core (`nimbalyst`).
    const sessionMetaSchemas = await buildSessionMetaToolSchemas(sessionId ?? "");

    const builtInTools: Array<{ name: string; description: string; inputSchema: any }> = [
      ...getEditorToolSchemas(sessionId),
      ...displayToolSchemas,
      ...voiceToolSchemas,
      ...getInteractiveToolSchemas(sessionId),
      ...trackerToolSchemas,
      ...feedbackToolSchemas,
      // Host surface (settings + session-context + meta-agent) on `/mcp/host`;
      // update_session_meta on the eager core. The topology reverse index routes
      // each schema to its endpoint via selectFirstPartyToolsForEndpoint.
      ...settingsToolSchemas,
      ...SESSION_CONTEXT_TOOL_SCHEMAS,
      ...META_AGENT_TOOL_DEFS,
      ...sessionMetaSchemas,
    ];

    if (endpoint.kind === "firstParty") {
      // First-party endpoint: only the topology subset for this server.
      allTools = selectFirstPartyToolsForEndpoint(
        builtInTools,
        endpoint.configKey
      );
      // Host endpoint: drop the settings tools for the meta-agent profile /
      // settings kill-switch (session-context + meta-agent stay).
      if (excludeHostSettings) {
        allTools = allTools.filter((tool) => !SETTINGS_TOOL_NAMES.has(tool.name));
      }
      // Core endpoint: mark the always-load subset with per-tool _meta so the
      // interactive/session tools stay eager while display/screenshot defer.
      allTools = applyCoreAlwaysLoadMeta(allTools, endpoint.configKey);
    } else {
      // Fallback (bare `/mcp` or an unknown `/mcp/<x>`): the consolidation is
      // complete and the legacy monolith is retired, so no first-party tools are
      // served here. A stray connection just sees an empty surface.
      allTools = [];
    }

    return { tools: dedupeAndWarn(allTools, serverName) };
  });

  // Register tool execution handler
  server.setRequestHandler(CallToolRequestSchema, async (request: any) => {
    const { name, arguments: args } = request.params;
    if (request.params._meta) {
      console.log(
        `[MCP Server] Tool called: ${name}, _meta:`,
        JSON.stringify(request.params._meta)
      );
    }

    // Strip MCP server prefix if present
    const toolName = name.replace(/^mcp__nimbalyst__/, "");

    try {
      switch (toolName) {
        case "applyDiff":
          return handleApplyDiff(args);

        case "applyCollabDocEdit":
          return handleApplyCollabDocEdit(args);

        case "readCollabDoc":
          return handleReadCollabDoc(args);

        case "streamContent":
          return handleStreamContent(args);

        case "capture_editor_screenshot":
          return handleCaptureEditorScreenshot(args);

        case "display_to_user":
          return handleDisplayToUser(args);

        case "voice_agent_speak":
          return handleVoiceAgentSpeak(args);

        case "voice_agent_stop":
          return handleVoiceAgentStop();

        case "AskUserQuestion":
          return handleAskUserQuestion(args, sessionId, request);

        case "PromptForUserInput":
          return handleRequestUserInput(args, sessionId, workspacePath, request);

        case "get_session_edited_files":
          return handleGetSessionEditedFiles(sessionId);

        case "developer_git_commit_proposal":
        case "developer.git_commit_proposal":
          return handleGitCommitProposal(args, sessionId, workspacePath, request);

        case "tracker_list":
          return handleTrackerList(args, workspacePath);

        case "tracker_get":
          return handleTrackerGet(args, workspacePath);

        case "tracker_list_types":
          return handleTrackerListTypes(args, workspacePath);

        case "tracker_define_type":
          return handleTrackerDefineType(args, workspacePath);

        case "tracker_delete_type":
          return handleTrackerDeleteType(args, workspacePath);

        case "tracker_create":
          return handleTrackerCreate(args, workspacePath, sessionId);

        case "tracker_update":
          return handleTrackerUpdate(args, workspacePath, sessionId);

        case "tracker_link_session":
          return handleTrackerLinkSession(args, sessionId, workspacePath);

        case "tracker_unlink_session":
          return handleTrackerUnlinkSession(args, sessionId, workspacePath);

        case "tracker_link_file":
          return handleTrackerLinkFile(args, sessionId, workspacePath);

        case "tracker_add_comment":
          return handleTrackerAddComment(args, workspacePath);

        case "tracker_importer_list":
          return handleTrackerImporterList(args, workspacePath);

        case "tracker_importer_search":
          return handleTrackerImporterSearch(args, workspacePath);

        case "tracker_import":
          return handleTrackerImport(args, workspacePath);

        case "tracker_resnapshot":
          return handleTrackerResnapshot(args, workspacePath);

        case "tracker_get_by_urn":
          return handleTrackerGetByUrn(args, workspacePath);

        case "feedback_anonymize_text":
          return handleFeedbackAnonymizeText(args, workspacePath);

        case "feedback_get_environment":
          return handleFeedbackGetEnvironment();

        case "feedback_open_github_issue":
          return await handleFeedbackOpenGithubIssue(args);

        default:
          // Host surface (MCP consolidation Phase 5): settings / session-context
          // / meta-agent / update_session_meta, folded onto the unified server.
          // Routed by tool name to the owning server's extracted dispatch fn
          // (same handlers + service singletons + IPC side effects as the
          // retired standalone servers).
          if (SETTINGS_TOOL_NAMES.has(toolName)) {
            // The settings tools are dropped from ListTools when the meta-agent
            // profile / kill-switch is active; enforce the same gate on CallTool
            // so an unlisted tool can't still be executed (the standalone
            // settings server used to be entirely unregistered in that case).
            if (excludeHostSettings) {
              throw new Error(`Tool "${toolName}" is not available in this session`);
            }
            return dispatchSettingsTool(name, args, sessionId ?? "", workspacePath);
          }
          if (SESSION_CONTEXT_TOOL_NAMES.has(toolName)) {
            return dispatchSessionContextTool(name, args, sessionId ?? "", workspacePath ?? "");
          }
          if (META_AGENT_TOOL_NAMES.has(toolName)) {
            const text = await dispatchMetaAgentTool(
              name,
              sessionId ?? "",
              workspacePath ?? "",
              args
            );
            return { content: [{ type: "text", text }], isError: false };
          }
          if (toolName === "update_session_meta") {
            return dispatchSessionMetaTool(name, args, sessionId ?? "");
          }
          // Backend-module tools execute IN the module (main↔backend RPC),
          // unlike renderer extension tools. Route them before the renderer
          // fallback so a backend tool never round-trips to the renderer. The
          // registry/module are keyed by the project path, so resolve worktree
          // paths first.
          if (workspacePath) {
            const resolvedBackendWs = await resolveBackendWorkspacePath(workspacePath);
            if (isBackendTool(toolName, resolvedBackendWs)) {
              return handleBackendTool(toolName, name, args, resolvedBackendWs);
            }
          }
          return handleExtensionTool(toolName, name, args, sessionId, workspacePath);
      }
    } catch (error) {
      console.error(`[MCP:${serverName}] Tool "${name}" failed:`, error);
      console.error(`[MCP:${serverName}] Tool args:`, JSON.stringify(args).slice(0, 500));
      throw error;
    }
  });

  return server;
}

// ---- HTTP Transport Helpers ----

function getMcpSessionIdHeader(req: IncomingMessage): string | undefined {
  const headerValue = req.headers["mcp-session-id"];
  if (Array.isArray(headerValue)) {
    return headerValue[0];
  }
  if (typeof headerValue === "string" && headerValue.length > 0) {
    return headerValue;
  }
  return undefined;
}

async function readJsonBody(
  req: IncomingMessage
): Promise<unknown | undefined> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) {
    return undefined;
  }
  const rawBody = Buffer.concat(chunks).toString("utf8").trim();
  if (!rawBody) {
    return undefined;
  }
  try {
    return JSON.parse(rawBody);
  } catch {
    return undefined;
  }
}

function isInitializeMessage(value: unknown): boolean {
  return typeof value === 'object' && value !== null && 'method' in value && (value as Record<string, unknown>).method === 'initialize';
}

function isInitializePayload(payload: unknown): boolean {
  if (!payload) {
    return false;
  }
  if (Array.isArray(payload)) {
    return payload.some((entry) => isInitializeMessage(entry));
  }
  return isInitializeMessage(payload);
}

// ---- HTTP Server Creation ----

async function tryCreateServer(port: number): Promise<any> {
  return new Promise((resolve, reject) => {
    const httpServer = createServer(
      async (req: IncomingMessage, res: ServerResponse) => {
        const parsedUrl = parseUrl(req.url || "", true);
        const pathname = parsedUrl.pathname;
        const mcpSessionIdHeader = getMcpSessionIdHeader(req);

        // Handle CORS preflight.
        // Issue #146: do not echo `Access-Control-Allow-Origin: *` on /mcp;
        // bearer token is the sole gate. /clip is restricted to extension
        // origins plus JSON requests so arbitrary web pages cannot write into
        // the active workspace.
        if (req.method === "OPTIONS") {
          if (pathname === "/clip") {
            const allowedOrigin = getAllowedClipOrigin(req);
            if (!allowedOrigin) {
              res.writeHead(403);
              res.end("Forbidden");
              return;
            }
            res.writeHead(200, {
              "Access-Control-Allow-Origin": allowedOrigin,
              "Access-Control-Allow-Methods": "POST, OPTIONS",
              "Access-Control-Allow-Headers": "Content-Type",
              Vary: "Origin",
            });
          } else {
            res.writeHead(200, {
              "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
              "Access-Control-Allow-Headers":
                "Authorization, Content-Type, mcp-session-id, mcp-protocol-version",
            });
          }
          res.end();
          return;
        }

        // NIM-806 Phase 4 (Direction A): loopback endpoint the genuine CLI's
        // PreToolUse permission hook POSTs to. Renders the ToolPermission widget
        // (via handleToolPermission) and returns the user's decision, which the
        // hook translates into the CLI's permissionDecision. Bearer-gated like
        // /mcp. Reuses the same handler/widget/cache as the (dead-interactively)
        // --permission-prompt-tool path — only the transport differs.
        if (pathname === "/permission" && req.method === "POST") {
          if (!requireMcpAuth(req)) {
            res.writeHead(401);
            res.end("Unauthorized");
            return;
          }
          const body = (await readJsonBody(req)) as
            | { sessionId?: string; toolName?: string; toolInput?: unknown; cwd?: string }
            | undefined;
          const permSessionId = body?.sessionId;
          const permToolName = body?.toolName;
          if (!permSessionId || !permToolName) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ decision: "ask", reason: "missing sessionId or toolName" }));
            return;
          }
          try {
            // The handler blocks until the user answers the widget (up to ~10m).
            const result = await handleToolPermission(
              { tool_name: permToolName, input: body?.toolInput ?? {} },
              permSessionId,
              body?.cwd,
              {},
            );
            let decision: "allow" | "deny" = "deny";
            try {
              const behavior = JSON.parse(result.content?.[0]?.text || "{}");
              decision = behavior?.behavior === "allow" ? "allow" : "deny";
            } catch {
              // malformed → deny (fail closed for an answered prompt)
            }
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ decision }));
          } catch (err) {
            console.error("[MCP Server] /permission handler error:", err);
            // True error (not a deny) → let the CLI fall back to its native prompt.
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ decision: "ask", reason: "permission handler error" }));
          }
          return;
        }

        // Issue #146: every non-OPTIONS request to an /mcp endpoint must carry
        // the per-launch bearer token. /clip stays open below (intentional, per
        // plan: web-clipper extension fires from the user's browser).
        if (isMcpEndpoint(pathname) && !requireMcpAuth(req)) {
          res.writeHead(401);
          res.end("Unauthorized");
          return;
        }

        // Endpoint-path routing: which split server (or legacy full surface)
        // this connection serves. null for non-/mcp paths (handled below).
        const mcpEndpoint = resolveMcpEndpoint(pathname);

        // Handle SSE GET request to establish connection
        if (isMcpEndpoint(pathname) && req.method === "GET") {
          // Streamable HTTP GET (session established, uses Mcp-Session-Id header)
          if (mcpSessionIdHeader) {
            const metadata = activeStreamableTransports.get(mcpSessionIdHeader);
            if (!metadata) {
              res.writeHead(404);
              res.end("Streamable session not found");
              return;
            }

            try {
              await metadata.transport.handleRequest(req, res);
            } catch (error) {
              console.error(
                "[MCP Server] Error handling streamable GET request:",
                error
              );
              if (!res.headersSent) {
                res.writeHead(500);
                res.end("Internal server error");
              }
            }
            return;
          }

          // Extract workspace path and session ID from query parameters
          const workspacePath = parsedUrl.query.workspacePath as
            | string
            | undefined;
          const sessionId = parsedUrl.query.sessionId as string | undefined;

          if (workspacePath !== undefined && typeof workspacePath !== 'string') {
            res.writeHead(400);
            res.end("Invalid workspacePath parameter");
            return;
          }
          if (sessionId !== undefined && typeof sessionId !== 'string') {
            res.writeHead(400);
            res.end("Invalid sessionId parameter");
            return;
          }

          registerWorkspaceMappingForConnection(workspacePath);

          const server = createSharedMcpServer(
            workspacePath,
            sessionId,
            mcpEndpoint ?? { kind: "legacy" },
            parsedUrl.query.hostExcludeSettings === "1"
          );

          // Create SSE transport. The message path must match this endpoint so
          // the client POSTs follow-ups back to the same /mcp[/...] path.
          const transport = new SSEServerTransport(pathname || "/mcp", res);
          activeTransports.set(transport.sessionId, transport);

          // SSE keepalive: send periodic comment pings to prevent the
          // TCP connection from going idle during long-running MCP tool
          // waits (e.g., AskUserQuestion waiting for user input).
          // Without this, the connection can silently die and the SDK
          // subprocess never receives the tool result.
          const keepaliveInterval = setInterval(() => {
            try {
              if (!res.writableEnded) {
                res.write(": keepalive\n\n");
              } else {
                clearInterval(keepaliveInterval);
              }
            } catch {
              clearInterval(keepaliveInterval);
            }
          }, 30_000);

          if (sessionId) {
            serverByNimbalystSession.set(sessionId, server);
          }
          if (workspacePath) {
            if (!serversByWorkspace.has(workspacePath)) {
              serversByWorkspace.set(workspacePath, new Set());
            }
            serversByWorkspace.get(workspacePath)!.add(server);
          }

          server
            .connect(transport)
            .then(() => {
              transport.onclose = () => {
                clearInterval(keepaliveInterval);
                activeTransports.delete(transport.sessionId);
                if (sessionId) {
                  serverByNimbalystSession.delete(sessionId);
                }
                if (workspacePath) {
                  serversByWorkspace.get(workspacePath)?.delete(server);
                }
              };
            })
            .catch((error) => {
              console.error("[MCP Server] Connection error:", error);
              clearInterval(keepaliveInterval);
              activeTransports.delete(transport.sessionId);
              if (sessionId) {
                serverByNimbalystSession.delete(sessionId);
              }
              if (workspacePath) {
                serversByWorkspace.get(workspacePath)?.delete(server);
              }
              if (!res.headersSent) {
                res.writeHead(500);
                res.end();
              }
            });
        } else if (isMcpEndpoint(pathname) && req.method === "POST") {
          // Legacy SSE POST flow: route to existing SSE transport if found
          const legacyTransportSessionId = parsedUrl.query.sessionId as
            | string
            | undefined;

          if (legacyTransportSessionId !== undefined && typeof legacyTransportSessionId !== 'string') {
            res.writeHead(400);
            res.end("Invalid sessionId parameter");
            return;
          }

          const legacyTransport = legacyTransportSessionId
            ? activeTransports.get(legacyTransportSessionId)
            : undefined;

          if (legacyTransport && !mcpSessionIdHeader) {
            try {
              await legacyTransport.handlePostMessage(req, res);
            } catch (error) {
              console.error(
                "[MCP Server] Error handling legacy SSE POST message:",
                error
              );
              if (!res.headersSent) {
                res.writeHead(500);
                res.end("Internal server error");
              }
            }
            return;
          }

          // Streamable HTTP flow (initialize or existing session)
          const parsedBody = await readJsonBody(req);

          if (
            !mcpSessionIdHeader &&
            legacyTransportSessionId &&
            !isInitializePayload(parsedBody)
          ) {
            res.writeHead(404);
            res.end("Session not found");
            return;
          }

          let streamableMetadata: StreamableTransportMetadata | undefined =
            mcpSessionIdHeader
              ? activeStreamableTransports.get(mcpSessionIdHeader)
              : undefined;

          if (mcpSessionIdHeader && !streamableMetadata) {
            res.writeHead(404);
            res.end("Streamable session not found");
            return;
          }

          if (!streamableMetadata) {
            if (!isInitializePayload(parsedBody)) {
              res.writeHead(400);
              res.end("Missing sessionId");
              return;
            }

            const workspacePath = parsedUrl.query.workspacePath as
              | string
              | undefined;
            const nimbalystSessionId = parsedUrl.query.sessionId as
              | string
              | undefined;

            if (workspacePath !== undefined && typeof workspacePath !== 'string') {
              res.writeHead(400);
              res.end("Invalid workspacePath parameter");
              return;
            }
            if (nimbalystSessionId !== undefined && typeof nimbalystSessionId !== 'string') {
              res.writeHead(400);
              res.end("Invalid sessionId parameter");
              return;
            }

            registerWorkspaceMappingForConnection(workspacePath);

            const server = createSharedMcpServer(
              workspacePath,
              nimbalystSessionId,
              mcpEndpoint ?? { kind: "legacy" },
              parsedUrl.query.hostExcludeSettings === "1"
            );
            if (workspacePath) {
              if (!serversByWorkspace.has(workspacePath)) {
                serversByWorkspace.set(workspacePath, new Set());
              }
              serversByWorkspace.get(workspacePath)!.add(server);
            }

            const transport = new StreamableHTTPServerTransport({
              sessionIdGenerator: () => randomUUID(),
              onsessioninitialized: (streamableSessionId) => {
                activeStreamableTransports.set(streamableSessionId, {
                  transport,
                  nimbalystSessionId,
                });
                if (nimbalystSessionId) {
                  serverByNimbalystSession.set(nimbalystSessionId, server);
                }
              },
            });

            transport.onclose = () => {
              const streamableSessionId = transport.sessionId;
              if (streamableSessionId) {
                activeStreamableTransports.delete(streamableSessionId);
              }
              if (nimbalystSessionId) {
                serverByNimbalystSession.delete(nimbalystSessionId);
              }
              if (workspacePath) {
                serversByWorkspace.get(workspacePath)?.delete(server);
              }
            };

            transport.onerror = (error) => {
              console.error("[MCP Server] Streamable transport error:", error);
            };

            await server.connect(transport);
            streamableMetadata = { transport, nimbalystSessionId };
          }

          try {
            await streamableMetadata.transport.handleRequest(
              req,
              res,
              parsedBody
            );
          } catch (error) {
            console.error(
              "[MCP Server] Error handling streamable POST request:",
              error
            );
            if (!res.headersSent) {
              res.writeHead(500);
              res.end("Internal server error");
            }
          }
        } else if (isMcpEndpoint(pathname) && req.method === "DELETE") {
          // Streamable HTTP session termination
          if (!mcpSessionIdHeader) {
            res.writeHead(400);
            res.end("Missing mcp-session-id header");
            return;
          }

          const metadata = activeStreamableTransports.get(mcpSessionIdHeader);
          if (!metadata) {
            res.writeHead(404);
            res.end("Streamable session not found");
            return;
          }

          try {
            await metadata.transport.handleRequest(req, res);
          } catch (error) {
            console.error(
              "[MCP Server] Error handling streamable DELETE request:",
              error
            );
            if (!res.headersSent) {
              res.writeHead(500);
              res.end("Internal server error");
            }
          }
        } else if (pathname === "/clip" && req.method === "POST") {
          // Handle web clip from browser extension
          const allowedOrigin = getAllowedClipOrigin(req);
          if (!allowedOrigin) {
            res.writeHead(403, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Forbidden" }));
            return;
          }
          if (!hasAllowedClipContentType(req)) {
            res.writeHead(415, {
              "Access-Control-Allow-Origin": allowedOrigin,
              "Content-Type": "application/json",
              Vary: "Origin",
            });
            res.end(JSON.stringify({ error: "Content-Type must be application/json" }));
            return;
          }

          res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
          res.setHeader("Vary", "Origin");
          const body = await readJsonBody(req) as any;
          if (!body || !body.content) {
            res.writeHead(400);
            res.end("Missing content");
            return;
          }

          // Find the most recently focused workspace window.
          // windowStates and windows Maps are keyed by custom windowId (not BrowserWindow.id).
          // Pick the workspace window with the highest focus order.
          let targetWindowId: number | null = null;
          let targetWindow: BrowserWindow | null = null;
          let workspacePath: string | null = null;
          let bestFocusOrder = -1;

          for (const [wid, state] of windowStates) {
            if (state?.workspacePath && (state.mode === 'workspace' || state.mode === 'agentic-coding')) {
              const fo = windowFocusOrder.get(wid) || 0;
              if (fo > bestFocusOrder) {
                const win = windows.get(wid);
                if (win && !win.isDestroyed()) {
                  bestFocusOrder = fo;
                  targetWindowId = wid;
                  targetWindow = win;
                  workspacePath = state.workspacePath;
                }
              }
            }
          }

          if (!workspacePath || !targetWindow) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: "No workspace window open" }));
            return;
          }

          const clipTitle = body.title || "Untitled Clip";
          const clipUrl = body.url || "";
          const content = body.selection || body.content;

          // Build filename from title
          const sanitized = clipTitle
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "")
            .slice(0, 80);
          const dateStr = new Date().toISOString().slice(0, 10);

          const clipsDir = path.join(workspacePath, "nimbalyst-local", "clips");
          if (!fs.existsSync(clipsDir)) {
            fs.mkdirSync(clipsDir, { recursive: true });
          }

          const frontmatter = [
            "---",
            `title: "${clipTitle.replace(/"/g, '\\"')}"`,
            `url: "${clipUrl}"`,
            `clipped: ${new Date().toISOString()}`,
            body.selection ? "type: selection" : "type: page",
            "---",
          ].join("\n");

          let finalPath = path.join(clipsDir, `${dateStr}-${sanitized}.md`);
          if (fs.existsSync(finalPath)) {
            let counter = 2;
            while (fs.existsSync(path.join(clipsDir, `${dateStr}-${sanitized}-${counter}.md`))) {
              counter++;
            }
            finalPath = path.join(clipsDir, `${dateStr}-${sanitized}-${counter}.md`);
          }

          fs.writeFileSync(finalPath, `${frontmatter}\n\n${content}`, "utf-8");
          console.log(`[Clip] Saved: ${finalPath}`);

          // Open the file in the target window
          targetWindow!.webContents.send("open-document", { path: finalPath });

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: true, path: finalPath }));
        } else {
          res.writeHead(404);
          res.end("Not found");
        }
      }
    );

    httpServer.listen(port, "127.0.0.1", (err?: Error) => {
      if (err) {
        reject(err);
      }
    });

    httpServer.on("listening", () => {
      httpServer.unref();
      resolve(httpServer);
    });

    httpServer.on("error", (err: any) => {
      reject(err);
    });
  });
}
