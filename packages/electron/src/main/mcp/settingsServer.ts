/**
 * Settings Control MCP Server (`nimbalyst-settings`)
 *
 * Exposes a curated, action-shaped surface for an AI agent to inspect and
 * change Nimbalyst settings on the user's behalf. All mutations route through
 * SettingsControlService which enforces the allow-list, deny-list, rate-limit,
 * and audit logging.
 *
 * See docs/INTERNAL_MCP_SERVERS.md for the standard MCP-server pattern this
 * file follows (per-connection context via query string, SSE + StreamableHTTP
 * transports, per-launch bearer token auth via mcpAuth).
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ErrorCode,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { createServer, IncomingMessage, ServerResponse } from "http";
import { parse as parseUrl } from "url";
import { randomUUID } from "crypto";

import { SettingsControlService } from "../services/SettingsControlService";
import { requireMcpAuth } from "./mcpAuth";

// ─── Transport tracking ─────────────────────────────────────────────

interface TransportMetadata {
  transport: SSEServerTransport;
  aiSessionId: string;
  workspaceId: string | undefined;
}
const activeTransports = new Map<string, TransportMetadata>();

interface StreamableTransportMetadata {
  transport: StreamableHTTPServerTransport;
  aiSessionId: string;
  workspaceId: string | undefined;
}
const activeStreamableTransports = new Map<string, StreamableTransportMetadata>();

let httpServerInstance: any = null;

// ─── Lifecycle ──────────────────────────────────────────────────────

export function cleanupSettingsServer(): void {
  for (const [id, meta] of activeTransports.entries()) {
    try {
      meta.transport.onclose?.();
      const res = (meta.transport as any).res;
      if (res && !res.headersSent) {
        res.end();
      }
    } catch (error) {
      console.error(`[Settings MCP] Error closing transport ${id}:`, error);
    }
  }
  activeTransports.clear();

  for (const [id, meta] of activeStreamableTransports.entries()) {
    try {
      void meta.transport.close().catch((error) => {
        console.error(`[Settings MCP] Error closing streamable ${id}:`, error);
      });
    } catch (error) {
      console.error(`[Settings MCP] Error closing streamable ${id}:`, error);
    }
  }
  activeStreamableTransports.clear();
}

export function shutdownSettingsServer(): Promise<void> {
  return new Promise((resolve) => {
    if (!httpServerInstance) {
      resolve();
      return;
    }
    let done = false;
    const safeResolve = () => {
      if (!done) {
        done = true;
        resolve();
      }
    };
    try {
      cleanupSettingsServer();
    } catch (error) {
      console.error("[Settings MCP] Cleanup error:", error);
    }
    try {
      httpServerInstance.closeAllConnections?.();
    } catch (error) {
      console.error("[Settings MCP] closeAllConnections error:", error);
    }
    try {
      httpServerInstance.close?.((err?: Error) => {
        if (err) console.error("[Settings MCP] close error:", err);
        httpServerInstance = null;
        safeResolve();
      });
    } catch (error) {
      console.error("[Settings MCP] close threw:", error);
      httpServerInstance = null;
      safeResolve();
    }
    setTimeout(() => {
      httpServerInstance = null;
      safeResolve();
    }, 1000);
  });
}

// ─── Tool descriptors ───────────────────────────────────────────────

const TOOLS = [
  {
    name: "settings_get_overview",
    description:
      "Return a curated, redacted snapshot of Nimbalyst settings (app-level + current workspace). NEVER includes API keys, auth tokens, or secrets. Includes Stytch auth state booleans so you can tell whether sync prerequisites are met. Use this before changing anything so you can show the user what's currently set.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "workspace_create",
    description:
      "Create a new project workspace (folder) and optionally open it as a window. Refuses to create on top of a non-empty folder unless force is true; when force is needed, ask the user via AskUserQuestion first and pass force only after confirmation.",
    inputSchema: {
      type: "object",
      properties: {
        targetPath: {
          type: "string",
          description: "Absolute path where the workspace folder should live.",
        },
        openAfterCreate: {
          type: "boolean",
          description: "Open the workspace as a window after creation. Default true.",
        },
        force: {
          type: "boolean",
          description: "Allow creating on top of an existing non-empty folder. Only pass after user confirmation.",
        },
      },
      required: ["targetPath"],
    },
  },
  {
    name: "workspace_open",
    description: "Open an existing folder as a project window (focuses if already open).",
    inputSchema: {
      type: "object",
      properties: {
        workspacePath: { type: "string", description: "Absolute path to an existing folder." },
      },
      required: ["workspacePath"],
    },
  },
  {
    name: "sync_set_for_project",
    description:
      "Enable or disable session sync and/or document sync for a specific project. Requires the user to be signed in with Stytch first; if not, returns requiresUserAction='stytch-signin' and you should ask the user to sign in. WARNING: enabling document sync on a project with hundreds of markdown files will trigger a large initial upload -- ask the user to confirm via AskUserQuestion before turning on document sync for unfamiliar/large projects.",
    inputSchema: {
      type: "object",
      properties: {
        workspacePath: { type: "string", description: "Absolute workspace path." },
        enableSessionSync: {
          type: "boolean",
          description: "Set true to add this project to session sync, false to remove. Omit to leave unchanged.",
        },
        enableDocumentSync: {
          type: "boolean",
          description: "Set true to add this project to document sync, false to remove. Omit to leave unchanged.",
        },
      },
      required: ["workspacePath"],
    },
  },
  {
    name: "appearance_set_theme",
    description:
      "Change the app theme. Accepts built-in themes (dark, light, system, auto, crystal-dark) or an extension theme in the form 'extensionId:themeId'.",
    inputSchema: {
      type: "object",
      properties: {
        theme: { type: "string", description: "Theme identifier." },
      },
      required: ["theme"],
    },
  },
  {
    name: "appearance_set_completion_sound",
    description: "Enable or disable the sound played when an AI session completes.",
    inputSchema: {
      type: "object",
      properties: { enabled: { type: "boolean" } },
      required: ["enabled"],
    },
  },
  {
    name: "appearance_set_spellcheck",
    description: "Enable or disable Chromium's built-in spellchecker for editors and inputs.",
    inputSchema: {
      type: "object",
      properties: { enabled: { type: "boolean" } },
      required: ["enabled"],
    },
  },
  {
    name: "analytics_set_enabled",
    description: "Enable or disable anonymous usage analytics.",
    inputSchema: {
      type: "object",
      properties: { enabled: { type: "boolean" } },
      required: ["enabled"],
    },
  },
  {
    name: "ai_set_default_model",
    description:
      "Set the default AI model for new sessions, in the form 'provider:model' (e.g. 'claude-code:sonnet'). The provider must already be configured.",
    inputSchema: {
      type: "object",
      properties: { providerModel: { type: "string" } },
      required: ["providerModel"],
    },
  },
  {
    name: "ai_set_preferred_language",
    description:
      "Set the preferred natural language for agent output (used by auto-naming and any prompts that respect it). BCP-47 code or common name (e.g. 'ja', 'en', 'French'). Pass empty string to clear.",
    inputSchema: {
      type: "object",
      properties: { language: { type: "string" } },
      required: ["language"],
    },
  },
  {
    name: "ai_set_session_progress_naming",
    description:
      "Enable or disable automatic session title/phase refresh based on progress reviews, configure how many user turns elapse between reviews, and optionally set a session title template using the {name} placeholder. Currently applies to OpenAI Codex sessions.",
    inputSchema: {
      type: "object",
      properties: {
        enabled: { type: "boolean" },
        cadenceTurns: {
          type: "number",
          description: "How many user turns between progress reviews. Integer from 1 to 50.",
        },
        titleTemplate: {
          type: "string",
          description: "Optional session title template. Must include the {name} placeholder, for example 【{name}】 or Session: {name}.",
        },
      },
      required: ["enabled"],
    },
  },
  {
    name: "features_toggle",
    description:
      "Toggle an alpha, beta, or developer feature flag by tag. Alpha and developer toggles require Developer Mode to already be enabled; if not, returns requiresUserAction='developer-mode' and you should ask the user to enable it from Settings > Advanced.",
    inputSchema: {
      type: "object",
      properties: {
        bucket: { type: "string", enum: ["alpha", "beta", "developer"] },
        tag: { type: "string" },
        enabled: { type: "boolean" },
      },
      required: ["bucket", "tag", "enabled"],
    },
  },
  {
    name: "extension_set_enabled",
    description:
      "Enable or disable an installed extension by ID. Does not install or uninstall -- use the nimbalyst-extension-dev tools for that.",
    inputSchema: {
      type: "object",
      properties: {
        extensionId: { type: "string" },
        enabled: { type: "boolean" },
      },
      required: ["extensionId", "enabled"],
    },
  },
  {
    name: "workspace_set_trust",
    description:
      "Set the agent trust mode for a workspace. Permission modes: 'ask' (smart per-tool permission prompts), 'allow-all' (auto-approve file edits), 'bypass-all' (auto-approve every tool including shell). Set trusted=false to untrust. Bypass-all is powerful -- ask the user to confirm via AskUserQuestion before using it on unfamiliar projects.",
    inputSchema: {
      type: "object",
      properties: {
        workspacePath: { type: "string", description: "Absolute workspace path." },
        trusted: {
          type: "boolean",
          description: "true to grant trust at the given mode, false to revoke trust.",
        },
        mode: {
          type: "string",
          enum: ["ask", "allow-all", "bypass-all"],
          description: "Permission mode when trusted=true. Defaults to 'ask'. Ignored when trusted=false.",
        },
      },
      required: ["workspacePath", "trusted"],
    },
  },
  {
    name: "tracker_set_sync_policy",
    description:
      "Set the sync mode for a tracker type within a workspace. Modes: 'local' (no sync), 'shared' (sync to team), 'hybrid' (per-item).",
    inputSchema: {
      type: "object",
      properties: {
        workspacePath: { type: "string" },
        trackerType: { type: "string", description: "Tracker type ID (e.g. 'bug', 'task')." },
        mode: { type: "string", enum: ["local", "shared", "hybrid"] },
      },
      required: ["workspacePath", "trackerType", "mode"],
    },
  },
  {
    name: "tracker_set_issue_key_prefix",
    description:
      "Set the issue key prefix for a workspace (e.g. 'NIM' produces NIM-1, NIM-2). Uppercase letter first, 1-16 chars, A-Z 0-9 _ - only.",
    inputSchema: {
      type: "object",
      properties: {
        workspacePath: { type: "string" },
        prefix: { type: "string" },
      },
      required: ["workspacePath", "prefix"],
    },
  },
] as const;

// ─── MCP server creation ────────────────────────────────────────────

function createSettingsMcpServer(aiSessionId: string, workspaceId: string | undefined): Server {
  const server = new Server(
    { name: "nimbalyst-settings", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );

  (server as { onerror?: (error: Error) => void }).onerror = (error: Error) => {
    console.error("[MCP:nimbalyst-settings] Server error:", error);
  };

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS as any }));

  server.setRequestHandler(CallToolRequestSchema, async (request: any) => {
    const { name, arguments: rawArgs } = request.params;
    const toolName = name.replace(/^mcp__nimbalyst-settings__/, "");
    const args = (rawArgs ?? {}) as Record<string, any>;
    const svc = SettingsControlService.getInstance();

    const respond = (payload: unknown) => ({
      content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
      isError: typeof payload === "object" && payload !== null && (payload as any).ok === false,
    });

    try {
      switch (toolName) {
        case "settings_get_overview":
          return respond({ ok: true, after: svc.getOverview(workspaceId) });

        case "workspace_create":
          return respond(
            await svc.createWorkspace(aiSessionId, {
              targetPath: args.targetPath,
              openAfterCreate: args.openAfterCreate,
              force: args.force,
            }),
          );

        case "workspace_open":
          return respond(await svc.openWorkspace(aiSessionId, { workspacePath: args.workspacePath }));

        case "sync_set_for_project":
          return respond(
            await svc.setProjectSync(aiSessionId, {
              workspacePath: args.workspacePath,
              enableSessionSync: args.enableSessionSync,
              enableDocumentSync: args.enableDocumentSync,
            }),
          );

        case "appearance_set_theme":
          return respond(await svc.setTheme(aiSessionId, { theme: args.theme }));

        case "appearance_set_completion_sound":
          return respond(await svc.setCompletionSound(aiSessionId, { enabled: !!args.enabled }));

        case "appearance_set_spellcheck":
          return respond(await svc.setSpellcheck(aiSessionId, { enabled: !!args.enabled }));

        case "analytics_set_enabled":
          return respond(await svc.setAnalytics(aiSessionId, { enabled: !!args.enabled }));

        case "ai_set_default_model":
          return respond(
            await svc.setDefaultAIModel(aiSessionId, { providerModel: args.providerModel }),
          );

        case "ai_set_preferred_language":
          return respond(
            await svc.setPreferredAgentLanguage(aiSessionId, { language: args.language ?? "" }),
          );

        case "ai_set_session_progress_naming":
          return respond(
            await svc.setSessionProgressNaming(aiSessionId, {
              enabled: !!args.enabled,
              cadenceTurns: args.cadenceTurns,
              titleTemplate: args.titleTemplate,
            }),
          );

        case "features_toggle":
          return respond(
            await svc.toggleFeature(aiSessionId, {
              bucket: args.bucket,
              tag: args.tag,
              enabled: !!args.enabled,
            }),
          );

        case "extension_set_enabled":
          return respond(
            await svc.setExtensionEnabled(aiSessionId, {
              extensionId: args.extensionId,
              enabled: !!args.enabled,
            }),
          );

        case "workspace_set_trust":
          return respond(
            await svc.setWorkspaceTrust(aiSessionId, {
              workspacePath: args.workspacePath,
              trusted: !!args.trusted,
              mode: args.mode,
            }),
          );

        case "tracker_set_sync_policy":
          return respond(
            await svc.setTrackerSyncPolicy(aiSessionId, {
              workspacePath: args.workspacePath,
              trackerType: args.trackerType,
              mode: args.mode,
            }),
          );

        case "tracker_set_issue_key_prefix":
          return respond(
            await svc.setIssueKeyPrefix(aiSessionId, {
              workspacePath: args.workspacePath,
              prefix: args.prefix,
            }),
          );

        default:
          throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
      }
    } catch (error) {
      if (error instanceof McpError) throw error;
      console.error(`[Settings MCP] Tool ${toolName} failed:`, error);
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: "text", text: `Error: ${message}` }],
        isError: true,
      };
    }
  });

  return server;
}

// ─── HTTP server boilerplate (mirrors sessionContextServer) ─────────

function getMcpSessionIdHeader(req: IncomingMessage): string | undefined {
  const headerValue = req.headers["mcp-session-id"];
  if (Array.isArray(headerValue)) return headerValue[0];
  if (typeof headerValue === "string" && headerValue.length > 0) return headerValue;
  return undefined;
}

async function readJsonBody(req: IncomingMessage): Promise<unknown | undefined> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) return undefined;
  const rawBody = Buffer.concat(chunks).toString("utf8").trim();
  if (!rawBody) return undefined;
  try {
    return JSON.parse(rawBody);
  } catch {
    return undefined;
  }
}

function isInitializeMessage(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "method" in value &&
    (value as Record<string, unknown>).method === "initialize"
  );
}

function isInitializePayload(payload: unknown): boolean {
  if (!payload) return false;
  if (Array.isArray(payload)) return payload.some((entry) => isInitializeMessage(entry));
  return isInitializeMessage(payload);
}

async function tryCreateSettingsServer(port: number): Promise<any> {
  return new Promise((resolve, reject) => {
    const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      const parsedUrl = parseUrl(req.url || "", true);
      const pathname = parsedUrl.pathname;
      const mcpSessionIdHeader = getMcpSessionIdHeader(req);

      if (req.method === "OPTIONS") {
        res.writeHead(200, {
          "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
          "Access-Control-Allow-Headers":
            "Authorization, Content-Type, mcp-session-id, mcp-protocol-version",
        });
        res.end();
        return;
      }

      if (pathname === "/mcp" && !requireMcpAuth(req)) {
        res.writeHead(401);
        res.end("Unauthorized");
        return;
      }

      const aiSessionId =
        (parsedUrl.query.sessionId as string | undefined) ?? undefined;
      const workspaceId =
        (parsedUrl.query.workspaceId as string | undefined) ?? undefined;

      if (pathname === "/mcp" && req.method === "GET") {
        if (mcpSessionIdHeader) {
          const meta = activeStreamableTransports.get(mcpSessionIdHeader);
          if (!meta) {
            res.writeHead(404);
            res.end("Streamable session not found");
            return;
          }
          try {
            await meta.transport.handleRequest(req, res);
          } catch (error) {
            console.error("[Settings MCP] streamable GET error:", error);
            if (!res.headersSent) {
              res.writeHead(500);
              res.end("Internal server error");
            }
          }
          return;
        }

        if (!aiSessionId) {
          res.writeHead(400);
          res.end("Missing sessionId");
          return;
        }

        const server = createSettingsMcpServer(aiSessionId, workspaceId);
        const transport = new SSEServerTransport("/mcp", res);
        activeTransports.set(transport.sessionId, {
          transport,
          aiSessionId,
          workspaceId,
        });
        server
          .connect(transport)
          .then(() => {
            transport.onclose = () => {
              activeTransports.delete(transport.sessionId);
            };
          })
          .catch((error) => {
            console.error("[Settings MCP] connect error:", error);
            activeTransports.delete(transport.sessionId);
            if (!res.headersSent) {
              res.writeHead(500);
              res.end();
            }
          });
        return;
      }

      if (pathname === "/mcp" && req.method === "POST") {
        const legacyTransportSessionId = parsedUrl.query.sessionId as string | undefined;
        const legacyMeta = legacyTransportSessionId
          ? activeTransports.get(legacyTransportSessionId)
          : undefined;

        if (legacyMeta && !mcpSessionIdHeader) {
          try {
            await legacyMeta.transport.handlePostMessage(req, res);
          } catch (error) {
            console.error("[Settings MCP] legacy SSE POST error:", error);
            if (!res.headersSent) {
              res.writeHead(500);
              res.end("Internal server error");
            }
          }
          return;
        }

        const parsedBody = await readJsonBody(req);
        if (!mcpSessionIdHeader && legacyTransportSessionId && !isInitializePayload(parsedBody)) {
          res.writeHead(404);
          res.end("Transport session not found");
          return;
        }

        let streamableMeta: StreamableTransportMetadata | undefined = mcpSessionIdHeader
          ? activeStreamableTransports.get(mcpSessionIdHeader)
          : undefined;

        if (mcpSessionIdHeader && !streamableMeta) {
          res.writeHead(404);
          res.end("Streamable session not found");
          return;
        }

        if (!streamableMeta) {
          if (!isInitializePayload(parsedBody)) {
            res.writeHead(400);
            res.end("Missing sessionId");
            return;
          }
          if (!aiSessionId) {
            res.writeHead(400);
            res.end("Missing sessionId");
            return;
          }
          const server = createSettingsMcpServer(aiSessionId, workspaceId);
          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (sid) => {
              activeStreamableTransports.set(sid, {
                transport,
                aiSessionId,
                workspaceId,
              });
            },
          });
          transport.onclose = () => {
            const sid = transport.sessionId;
            if (sid) activeStreamableTransports.delete(sid);
          };
          transport.onerror = (error) => {
            console.error("[Settings MCP] streamable transport error:", error);
          };
          await server.connect(transport);
          streamableMeta = { transport, aiSessionId, workspaceId };
        }

        try {
          await streamableMeta.transport.handleRequest(req, res, parsedBody);
        } catch (error) {
          console.error("[Settings MCP] streamable POST error:", error);
          if (!res.headersSent) {
            res.writeHead(500);
            res.end("Internal server error");
          }
        }
        return;
      }

      if (pathname === "/mcp" && req.method === "DELETE") {
        if (!mcpSessionIdHeader) {
          res.writeHead(400);
          res.end("Missing mcp-session-id header");
          return;
        }
        const meta = activeStreamableTransports.get(mcpSessionIdHeader);
        if (!meta) {
          res.writeHead(404);
          res.end("Streamable session not found");
          return;
        }
        try {
          await meta.transport.handleRequest(req, res);
        } catch (error) {
          console.error("[Settings MCP] streamable DELETE error:", error);
          if (!res.headersSent) {
            res.writeHead(500);
            res.end("Internal server error");
          }
        }
        return;
      }

      res.writeHead(404);
      res.end("Not found");
    });

    httpServer.listen(port, "127.0.0.1", (err?: Error) => {
      if (err) reject(err);
    });
    httpServer.on("listening", () => {
      httpServer.unref();
      resolve(httpServer);
    });
    httpServer.on("error", (err: any) => reject(err));
  });
}

// ─── Public API ─────────────────────────────────────────────────────

export async function startSettingsServer(
  startPort: number = 3559,
): Promise<{ httpServer: any; port: number }> {
  let port = startPort;
  let httpServer: any = null;
  let maxAttempts = 100;
  while (maxAttempts > 0) {
    try {
      httpServer = await tryCreateSettingsServer(port);
      console.log(`[Settings MCP] Started on port ${port}`);
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
    throw new Error(`[Settings MCP] Could not find available port from ${startPort}`);
  }
  httpServerInstance = httpServer;
  return { httpServer, port };
}
