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

// Store active SSE transports and their metadata
interface TransportMetadata {
  transport: SSEServerTransport;
  aiSessionId: string;
}
const activeTransports = new Map<string, TransportMetadata>();

interface StreamableTransportMetadata {
  transport: StreamableHTTPServerTransport;
  aiSessionId: string;
}
const activeStreamableTransports = new Map<
  string,
  StreamableTransportMetadata
>();

// Store the HTTP server instance
let httpServerInstance: any = null;

// Store reference to the session manager functions (set once at startup)
let updateSessionTitleFn:
  | ((sessionId: string, title: string) => Promise<void>)
  | null = null;

let updateSessionMetadataFn:
  | ((sessionId: string, metadata: Record<string, unknown>) => Promise<void>)
  | null = null;

let getWorkspaceTagsFn:
  | ((sessionId: string) => Promise<{ name: string; count: number }[]>)
  | null = null;

let getSessionTagsFn:
  | ((sessionId: string) => Promise<string[]>)
  | null = null;

let getSessionTitleFn:
  | ((sessionId: string) => Promise<string | null>)
  | null = null;

let getSessionPhaseFn:
  | ((sessionId: string) => Promise<string | null>)
  | null = null;

/**
 * Set the update function for session titles (called once at startup)
 */
export function setUpdateSessionTitleFn(
  updateTitleFn: (sessionId: string, title: string) => Promise<void>
) {
  updateSessionTitleFn = updateTitleFn;
}

/**
 * Set the update function for session metadata (called once at startup)
 */
export function setUpdateSessionMetadataFn(
  updateMetadataFn: (sessionId: string, metadata: Record<string, unknown>) => Promise<void>
) {
  updateSessionMetadataFn = updateMetadataFn;
}

/**
 * Set the function to get workspace tags (called once at startup)
 */
export function setGetWorkspaceTagsFn(
  getTagsFn: (sessionId: string) => Promise<{ name: string; count: number }[]>
) {
  getWorkspaceTagsFn = getTagsFn;
}

/**
 * Set the function to get current tags for a session (called once at startup)
 */
export function setGetSessionTagsFn(
  getTagsFn: (sessionId: string) => Promise<string[]>
) {
  getSessionTagsFn = getTagsFn;
}

/**
 * Set the function to get current title for a session (called once at startup)
 */
export function setGetSessionTitleFn(
  getTitleFn: (sessionId: string) => Promise<string | null>
) {
  getSessionTitleFn = getTitleFn;
}

/**
 * Set the function to get current phase for a session (called once at startup)
 */
export function setGetSessionPhaseFn(
  getPhaseFn: (sessionId: string) => Promise<string | null>
) {
  getSessionPhaseFn = getPhaseFn;
}

export function cleanupSessionNamingServer() {
  // Close all active SSE transports
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
      console.error(
        `[Session Naming MCP] Error closing transport ${transportId}:`,
        error
      );
    }
  }
  activeTransports.clear();

  for (const [
    streamableTransportId,
    metadata,
  ] of activeStreamableTransports.entries()) {
    try {
      void metadata.transport.close().catch((error) => {
        console.error(
          `[Session Naming MCP] Error closing streamable transport ${streamableTransportId}:`,
          error
        );
      });
    } catch (error) {
      console.error(
        `[Session Naming MCP] Error closing streamable transport ${streamableTransportId}:`,
        error
      );
    }
  }
  activeStreamableTransports.clear();
}

export function shutdownSessionNamingHttpServer(): Promise<void> {
  return new Promise((resolve) => {
    if (!httpServerInstance) {
      resolve();
      return;
    }

    let hasResolved = false;
    const safeResolve = () => {
      if (!hasResolved) {
        hasResolved = true;
        resolve();
      }
    };

    try {
      cleanupSessionNamingServer();
    } catch (error) {
      console.error(
        "[Session Naming MCP] Error cleaning up transports:",
        error
      );
    }

    try {
      if (
        httpServerInstance &&
        typeof httpServerInstance.closeAllConnections === "function"
      ) {
        httpServerInstance.closeAllConnections();
      }
    } catch (error) {
      console.error("[Session Naming MCP] Error closing connections:", error);
    }

    try {
      if (
        httpServerInstance &&
        typeof httpServerInstance.close === "function"
      ) {
        httpServerInstance.close((err?: Error) => {
          if (err) {
            console.error(
              "[Session Naming MCP] Error closing HTTP server:",
              err
            );
          }
          httpServerInstance = null;
          safeResolve();
        });
      } else {
        httpServerInstance = null;
        safeResolve();
      }
    } catch (error) {
      console.error("[Session Naming MCP] Error in server close:", error);
      httpServerInstance = null;
      safeResolve();
    }

    // Timeout to ensure we don't hang
    setTimeout(() => {
      if (httpServerInstance) {
        console.log(
          "[Session Naming MCP] Force destroying HTTP server after timeout"
        );
        httpServerInstance = null;
      }
      safeResolve();
    }, 1000);
  });
}

