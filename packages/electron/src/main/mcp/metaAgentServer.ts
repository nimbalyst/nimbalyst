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
import { requireMcpAuth } from "./mcpAuth";
import { resolveProjectPath } from "../utils/workspaceDetection";

type CreateSessionArgs = {
  title?: string;
  provider?: string;
  model?: string;
  prompt?: string;
  useWorktree?: boolean;
  worktreeId?: string;
};

type SpawnSessionArgs = {
  title?: string;
  prompt: string;
  useWorktree?: boolean;
  model?: string;
  notifyOnComplete?: boolean;
  /**
   * When true, the new session is created at the top level — no parent,
   * no workstream container, no shared files-edited or tabs with the
   * caller. Use for fix-and-commit-separately work that should not pollute
   * the caller's workstream. When false (the default), the new session is
   * spawned as a sibling under the caller's workstream.
   */
  isolated?: boolean;
};

type RespondToPromptArgs = {
  sessionId: string;
  promptId: string;
  promptType:
    | "permission_request"
    | "ask_user_question_request"
    | "exit_plan_mode_request";
  response: Record<string, unknown>;
};

interface MetaAgentToolFns {
  listWorktrees: (
    metaSessionId: string,
    workspaceId: string
  ) => Promise<string>;
  createSession: (
    metaSessionId: string,
    workspaceId: string,
    args: CreateSessionArgs
  ) => Promise<string>;
  spawnSession: (
    callerSessionId: string,
    workspaceId: string,
    args: SpawnSessionArgs
  ) => Promise<string>;
  getSessionStatus: (
    metaSessionId: string,
    workspaceId: string,
    targetSessionId: string
  ) => Promise<string>;
  getSessionResult: (
    metaSessionId: string,
    workspaceId: string,
    targetSessionId: string
  ) => Promise<string>;
  sendPrompt: (
    metaSessionId: string,
    workspaceId: string,
    targetSessionId: string,
    prompt: string
  ) => Promise<string>;
  respondToPrompt: (
    metaSessionId: string,
    workspaceId: string,
    args: RespondToPromptArgs
  ) => Promise<string>;
  listSpawnedSessions: (
    metaSessionId: string,
    workspaceId: string
  ) => Promise<string>;
}

interface TransportMetadata {
  transport: SSEServerTransport;
  aiSessionId: string;
  workspaceId: string;
}

interface StreamableTransportMetadata {
  transport: StreamableHTTPServerTransport;
  aiSessionId: string;
  workspaceId: string;
}

const activeTransports = new Map<string, TransportMetadata>();
const activeStreamableTransports = new Map<string, StreamableTransportMetadata>();

let httpServerInstance: any = null;
let toolFns: MetaAgentToolFns | null = null;

export function setMetaAgentToolFns(fns: MetaAgentToolFns): void {
  toolFns = fns;
}

export function cleanupMetaAgentServer(): void {
  for (const [transportId, metadata] of activeTransports.entries()) {
    try {
      if (metadata.transport.onclose) {
        metadata.transport.onclose();
      }
      const res = (metadata.transport as any).res;
      if (res && !res.headersSent) {
        res.end();
      }
    } catch (error) {
      console.error(`[Meta Agent MCP] Error closing transport ${transportId}:`, error);
    }
  }
  activeTransports.clear();

  for (const [id, metadata] of activeStreamableTransports.entries()) {
    try {
      void metadata.transport.close().catch((error) => {
        console.error(`[Meta Agent MCP] Error closing streamable transport ${id}:`, error);
      });
    } catch (error) {
      console.error(`[Meta Agent MCP] Error closing streamable transport ${id}:`, error);
    }
  }
  activeStreamableTransports.clear();
}

