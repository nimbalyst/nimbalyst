/**
 * Super Loop Progress MCP Server
 *
 * Provides the `super_loop_progress_update` tool that Claude must call at the end
 * of each Super Loop iteration to report progress. The tool writes progress.json
 * (for persistence/crash recovery) and records that it was called (for verification).
 *
 * Follows the same SSE + StreamableHTTP dual transport pattern as sessionNamingServer.ts.
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
import type { SuperProgressFile, SuperLearning } from "../../shared/types/superLoop";

// ============================================================================
// Transport Management
// ============================================================================

interface TransportMetadata {
  transport: SSEServerTransport;
  aiSessionId: string;
}
const activeTransports = new Map<string, TransportMetadata>();

interface StreamableTransportMetadata {
  transport: StreamableHTTPServerTransport;
  aiSessionId: string;
}
const activeStreamableTransports = new Map<string, StreamableTransportMetadata>();

let httpServerInstance: any = null;

// ============================================================================
// Progress Update Callback
// ============================================================================

let updateProgressFn:
  | ((sessionId: string, progress: SuperProgressFile) => Promise<void>)
  | null = null;

export function setProgressUpdateFn(
  fn: (sessionId: string, progress: SuperProgressFile) => Promise<void>
) {
  updateProgressFn = fn;
}

// ============================================================================
// Tool Call Tracking
// ============================================================================

const progressToolCalls = new Map<string, boolean>();

export function wasProgressToolCalled(sessionId: string): boolean {
  return progressToolCalls.get(sessionId) === true;
}

export function clearProgressToolCall(sessionId: string): void {
  progressToolCalls.delete(sessionId);
}

// ============================================================================
// Server Lifecycle
// ============================================================================

export function cleanupSuperLoopProgressServer() {
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
        `[Super Loop Progress MCP] Error closing transport ${transportId}:`,
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
          `[Super Loop Progress MCP] Error closing streamable transport ${streamableTransportId}:`,
          error
        );
      });
    } catch (error) {
      console.error(
        `[Super Loop Progress MCP] Error closing streamable transport ${streamableTransportId}:`,
        error
      );
    }
  }
  activeStreamableTransports.clear();
}

export function shutdownSuperLoopProgressServer(): Promise<void> {
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
      cleanupSuperLoopProgressServer();
    } catch (error) {
      console.error(
        "[Super Loop Progress MCP] Error cleaning up transports:",
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
      console.error("[Super Loop Progress MCP] Error closing connections:", error);
    }

    try {
      if (
        httpServerInstance &&
        typeof httpServerInstance.close === "function"
      ) {
        httpServerInstance.close((err?: Error) => {
          if (err) {
            console.error(
              "[Super Loop Progress MCP] Error closing HTTP server:",
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
      console.error("[Super Loop Progress MCP] Error in server close:", error);
      httpServerInstance = null;
      safeResolve();
    }

    setTimeout(() => {
      if (httpServerInstance) {
        console.log(
          "[Super Loop Progress MCP] Force destroying HTTP server after timeout"
        );
        httpServerInstance = null;
      }
      safeResolve();
    }, 1000);
  });
}

export async function startSuperLoopProgressServer(
  startPort: number = 3461
): Promise<{ httpServer: any; port: number }> {
  let port = startPort;
  let httpServer: any = null;
  let maxAttempts = 100;

  while (maxAttempts > 0) {
    try {
      httpServer = await tryCreateSuperLoopProgressServer(port);
      console.log(`[Super Loop Progress MCP] Successfully started on port ${port}`);
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
      `[Super Loop Progress MCP] Could not find an available port after trying 100 ports starting from ${startPort}`
    );
  }

  httpServerInstance = httpServer;
  return { httpServer, port };
}

// ============================================================================
// MCP Server Definition
// ============================================================================

function createSuperLoopProgressMcpServer(aiSessionId: string): Server {
  const server = new Server(
    {
      name: "nimbalyst-super-loop-progress",
      version: "1.0.0",
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  (server as { onerror?: (error: Error) => void }).onerror = (error: Error) => {
    console.error("[MCP:nimbalyst-super-loop-progress] Server error:", error);
  };

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        {
          name: "super_loop_progress_update",
          description:
            "Report progress at the end of a Super Loop iteration. You MUST call this tool as the last thing you do in every Super Loop iteration. It records your learnings, phase transitions, completion signals, and blockers for the next iteration.",
          inputSchema: {
            type: "object",
            properties: {
              phase: {
                type: "string",
                enum: ["planning", "building"],
                description:
                  'Current phase. Set to "building" after planning is complete.',
              },
              status: {
                type: "string",
                enum: ["running", "completed", "blocked"],
                description:
                  'Set to "running" if work remains, "completed" if done, "blocked" if stuck.',
              },
              completionSignal: {
                type: "boolean",
                description:
                  "Set to true ONLY when the task is fully complete. This ends the Super Loop.",
              },
              learnings: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    iteration: {
                      type: "number",
                      description: "The current iteration number.",
                    },
                    summary: {
                      type: "string",
                      description:
                        "What you accomplished, key decisions, and anything the next iteration needs to know.",
                    },
                    filesChanged: {
                      type: "array",
                      items: { type: "string" },
                      description: "Files you created or modified.",
                    },
                  },
                  required: ["iteration", "summary", "filesChanged"],
                },
                description:
                  "Append a learning entry for this iteration. Include all previous learnings too.",
              },
              blockers: {
                type: "array",
                items: { type: "string" },
                description:
                  'List of blockers preventing progress. Only set when status is "blocked".',
              },
              currentIteration: {
                type: "number",
                description: "The current iteration number.",
              },
            },
            required: [
              "phase",
              "status",
              "completionSignal",
              "learnings",
              "blockers",
              "currentIteration",
            ],
          },
        },
      ],
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request: any) => {
    const { name, arguments: args } = request.params;

    const toolName = name.replace(
      /^mcp__nimbalyst-super-loop-progress__/,
      ""
    );

    try {
    if (toolName === "super_loop_progress_update") {
      // Validate required fields
      const phase = args?.phase;
      const status = args?.status;
      const completionSignal = args?.completionSignal;
      const learnings = args?.learnings;
      const blockers = args?.blockers;
      const currentIteration = args?.currentIteration;

      if (!phase || !status || completionSignal === undefined || !learnings || !blockers || currentIteration === undefined) {
        return {
          content: [
            {
              type: "text",
              text: "Error: All fields are required: phase, status, completionSignal, learnings, blockers, currentIteration",
            },
          ],
          isError: true,
        };
      }

      if (phase !== "planning" && phase !== "building") {
        return {
          content: [
            {
              type: "text",
              text: 'Error: phase must be "planning" or "building"',
            },
          ],
          isError: true,
        };
      }

      if (status !== "running" && status !== "completed" && status !== "blocked") {
        return {
          content: [
            {
              type: "text",
              text: 'Error: status must be "running", "completed", or "blocked"',
            },
          ],
          isError: true,
        };
      }

      try {
        if (!updateProgressFn) {
          return {
            content: [
              {
                type: "text",
                text: "Error: Super Loop progress service not initialized",
              },
            ],
            isError: true,
          };
        }

        const progressFile: SuperProgressFile = {
          currentIteration,
          phase,
          status,
          completionSignal: !!completionSignal,
          learnings: (learnings as SuperLearning[]) || [],
          blockers: (blockers as string[]) || [],
        };

        await updateProgressFn(aiSessionId, progressFile);

        // Record that the tool was called for this session
        progressToolCalls.set(aiSessionId, true);

        return {
          content: [
            {
              type: "text",
              text: `Progress updated successfully. Phase: ${phase}, Status: ${status}, Completion: ${completionSignal}`,
            },
          ],
          isError: false,
        };
      } catch (error) {
        console.error(
          "[Super Loop Progress MCP] Failed to update progress:",
          error
        );

        const errorMessage =
          error instanceof Error ? error.message : "Unknown error";
        return {
          content: [
            {
              type: "text",
              text: `Error updating progress: ${errorMessage}`,
            },
          ],
          isError: true,
        };
      }
    } else {
      throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    }
    } catch (error) {
      if (error instanceof McpError) throw error;
      console.error(`[MCP:nimbalyst-super-loop-progress] Tool "${name}" failed:`, error);
      console.error(`[MCP:nimbalyst-super-loop-progress] Tool args:`, JSON.stringify(args).slice(0, 500));
      throw error;
    }
  });

  return server;
}

// ============================================================================
// HTTP Server Helpers
// ============================================================================

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

// ============================================================================
// HTTP Server
// ============================================================================

async function tryCreateSuperLoopProgressServer(port: number): Promise<any> {
  return new Promise((resolve, reject) => {
    const httpServer = createServer(
      async (req: IncomingMessage, res: ServerResponse) => {
        const parsedUrl = parseUrl(req.url || "", true);
        const pathname = parsedUrl.pathname;
        const mcpSessionIdHeader = getMcpSessionIdHeader(req);

        // Handle CORS preflight
        if (req.method === "OPTIONS") {
          res.writeHead(200, {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
            "Access-Control-Allow-Headers":
              "Content-Type, mcp-session-id, mcp-protocol-version",
          });
          res.end();
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
                "[Super Loop Progress MCP] Error handling streamable GET request:",
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

          if (!aiSessionId || typeof aiSessionId !== "string") {
            res.writeHead(400);
            res.end("Missing or invalid sessionId parameter");
            return;
          }

          if (!updateProgressFn) {
            res.writeHead(500);
            res.end("Super Loop progress service not initialized");
            return;
          }

          const server = createSuperLoopProgressMcpServer(aiSessionId);

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
              console.error("[Super Loop Progress MCP] Connection error:", error);
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

          if (
            legacyTransportSessionId !== undefined &&
            typeof legacyTransportSessionId !== "string"
          ) {
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
                "[Super Loop Progress MCP] Error handling legacy SSE POST message:",
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
            if (!aiSessionId || typeof aiSessionId !== "string") {
              res.writeHead(400);
              res.end("Missing or invalid sessionId parameter");
              return;
            }

            if (!updateProgressFn) {
              res.writeHead(500);
              res.end("Super Loop progress service not initialized");
              return;
            }

            const server = createSuperLoopProgressMcpServer(aiSessionId);
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
                "[Super Loop Progress MCP] Streamable transport error:",
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
              "[Super Loop Progress MCP] Error handling streamable POST request:",
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
              "[Super Loop Progress MCP] Error handling streamable DELETE request:",
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