export async function startSessionNamingServer(
  startPort: number = 3457
): Promise<{ httpServer: any; port: number }> {
  let port = startPort;
  let httpServer: any = null;
  let maxAttempts = 100;

  while (maxAttempts > 0) {
    try {
      httpServer = await tryCreateSessionNamingServer(port);
      console.log(`[Session Naming MCP] Successfully started on port ${port}`);
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
      `[Session Naming MCP] Could not find an available port after trying 100 ports starting from ${startPort}`
    );
  }

  httpServerInstance = httpServer;
  return { httpServer, port };
}

function createSessionNamingMcpServer(aiSessionId: string): Server {
  // Create a new MCP Server instance for this connection
  // This allows us to capture the aiSessionId in the closure
  const server = new Server(
    {
      name: "nimbalyst-session-naming",
      version: "1.0.0",
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  (server as { onerror?: (error: Error) => void }).onerror = (error: Error) => {
    console.error("[MCP:nimbalyst-session-naming] Server error:", error);
  };

  // Register tool handlers with aiSessionId captured in closure
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    // Build dynamic tag description with existing workspace tags
    let addTagDescription = 'Tags to add to the session. Use for type of work (bug-fix, feature, refactor), area/module (electron, runtime, ios), status, or any relevant category.';
    if (getWorkspaceTagsFn) {
      try {
        const existingTags = await getWorkspaceTagsFn(aiSessionId);
        if (existingTags.length > 0) {
          const tagList = existingTags.slice(0, 20).map(t => `${t.name} (${t.count})`).join(', ');
          addTagDescription += ` Existing tags in this workspace: ${tagList}. Use existing tags for consistency, or create new ones as needed.`;
        }
      } catch {
        // Ignore - just use default description
      }
    }

    return {
      tools: [
        {
          name: "update_session_meta",
          description:
            "Update session metadata. On the first call, set name, tags, and phase. On subsequent calls, update tags and/or phase. The name CAN be changed on later calls, but you should generally not rename a session once it has been named unless the user explicitly asks for a different name. Always returns the full current session metadata.",
          inputSchema: {
            type: "object",
            properties: {
              name: {
                type: "string",
                description:
                  'A concise session name (2-5 words) with descriptive part first. Examples: "Authentication bug fix", "Dark mode implementation", "Database layer refactor". Only set this on the first call, or when the user explicitly asks you to rename the session.',
              },
              add: {
                type: "array",
                items: { type: "string" },
                description: addTagDescription,
              },
              remove: {
                type: "array",
                items: { type: "string" },
                description: "Tags to remove from the session",
              },
              phase: {
                type: "string",
                enum: ["backlog", "planning", "implementing", "validating", "complete"],
                description:
                  'The current phase of work. Controls which kanban column the session appears in. Use "planning" for exploration/design, "implementing" for coding, "validating" for testing/review. IMPORTANT: Never set "complete" without explicit user approval -- use "validating" when work is finished. Only the user decides when work is complete.',
              },
              workflowPreset: {
                type: "string",
                enum: ["default", "implement-review-test", "research"],
                description:
                  'The meta-agent workflow mode for this session. "default" is the standard autonomous loop. "implement-review-test" runs an autonomous implement/review/test loop in one worktree. "research" decomposes a research question across child sessions and synthesizes findings. Takes effect on the next turn (the persona is rebuilt each turn).',
              },
            },
          },
        },
      ],
    };
  });

  // Snapshot the current session metadata state
  async function snapshotMeta(): Promise<{ name: string | null; tags: string[]; phase: string | null }> {
    const name = getSessionTitleFn ? await getSessionTitleFn(aiSessionId) : null;
    const tags: string[] = getSessionTagsFn ? await getSessionTagsFn(aiSessionId) : [];
    const phase = getSessionPhaseFn ? await getSessionPhaseFn(aiSessionId) : null;
    return { name, tags, phase };
  }

  // Build structured JSON response with before/after state for the widget
  function buildMetaResponse(
    notes: string[],
    before: { name: string | null; tags: string[]; phase: string | null },
    after: { name: string | null; tags: string[]; phase: string | null },
  ): string {
    // Human-readable summary for the AI
    const parts = [...notes];
    parts.push(`Name: ${after.name || '(not set)'}`);
    parts.push(`Tags: ${after.tags.length > 0 ? after.tags.map(t => `#${t}`).join(', ') : '(none)'}`);
    parts.push(`Phase: ${after.phase || '(not set)'}`);
    const summary = parts.join('\n');

    return JSON.stringify({ summary, before, after });
  }

  // Tool execution handler - aiSessionId is captured from outer scope
  server.setRequestHandler(CallToolRequestSchema, async (request: any) => {
    const { name, arguments: args } = request.params;

    // Strip MCP server prefix if present
    const toolName = name.replace(/^mcp__nimbalyst-session-naming__/, "");

    try {
    if (toolName === "update_session_meta") {
      const sessionName = args?.name as string | undefined;
      const addTags = Array.isArray(args?.add) ? args.add as string[] : typeof args?.add === 'string' ? [args.add] : undefined;
      const removeTags = Array.isArray(args?.remove) ? args.remove as string[] : typeof args?.remove === 'string' ? [args.remove] : undefined;
      const phase = args?.phase as string | undefined;
      const rawWorkflowPreset = args?.workflowPreset;
      const workflowPreset =
        rawWorkflowPreset === 'default' ||
        rawWorkflowPreset === 'implement-review-test' ||
        rawWorkflowPreset === 'research'
          ? (rawWorkflowPreset as string)
          : undefined;
      if (rawWorkflowPreset !== undefined && workflowPreset === undefined) {
        return {
          content: [
            {
              type: "text",
              text: 'Error: "workflowPreset" must be one of "default", "implement-review-test", "research".',
            },
          ],
          isError: true,
        };
      }

      // Require at least one parameter
      if (!sessionName && !addTags?.length && !removeTags?.length && !phase && !workflowPreset) {
        return {
          content: [
            {
              type: "text",
              text: 'Error: At least one of "name", "add", "remove", "phase", or "workflowPreset" must be provided.',
            },
          ],
          isError: true,
        };
      }

      // Capture state before changes for the widget transition display
      const before = await snapshotMeta();
      const notes: string[] = [];

      // Handle name (write-once)
      if (sessionName) {
        if (typeof sessionName !== "string") {
          return {
            content: [
              {
                type: "text",
                text: 'Error: "name" must be a string.',
              },
            ],
            isError: true,
          };
        }

        if (sessionName.length > 100) {
          return {
            content: [
              {
                type: "text",
                text: `Error: Session name too long (${sessionName.length} chars, max 100)`,
              },
            ],
            isError: true,
          };
        }

        try {
          await updateSessionTitleFn!(aiSessionId, sessionName);
          notes.push(`Set name: "${sessionName}"`);
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : "Unknown error";
          console.error("[Session Naming MCP] Failed to update session title:", error);
          return {
            content: [
              {
                type: "text",
                text: `Error updating session title: ${errorMessage}`,
              },
            ],
            isError: true,
          };
        }
      }

      // Handle tags (add/remove)
      if (addTags?.length || removeTags?.length) {
        if (!updateSessionMetadataFn) {
          return {
            content: [
              {
                type: "text",
                text: "Error: Session metadata update not available.",
              },
            ],
            isError: true,
          };
        }

        try {
          const currentTags: string[] = getSessionTagsFn
            ? await getSessionTagsFn(aiSessionId)
            : [];

          let newTags = [...currentTags];
          if (removeTags?.length) {
            const removeSet = new Set(removeTags);
            newTags = newTags.filter(t => !removeSet.has(t));
          }
          if (addTags?.length) {
            for (const tag of addTags) {
              if (!newTags.includes(tag)) {
                newTags.push(tag);
              }
            }
          }

          const metadataUpdate: Record<string, unknown> = { tags: newTags };
          if (phase) metadataUpdate.phase = phase;
          if (workflowPreset) metadataUpdate.workflowPreset = workflowPreset;

          await updateSessionMetadataFn(aiSessionId, metadataUpdate);

          if (addTags?.length) notes.push(`Added tags: ${addTags.map(t => `#${t}`).join(', ')}`);
          if (removeTags?.length) notes.push(`Removed tags: ${removeTags.map(t => `#${t}`).join(', ')}`);
          if (phase) notes.push(`Set phase: ${phase}`);
        } catch (error) {
          console.error("[Session Naming MCP] Failed to update tags:", error);
          return {
            content: [
              {
                type: "text",
                text: `Error updating tags: ${error instanceof Error ? error.message : "Unknown error"}`,
              },
            ],
            isError: true,
          };
        }
      } else if (phase || workflowPreset) {
        // Metadata-only update (no tag changes): phase and/or workflowPreset
        if (!updateSessionMetadataFn) {
          return {
            content: [
              {
                type: "text",
                text: "Error: Session metadata update not available.",
              },
            ],
            isError: true,
          };
        }

        try {
          const metadataUpdate: Record<string, unknown> = {};
          if (phase) metadataUpdate.phase = phase;
          if (workflowPreset) metadataUpdate.workflowPreset = workflowPreset;
          await updateSessionMetadataFn(aiSessionId, metadataUpdate);
          if (phase) notes.push(`Set phase: ${phase}`);
          if (workflowPreset) notes.push(`Set workflow preset: ${workflowPreset}`);
        } catch (error) {
          console.error("[Session Naming MCP] Failed to update session metadata:", error);
          return {
            content: [
              {
                type: "text",
                text: `Error updating session metadata: ${error instanceof Error ? error.message : "Unknown error"}`,
              },
            ],
            isError: true,
          };
        }
      }

      // Build structured response with before/after for widget
      const after = await snapshotMeta();
      const response = buildMetaResponse(notes, before, after);
      return {
        content: [{ type: "text", text: response }],
        isError: false,
      };
    } else {
      throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    }
    } catch (error) {
      if (error instanceof McpError) throw error;
      console.error(`[MCP:nimbalyst-session-naming] Tool "${name}" failed:`, error);
      console.error(`[MCP:nimbalyst-session-naming] Tool args:`, JSON.stringify(args).slice(0, 500));
      throw error;
    }
  });

  return server;
}

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

async function tryCreateSessionNamingServer(port: number): Promise<any> {
  return new Promise((resolve, reject) => {
    const httpServer = createServer(
      async (req: IncomingMessage, res: ServerResponse) => {
        const parsedUrl = parseUrl(req.url || "", true);
        const pathname = parsedUrl.pathname;
        const mcpSessionIdHeader = getMcpSessionIdHeader(req);

        // Handle CORS preflight.
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

        // Handle SSE GET request to establish connection
        if (pathname === "/mcp" && req.method === "GET") {
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
                "[Session Naming MCP] Error handling streamable GET request:",
                error
              );
              if (!res.headersSent) {
                res.writeHead(500);
                res.end("Internal server error");
              }
            }
            return;
          }

          // Extract AI session ID from query parameter
          const aiSessionId = parsedUrl.query.sessionId as string;

          if (!aiSessionId || typeof aiSessionId !== 'string') {
            res.writeHead(400);
            res.end("Missing or invalid sessionId parameter");
            return;
          }

          if (!updateSessionTitleFn) {
            res.writeHead(500);
            res.end("Session naming service not initialized");
            return;
          }

          const server = createSessionNamingMcpServer(aiSessionId);

          // Create SSE transport
          const transport = new SSEServerTransport("/mcp", res);
          activeTransports.set(transport.sessionId, {
            transport,
            aiSessionId,
          });


          // Connect server to transport
          server
            .connect(transport)
            .then(() => {
              transport.onclose = () => {
                activeTransports.delete(transport.sessionId);
              };
            })
            .catch((error) => {
              console.error("[Session Naming MCP] Connection error:", error);
              activeTransports.delete(transport.sessionId);
              if (!res.headersSent) {
                res.writeHead(500);
                res.end();
              }
            });
        } else if (pathname === "/mcp" && req.method === "POST") {
          // Legacy SSE POST flow: route to existing SSE transport if found
          const legacyTransportSessionId = parsedUrl.query.sessionId as
            | string
            | undefined;

          // Validate sessionId is a string if provided (could be array if duplicated)
          if (legacyTransportSessionId !== undefined && typeof legacyTransportSessionId !== 'string') {
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
              console.error(
                "[Session Naming MCP] Error handling legacy SSE POST message:",
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
            // Preserve legacy behavior for unknown SSE sessions.
            res.writeHead(404);
            res.end("Transport session not found");
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

            const aiSessionId = parsedUrl.query.sessionId as string;
            if (!aiSessionId || typeof aiSessionId !== 'string') {
              res.writeHead(400);
              res.end("Missing or invalid sessionId parameter");
              return;
            }

            if (!updateSessionTitleFn) {
              res.writeHead(500);
              res.end("Session naming service not initialized");
              return;
            }

            const server = createSessionNamingMcpServer(aiSessionId);
            const transport = new StreamableHTTPServerTransport({
              sessionIdGenerator: () => randomUUID(),
              onsessioninitialized: (streamableSessionId) => {
                activeStreamableTransports.set(streamableSessionId, {
                  transport,
                  aiSessionId,
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
              console.error(
                "[Session Naming MCP] Streamable transport error:",
                error
              );
            };

            await server.connect(transport);
            streamableMetadata = { transport, aiSessionId };
          }

          try {
            await streamableMetadata.transport.handleRequest(
              req,
              res,
              parsedBody
            );
          } catch (error) {
            console.error(
              "[Session Naming MCP] Error handling streamable POST request:",
              error
            );
            if (!res.headersSent) {
              res.writeHead(500);
              res.end("Internal server error");
            }
          }
        } else if (pathname === "/mcp" && req.method === "DELETE") {
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
              "[Session Naming MCP] Error handling streamable DELETE request:",
              error
            );
            if (!res.headersSent) {
              res.writeHead(500);
              res.end("Internal server error");
            }
          }
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