export function shutdownMetaAgentServer(): Promise<void> {
  return new Promise((resolve) => {
    if (!httpServerInstance) {
      resolve();
      return;
    }

    let resolved = false;
    const finish = () => {
      if (!resolved) {
        resolved = true;
        resolve();
      }
    };

    try {
      cleanupMetaAgentServer();
    } catch (error) {
      console.error("[Meta Agent MCP] Error cleaning up transports:", error);
    }

    try {
      if (httpServerInstance?.closeAllConnections) {
        httpServerInstance.closeAllConnections();
      }
    } catch (error) {
      console.error("[Meta Agent MCP] Error closing connections:", error);
    }

    try {
      if (httpServerInstance?.close) {
        httpServerInstance.close((err?: Error) => {
          if (err) {
            console.error("[Meta Agent MCP] Error closing server:", err);
          }
          httpServerInstance = null;
          finish();
        });
      } else {
        httpServerInstance = null;
        finish();
      }
    } catch (error) {
      console.error("[Meta Agent MCP] Error during shutdown:", error);
      httpServerInstance = null;
      finish();
    }

    setTimeout(() => {
      httpServerInstance = null;
      finish();
    }, 1000);
  });
}

export async function startMetaAgentServer(
  startPort: number = 3461
): Promise<{ httpServer: any; port: number }> {
  let port = startPort;
  let httpServer: any = null;
  let remainingAttempts = 100;

  while (remainingAttempts > 0) {
    try {
      httpServer = await tryCreateMetaAgentServer(port);
      break;
    } catch (error: any) {
      if (error?.code === "EADDRINUSE") {
        port += 1;
        remainingAttempts -= 1;
      } else {
        throw error;
      }
    }
  }

  if (!httpServer) {
    throw new Error(
      `[Meta Agent MCP] Could not find an available port after trying 100 ports starting from ${startPort}`
    );
  }

  httpServerInstance = httpServer;
  return { httpServer, port };
}

function createMetaAgentMcpServer(
  aiSessionId: string,
  workspaceId: string
): Server {
  const server = new Server(
    {
      name: "nimbalyst-meta-agent",
      version: "1.0.0",
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  (server as { onerror?: (error: Error) => void }).onerror = (error: Error) => {
    console.error("[MCP:nimbalyst-meta-agent] Server error:", error);
  };

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        {
          name: "list_worktrees",
          description:
            "List the available git worktrees for this workspace so you can attach a child session to an existing branch or decide whether to create a fresh worktree.",
          inputSchema: {
            type: "object",
            properties: {},
          },
        },
        {
          name: "create_session",
          description:
            "Spawn a new child session for a focused task. Can optionally create a dedicated worktree or attach the session to an existing worktree, then seed it with an initial prompt.",
          inputSchema: {
            type: "object",
            properties: {
              title: {
                type: "string",
                description: "Optional title for the child session.",
              },
              provider: {
                type: "string",
                enum: ["claude-code", "openai-codex"],
                description: "Provider to use for the child session.",
              },
              model: {
                type: "string",
                description: "Optional explicit model identifier.",
              },
              prompt: {
                type: "string",
                description: "Optional initial prompt to queue for the child session immediately after creation.",
              },
              useWorktree: {
                type: "boolean",
                description: "Whether to create the child session inside a fresh git worktree.",
              },
              worktreeId: {
                type: "string",
                description:
                  "Optional existing worktree ID to attach this child session to. Do not combine with useWorktree.",
              },
            },
          },
        },
        {
          name: "spawn_session",
          description:
            "Spawn a new session from the calling session. By default the new session runs as a sibling under the same workstream as the caller (sharing files-edited, tabs, and get_workstream_overview); if the caller is not yet part of a workstream, a workstream container is created and the caller is reparented under it. The new session also inherits the caller's working directory: if the caller is running in a worktree, the spawned session runs in that same worktree (so its edits land where the user is looking). Pass isolated=true to instead create a top-level session with no parent and no workstream — use this when the new session should fix-and-commit work independently without polluting the caller's workstream. Pass useWorktree=true to give the spawned session its OWN new worktree instead of inheriting the caller's. Fire-and-forget by default — the calling session is not notified when the spawned session completes; pass notifyOnComplete=true to opt in. Use this for the /launch-new-session flow.",
          inputSchema: {
            type: "object",
            properties: {
              prompt: {
                type: "string",
                description:
                  "REQUIRED. Self-contained handoff brief for the new session. Should describe the task, relevant file paths, decisions already made, and a pointer back to the current session id (the new session can call get_session_summary to read more).",
              },
              title: {
                type: "string",
                description: "Optional short title for the new session.",
              },
              isolated: {
                type: "boolean",
                description:
                  "Default false. When true, the new session is created at the top level — no parent, no workstream container, no shared files-edited or tabs with the caller. Use for fix-and-commit-separately work that should not pollute the caller's workstream.",
              },
              useWorktree: {
                type: "boolean",
                description:
                  "Default false. By default the spawned session inherits the caller's working directory: if the caller is in a worktree, the new session runs in that same worktree; if the caller is in the main checkout, the new session runs there too. Set true only when the user explicitly asks for the new session to get its OWN new worktree (separate branch and working directory) — this creates a fresh worktree rather than inheriting the caller's.",
              },
              model: {
                type: "string",
                description: "Optional explicit model identifier. Defaults to the caller's provider/model defaults.",
              },
              notifyOnComplete: {
                type: "boolean",
                description:
                  "Default false. When false (the default), the calling session receives no follow-up prompt when the spawned session completes/errors/waits — fire and forget. Set true only when the caller specifically wants to be told the result and continue working with it.",
              },
            },
            required: ["prompt"],
          },
        },
        {
          name: "get_session_status",
          description:
            "Get the current status of a child session including last activity time and whether it is waiting for input.",
          inputSchema: {
            type: "object",
            properties: {
              sessionId: {
                type: "string",
                description: "The session ID to inspect.",
              },
            },
            required: ["sessionId"],
          },
        },
        {
          name: "get_session_result",
          description:
            "Get the current or final result of a session including prompts, recent responses, edited files, and pending interactive prompts.",
          inputSchema: {
            type: "object",
            properties: {
              sessionId: {
                type: "string",
                description: "The session ID to inspect.",
              },
            },
            required: ["sessionId"],
          },
        },
        {
          name: "send_prompt",
          description:
            "Queue a follow-up prompt for a child session. If the session is idle, prompt processing starts immediately.",
          inputSchema: {
            type: "object",
            properties: {
              sessionId: {
                type: "string",
                description: "The target child session ID.",
              },
              prompt: {
                type: "string",
                description: "The follow-up prompt to send.",
              },
            },
            required: ["sessionId", "prompt"],
          },
        },
        {
          name: "respond_to_prompt",
          description:
            "Answer a child session's interactive prompt such as AskUserQuestion, ExitPlanMode, or ToolPermission.",
          inputSchema: {
            type: "object",
            properties: {
              sessionId: {
                type: "string",
                description: "The child session waiting for input.",
              },
              promptId: {
                type: "string",
                description: "The interactive prompt ID.",
              },
              promptType: {
                type: "string",
                enum: [
                  "permission_request",
                  "ask_user_question_request",
                  "exit_plan_mode_request",
                ],
                description: "The kind of prompt being answered.",
              },
              response: {
                type: "object",
                description: "Prompt-specific response payload.",
              },
            },
            required: ["sessionId", "promptId", "promptType", "response"],
          },
        },
        {
          name: "list_spawned_sessions",
          description:
            "List all child sessions created by this meta-agent session, including current status and a short summary.",
          inputSchema: {
            type: "object",
            properties: {},
          },
        },
      ],
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request: any) => {
    const { name, arguments: args } = request.params;
    const toolName = name.replace(/^mcp__nimbalyst-meta-agent__/, "");

    if (!toolFns) {
      return {
        content: [{ type: "text", text: "Error: Meta-agent service not initialized" }],
        isError: true,
      };
    }

    try {
      // Normalize the URL-provided workspaceId to its canonical repo path.
      // When the caller session lives inside a git worktree, the MCP server
      // is launched with workspaceId = worktree directory, but sessions and
      // session-list broadcasts compare workspace ids by exact string match
      // against the renderer's active workspace (the parent repo path). Without
      // this rewrite, sessions created via MCP from a worktree caller never
      // appear in the UI, and spawn_session's parent lookup fails with
      // "Parent session not found in this workspace". Mirrors the existing
      // worktree-path fallback used by getAIProviderOverridesWithWorktreeFallback.
      const effectiveWorkspaceId = resolveProjectPath(workspaceId);

      switch (toolName) {
        case "list_worktrees":
          return {
            content: [
              {
                type: "text",
                text: await toolFns.listWorktrees(aiSessionId, effectiveWorkspaceId),
              },
            ],
            isError: false,
          };
        case "create_session":
          return {
            content: [
              {
                type: "text",
                text: await toolFns.createSession(aiSessionId, effectiveWorkspaceId, args ?? {}),
              },
            ],
            isError: false,
          };
        case "spawn_session":
          return {
            content: [
              {
                type: "text",
                text: await toolFns.spawnSession(aiSessionId, effectiveWorkspaceId, args as SpawnSessionArgs),
              },
            ],
            isError: false,
          };
        case "get_session_status":
          return {
            content: [
              {
                type: "text",
                text: await toolFns.getSessionStatus(
                  aiSessionId,
                  effectiveWorkspaceId,
                  args?.sessionId as string
                ),
              },
            ],
            isError: false,
          };
        case "get_session_result":
          return {
            content: [
              {
                type: "text",
                text: await toolFns.getSessionResult(
                  aiSessionId,
                  effectiveWorkspaceId,
                  args?.sessionId as string
                ),
              },
            ],
            isError: false,
          };
        case "send_prompt":
          return {
            content: [
              {
                type: "text",
                text: await toolFns.sendPrompt(
                  aiSessionId,
                  effectiveWorkspaceId,
                  args?.sessionId as string,
                  args?.prompt as string
                ),
              },
            ],
            isError: false,
          };
        case "respond_to_prompt":
          return {
            content: [
              {
                type: "text",
                text: await toolFns.respondToPrompt(aiSessionId, effectiveWorkspaceId, args),
              },
            ],
            isError: false,
          };
        case "list_spawned_sessions":
          return {
            content: [
              {
                type: "text",
                text: await toolFns.listSpawnedSessions(aiSessionId, effectiveWorkspaceId),
              },
            ],
            isError: false,
          };
        default:
          throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
      }
    } catch (error) {
      if (error instanceof McpError) throw error;
      console.error(`[MCP:nimbalyst-meta-agent] Tool "${name}" failed:`, error);
      console.error(`[MCP:nimbalyst-meta-agent] Tool args:`, JSON.stringify(args).slice(0, 500));
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: "text", text: `Error: ${message}` }],
        isError: true,
      };
    }
  });

  return server;
}

function getMcpSessionIdHeader(req: IncomingMessage): string | undefined {
  const headerValue = req.headers["mcp-session-id"];
  if (Array.isArray(headerValue)) return headerValue[0];
  if (typeof headerValue === "string" && headerValue.length > 0) return headerValue;
  return undefined;
}

const MAX_BODY_SIZE = 10 * 1024 * 1024; // 10 MB

async function readJsonBody(req: IncomingMessage): Promise<unknown | undefined> {
  const chunks: Buffer[] = [];
  let totalSize = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalSize += buf.length;
    if (totalSize > MAX_BODY_SIZE) {
      throw new Error("Request body too large");
    }
    chunks.push(buf);
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

async function tryCreateMetaAgentServer(port: number): Promise<any> {
  return new Promise((resolve, reject) => {
    const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      const parsedUrl = parseUrl(req.url || "", true);
      const pathname = parsedUrl.pathname;
      const mcpSessionIdHeader = getMcpSessionIdHeader(req);

      // Issue #146: drop `Access-Control-Allow-Origin: *`; bearer token is
      // the sole gate. SDK subprocesses don't care about CORS.
      if (req.method === "OPTIONS") {
        res.writeHead(200, {
          "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
          "Access-Control-Allow-Headers":
            "Authorization, Content-Type, mcp-session-id, mcp-protocol-version",
        });
        res.end();
        return;
      }

      // Issue #146: every non-OPTIONS request to /mcp must carry the
      // per-launch bearer token.
      if (pathname === "/mcp" && !requireMcpAuth(req)) {
        res.writeHead(401);
        res.end("Unauthorized");
        return;
      }

      if (pathname === "/mcp" && req.method === "GET") {
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
            console.error("[Meta Agent MCP] Error handling streamable GET:", error);
            if (!res.headersSent) {
              res.writeHead(500);
              res.end("Internal server error");
            }
          }
          return;
        }

        const aiSessionId = parsedUrl.query.sessionId as string;
        const workspaceId = parsedUrl.query.workspaceId as string;

        if (!aiSessionId || typeof aiSessionId !== "string") {
          res.writeHead(400);
          res.end("Missing or invalid sessionId parameter");
          return;
        }

        if (!workspaceId || typeof workspaceId !== "string") {
          res.writeHead(400);
          res.end("Missing or invalid workspaceId parameter");
          return;
        }

        const server = createMetaAgentMcpServer(aiSessionId, workspaceId);
        const transport = new SSEServerTransport("/mcp", res);
        activeTransports.set(transport.sessionId, {
          transport,
          aiSessionId,
          workspaceId,
        });

        server.connect(transport).then(() => {
          transport.onclose = () => {
            activeTransports.delete(transport.sessionId);
          };
        }).catch((error) => {
          console.error("[Meta Agent MCP] Connection error:", error);
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
        if (legacyTransportSessionId !== undefined && typeof legacyTransportSessionId !== "string") {
          res.writeHead(400);
          res.end("Invalid sessionId parameter");
          return;
        }

        const legacyMetadata = legacyTransportSessionId
          ? activeTransports.get(legacyTransportSessionId)
          : undefined;

        if (legacyMetadata && !mcpSessionIdHeader) {
          try {
            await legacyMetadata.transport.handlePostMessage(req, res);
          } catch (error) {
            console.error("[Meta Agent MCP] Error handling legacy SSE POST:", error);
            if (!res.headersSent) {
              res.writeHead(500);
              res.end("Internal server error");
            }
          }
          return;
        }

        const parsedBody = await readJsonBody(req);
        if (
          !mcpSessionIdHeader &&
          legacyTransportSessionId &&
          !isInitializePayload(parsedBody)
        ) {
          res.writeHead(404);
          res.end("Transport session not found");
          return;
        }

        let streamableMetadata = mcpSessionIdHeader
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

          const aiSessionId = parsedUrl.query.sessionId as string;
          const workspaceId = parsedUrl.query.workspaceId as string;

          if (!aiSessionId || typeof aiSessionId !== "string") {
            res.writeHead(400);
            res.end("Missing or invalid sessionId parameter");
            return;
          }

          if (!workspaceId || typeof workspaceId !== "string") {
            res.writeHead(400);
            res.end("Missing or invalid workspaceId parameter");
            return;
          }

          const server = createMetaAgentMcpServer(aiSessionId, workspaceId);
          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (streamableSessionId) => {
              activeStreamableTransports.set(streamableSessionId, {
                transport,
                aiSessionId,
                workspaceId,
              });
            },
          });

          transport.onclose = () => {
            const streamableSessionId = transport.sessionId;
            if (streamableSessionId) {
              activeStreamableTransports.delete(streamableSessionId);
            }
          };

          transport.onerror = (error) => {
            console.error("[Meta Agent MCP] Streamable transport error:", error);
          };

          await server.connect(transport);
          await transport.handleRequest(req, res, parsedBody);
          return;
        }

        try {
          await streamableMetadata.transport.handleRequest(req, res, parsedBody);
        } catch (error) {
          console.error("[Meta Agent MCP] Error handling streamable POST:", error);
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
          res.end("Missing Mcp-Session-Id header");
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
          console.error("[Meta Agent MCP] Error handling DELETE:", error);
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
      if (err) {
        reject(err);
      }
    });

    httpServer.on("listening", () => {
      httpServer.unref();
      resolve(httpServer);
    });

    httpServer.on("error", reject);
  });
}
