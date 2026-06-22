# Internal MCP Servers

This document explains how Nimbalyst implements internal MCP (Model Context Protocol) servers to provide tools to Claude Code and other AI providers.

## Overview

Nimbalyst runs MCP servers **inside the Electron main process** to provide AI capabilities without requiring external server processes. These servers use HTTP with Server-Sent Events (SSE) transport, listening only on localhost.

### Consolidated topology (one port, many endpoints)

A **single unified internal HTTP server** (`httpServer.ts`) hosts every first-party endpoint on one port and one bearer token (Issue #146). Each endpoint is its own `config[name]` to the agent (the SDK namespaces tools by config-key, so `mcp__<server>__<tool>`), with its own load policy. The single source of truth for the layout is `packages/runtime/src/ai/server/services/mcpTopology.ts`; registration is in `McpConfigService.getMcpServersConfig`.

Three orthogonal axes (see `mcpTopology.ts`): **server boundary** = the unit of user-meaningful opt-out; **load policy** = eager (`alwaysLoad`) / deferred (surfaced by ToolSearch on intent) / conditional; **transport** = one port, one endpoint path per server.

| Server (config-key) | Endpoint | Load policy | Tools |
| --- | --- | --- | --- |
| `nimbalyst` (core) | `/mcp/core` | **eager** | AskUserQuestion, PromptForUserInput, display_to_user, capture_editor_screenshot, get_session_edited_files, developer_git_commit_proposal, developer_git_log, update_session_meta. The only always-loaded surface; carries the long `tool_timeout_sec` (commit-proposal / AskUserQuestion block on user input). |
| `nimbalyst-host` | `/mcp/host` | deferred | App config (settings_get_overview, appearance_\*, ai_\*, analytics_set_enabled, features_toggle, extension_set_enabled, sync_set_for_project, workspace_create/open/set_trust); session-context (get_session_summary, get_workstream_\*, list_recent_sessions, schedule_wakeup, update_session_board); child-session orchestration (create_session, spawn_session, send_prompt, respond_to_prompt, get_session_status/result, list_spawned_sessions, list_worktrees). The settings tools are dropped for the meta-agent profile and the settings kill-switch (`hostExcludeSettings` flag); session-context + meta-agent stay. |
| `nimbalyst-trackers` | `/mcp/trackers` | deferred + per-project opt-out | tracker CRUD + config (`tracker_*`). The whole server is omitted when the per-project **Trackers → AI Agent Access** toggle (`trackersEnabled`) is off. |
| `nimbalyst-situational` | `/mcp/situational` | deferred | voice_agent_speak/stop, readCollabDoc/applyCollabDocEdit, feedback_anonymize_text/get_environment/open_github_issue. |
| `nimbalyst-<ext>` (one per extension) | `/mcp/ext/<id>` | deferred | Each active extension contributes its own server (`nimbalyst-excalidraw`, `nimbalyst-slides`, …) so the extension long-tail leaves the eager path. Surfaced by ToolSearch on intent — creation flows work with no file open. |
| `nimbalyst-extension-dev` | `/mcp/extension-dev` | profile-gated, **own port** | Developer-mode tooling (database_query, extension_build/install/reload/uninstall, restart_nimbalyst, get_main_process_logs, get_renderer_debug_logs, renderer_eval, …). Still a standalone HTTP server (`extensionDevServer.ts`). |

Settings writes route through `SettingsControlService` (allow-list, deny-list for API keys / Stytch creds / share keys, 30-writes/60s rate limit, audit logging). Kill-switch: set `settingsAgentToolsDisabled` in Settings to drop the settings tools from `nimbalyst-host`.

> The legacy monolithic `nimbalyst-mcp` server and the standalone `settings` /
> `session-context` / `meta-agent` / `session-naming` HTTP servers have been
> **retired** — their tools fold onto the unified endpoints above. The standalone
> server files still export their tool schemas + a `dispatch*` fn, which the
> unified `httpServer` imports; `SessionNamingService` / `MetaAgentService` still
> inject their handler fns but no longer start an HTTP server.

## Architecture

### Components

```
┌─────────────────────────────────────────────────┐
│           Claude Code Provider                   │
│  (runtime/ai/server/providers/ClaudeCodeProvider)│
│                                                   │
│  - Manages MCP server configuration              │
│  - Connects to internal MCP servers via HTTP/SSE │
└─────────────────────────────────────────────────┘
                      ↓ HTTP
┌─────────────────────────────────────────────────┐
│         Internal MCP HTTP Server                 │
│      (electron/src/main/mcp/httpServer.ts)       │
│                                                   │
│  - Listens on localhost:PORT                     │
│  - Handles SSE connections                       │
│  - Registers MCP tools                           │
│  - Routes tool calls to services                 │
└─────────────────────────────────────────────────┘
                      ↓ IPC / Direct
┌─────────────────────────────────────────────────┐
│              Service Layer                        │
│  (electron/src/main/services/*)                  │
│                                                   │
│  - MockupScreenshotService                    │
│  - SessionNamingService                          │
│  - EditorRegistry (via IPC)                      │
└─────────────────────────────────────────────────┘
                      ↓ IPC
┌─────────────────────────────────────────────────┐
│            Renderer Process                       │
│  (electron/src/renderer/*)                       │
│                                                   │
│  - MockupViewer (screenshot capture)          │
│  - Editor components (content streaming)         │
└─────────────────────────────────────────────────┘
```

### Key Patterns

1. **Singleton Services**: Main process services use singleton pattern
2. **Port Injection**: Server ports are injected into providers via static methods
3. **Workspace Context**: Workspace paths are passed via query parameters
4. **IPC Bridge**: Services coordinate with renderer via IPC handlers
5. **SSE Transport**: MCP protocol uses Server-Sent Events over HTTP

## How to Add a New Internal MCP Server

### Step 1: Create the MCP Server Module

Create a new file in `packages/electron/src/main/mcp/yourServerName.ts`:

```typescript
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ErrorCode,
  McpError
} from '@modelcontextprotocol/sdk/types.js';
import { createServer, IncomingMessage, ServerResponse } from 'http';
import { parse as parseUrl } from 'url';

// Store active SSE transports
const activeTransports = new Map<string, SSEServerTransport>();
let httpServerInstance: any = null;

export function shutdownYourMcpServer(): Promise<void> {
  return new Promise((resolve) => {
    if (!httpServerInstance) {
      resolve();
      return;
    }

    // Close all active transports
    for (const [, transport] of activeTransports.entries()) {
      try {
        if (transport.onclose) {
          transport.onclose();
        }
      } catch (error) {
        console.error('[Your MCP] Error closing transport:', error);
      }
    }
    activeTransports.clear();

    // Close HTTP server
    httpServerInstance.close(() => {
      console.log('[Your MCP] HTTP server closed');
      resolve();
    });
  });
}

export async function startYourMcpServer(): Promise<{ port: number }> {
  // Try ports starting from 41000
  let port = 41000;
  const maxPort = 41100;

  while (port < maxPort) {
    try {
      const server = await tryCreateServer(port);
      httpServerInstance = server;
      console.log(`[Your MCP] Server started on port ${port}`);
      return { port };
    } catch (error) {
      port++;
    }
  }

  throw new Error('[Your MCP] Could not find available port');
}

async function tryCreateServer(port: number): Promise<any> {
  return new Promise((resolve, reject) => {
    const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      const parsedUrl = parseUrl(req.url || '', true);
      const pathname = parsedUrl.pathname;

      // CORS headers
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

      if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
      }

      // Health check endpoint
      if (pathname === '/health' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok' }));
        return;
      }

      // MCP SSE endpoint
      if (pathname === '/mcp' && req.method === 'GET') {
        // Extract context from query params (e.g., sessionId, workspacePath)
        const context = parsedUrl.query.context as string | undefined;
        console.log('[Your MCP] Connection established with context:', context);

        // Create MCP server instance
        const server = new Server(
          {
            name: 'your-mcp-server',
            version: '1.0.0',
          },
          {
            capabilities: {
              tools: {},
            },
          }
        );

        // Register tools
        server.setRequestHandler(ListToolsRequestSchema, async () => {
          return {
            tools: [
              {
                name: 'your_tool_name',
                description: 'Description of what your tool does',
                inputSchema: {
                  type: 'object',
                  properties: {
                    param1: {
                      type: 'string',
                      description: 'Description of param1'
                    }
                  },
                  required: ['param1']
                }
              }
            ]
          };
        });

        // Handle tool calls
        server.setRequestHandler(CallToolRequestSchema, async (request) => {
          const { name, arguments: args } = request.params;

          switch (name) {
            case 'your_tool_name': {
              const param1 = args?.param1 as string;

              if (!param1) {
                return {
                  content: [
                    {
                      type: 'text',
                      text: 'Error: param1 is required'
                    }
                  ],
                  isError: true
                };
              }

              try {
                // Implement your tool logic here
                const result = await doSomething(param1);

                return {
                  content: [
                    {
                      type: 'text',
                      text: `Success: ${result}`
                    }
                  ],
                  isError: false
                };
              } catch (error) {
                console.error('[Your MCP] Tool failed:', error);
                const errorMessage = error instanceof Error ? error.message : 'Unknown error';

                return {
                  content: [
                    {
                      type: 'text',
                      text: `Error: ${errorMessage}`
                    }
                  ],
                  isError: true
                };
              }
            }

            default:
              throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
          }
        });

        // Set up SSE transport
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        });

        const transport = new SSEServerTransport('/mcp', res);
        const transportId = `${Date.now()}-${Math.random()}`;
        activeTransports.set(transportId, transport);

        transport.onclose = () => {
          activeTransports.delete(transportId);
          console.log('[Your MCP] Transport closed');
        };

        await server.connect(transport);
        return;
      }

      // 404 for unknown routes
      res.writeHead(404);
      res.end('Not Found');
    });

    httpServer.on('error', (error: any) => {
      if (error.code === 'EADDRINUSE') {
        reject(error);
      } else {
        console.error('[Your MCP] Server error:', error);
      }
    });

    httpServer.listen(port, '127.0.0.1', () => {
      resolve(httpServer);
    });
  });
}

async function doSomething(param: string): Promise<string> {
  // Implement your logic
  return `Processed: ${param}`;
}
```

### Step 2: Create a Service (Optional)

If your tool needs complex logic or coordination with renderer process, create a service in `packages/electron/src/main/services/YourService.ts`:

```typescript
/**
 * Service to provide [your feature] capabilities
 * This runs in the electron main process and is called by the MCP server
 */
export class YourService {
  private static instance: YourService | null = null;

  private constructor() {}

  public static getInstance(): YourService {
    if (!YourService.instance) {
      YourService.instance = new YourService();
    }
    return YourService.instance;
  }

  /**
   * Main method called by MCP server
   */
  public async doSomething(param: string): Promise<{ success: boolean; result?: string; error?: string }> {
    try {
      // Implement your logic here
      const result = await this.processParam(param);
      return { success: true, result };
    } catch (error) {
      console.error('[YourService] Failed:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  private async processParam(param: string): Promise<string> {
    // Implementation
    return `Processed: ${param}`;
  }

  /**
   * Cleanup method called on app shutdown
   */
  public cleanup(): void {
    console.log('[YourService] Cleanup complete');
  }
}
```

### Step 3: Create IPC Handlers (If Needed)

If your service needs to communicate with the renderer process, create IPC handlers in `packages/electron/src/main/ipc/YourHandlers.ts`:

```typescript
import { ipcMain } from 'electron';
import { YourService } from '../services/YourService';

/**
 * Register IPC handlers for your feature
 */
export function registerYourHandlers() {
  // Handle requests from renderer
  ipcMain.handle('your-feature:do-something', async (_event, param: string) => {
    const service = YourService.getInstance();
    const result = await service.doSomething(param);
    return result;
  });
}
```

### Step 4: Integrate with Main Process

In `packages/electron/src/main/index.ts`:

```typescript
// 1. Import your modules
import { YourService } from './services/YourService';
import { registerYourHandlers } from './ipc/YourHandlers';
import { startYourMcpServer, shutdownYourMcpServer } from './mcp/yourServerName';

// 2. Register IPC handlers in app.whenReady()
app.whenReady().then(async () => {
  // ... existing code ...

  registerYourHandlers();

  // ... existing code ...
});

// 3. Start your MCP server in app.whenReady()
app.whenReady().then(async () => {
  // ... after other servers start ...

  try {
    const result = await startYourMcpServer();
    console.log('[Main] Your MCP server started on port:', result.port);

    // Store port for provider access (if needed)
    (global as any).yourMcpServerPort = result.port;
  } catch (error) {
    console.error('[Main] Failed to start your MCP server:', error);
  }

  // ... existing code ...
});

// 4. Add cleanup in app.on('before-quit')
app.on('before-quit', async (event) => {
  // ... existing cleanup ...

  try {
    // Cleanup service
    const yourService = YourService.getInstance();
    yourService.cleanup();
  } catch (error) {
    console.error('[QUIT] Error cleaning up your service:', error);
  }

  try {
    // Shutdown MCP server
    await shutdownYourMcpServer();
  } catch (error) {
    console.error('[QUIT] Error shutting down your MCP server:', error);
  }

  // ... existing cleanup ...
});
```

### Step 5: Integrate with AI Provider

If your MCP server should be accessible to Claude Code, update `packages/runtime/src/ai/server/providers/ClaudeCodeProvider.ts`:

```typescript
export class ClaudeCodeProvider extends BaseAIProvider {
  // Add static port property
  private static yourMcpServerPort: number | null = null;

  // Add setter method
  public static setYourMcpServerPort(port: number | null): void {
    ClaudeCodeProvider.yourMcpServerPort = port;
  }

  // Update getMcpServersConfig() to include your server
  private async getMcpServersConfig(sessionId?: string, workspacePath?: string) {
    const config: any = {};

    // ... existing servers ...

    // Include your MCP server if it's started
    if (ClaudeCodeProvider.yourMcpServerPort !== null) {
      config['your-mcp-server'] = {
        type: 'sse',
        transport: 'sse',
        url: `http://127.0.0.1:${ClaudeCodeProvider.yourMcpServerPort}/mcp?context=${encodeURIComponent(contextValue)}`
      };
      console.log('[CLAUDE-CODE] Your MCP server configured on port', ClaudeCodeProvider.yourMcpServerPort);
    }

    return config;
  }
}
```

Then in `packages/electron/src/main/index.ts`, inject the port after starting the server:

```typescript
import { ClaudeCodeProvider } from '@nimbalyst/runtime/ai/server';

app.whenReady().then(async () => {
  // ... after starting your MCP server ...

  try {
    const result = await startYourMcpServer();
    (global as any).yourMcpServerPort = result.port;

    // Inject port into ClaudeCodeProvider
    ClaudeCodeProvider.setYourMcpServerPort(result.port);
  } catch (error) {
    console.error('[Main] Failed to start your MCP server:', error);
  }
});
```

## Best Practices

### Security

1. **Localhost Only**: Always bind to `127.0.0.1`, never `0.0.0.0`
2. **No External Access**: Internal MCP servers should never be exposed to the network
3. **Validate Input**: Always validate tool parameters before processing
4. **File Path Validation**: Restrict file operations to allowed directories

### Error Handling

1. **Try-Catch Everything**: Wrap all tool logic in try-catch blocks
2. **Return Errors as Content**: Use `isError: true` in MCP responses, don't throw
3. **Log Errors**: Always log errors with context for debugging
4. **Graceful Degradation**: Handle missing services/windows gracefully

### Performance

1. **Short Timeouts**: Use reasonable timeouts for operations (5-10 seconds)
2. **Cleanup Resources**: Always cleanup on shutdown (close connections, clear maps)
3. **Port Reuse**: Close servers properly to avoid EADDRINUSE errors
4. **Avoid Blocking**: Use async/await for I/O operations

### Testing

1. **Health Endpoint**: Include `/health` endpoint for testing
2. **Logging**: Add detailed logging for debugging MCP flow
3. **Manual Testing**: Test with Claude Code to verify tool integration
4. **Edge Cases**: Test with missing context, invalid params, closed windows

### Context Passing

1. **Query Parameters**: Pass context via URL query params (sessionId, workspacePath)
2. **Per-Connection State**: Store state per SSE connection, not globally
3. **Workspace Routing**: Use workspace paths to route to correct window
4. **Document State**: Maintain document state per session to avoid cross-contamination

## Common Patterns

### Pattern 1: Hot vs Cold Path

Used in `MockupScreenshotService`:

```typescript
// Try hot path first (e.g., open tab with annotations)
const hotResult = await this.tryHotPath();
if (hotResult.success || !hotResult.error?.includes('not available')) {
  return hotResult;
}

// Fall back to cold path (e.g., headless rendering)
console.log('Hot path not available, falling back to cold path');
return this.tryColdPath();
```

### Pattern 2: Request-Response via IPC

Used in `MockupScreenshotService`:

```typescript
// Generate unique request ID
const requestId = `request-${Date.now()}-${Math.random().toString(36).substring(7)}`;

// Create promise for result
return new Promise((resolve) => {
  const timeout = setTimeout(() => {
    this.pendingRequests.delete(requestId);
    resolve({ success: false, error: 'Timeout' });
  }, 5000);

  this.pendingRequests.set(requestId, { resolve, reject: () => {}, timeout });

  // Send IPC to renderer
  targetWindow.webContents.send('your-feature:request', { requestId, data });
});

// Handler for response from renderer
public handleResponse(requestId: string, result: any): void {
  const pending = this.pendingRequests.get(requestId);
  if (pending) {
    clearTimeout(pending.timeout);
    this.pendingRequests.delete(requestId);
    pending.resolve(result);
  }
}
```

### Pattern 3: Workspace to Window Routing

Used in `httpServer.ts`:

```typescript
function findWindowForWorkspace(workspacePath: string): BrowserWindow | null {
  // First try to find window by workspace path
  let targetWindow = findWindowByWorkspace(workspacePath);

  // Fall back to first available window
  if (!targetWindow) {
    const allWindows = BrowserWindow.getAllWindows().filter(w => !w.isDestroyed());
    if (allWindows.length > 0) {
      targetWindow = allWindows[0];
    }
  }

  return targetWindow;
}
```

## Debugging

### Enable Verbose Logging

Uncomment console.log statements in MCP server files for detailed flow:

```typescript
console.log('[Your MCP] Connection established with context:', context);
console.log('[Your MCP] Tool called:', name, 'with args:', args);
console.log('[Your MCP] Result:', result);
```

### Test MCP Server Health

```bash
curl http://127.0.0.1:PORT/health
# Should return: {"status":"ok"}
```

### Check Active Connections

Add logging to track active SSE transports:

```typescript
console.log('[Your MCP] Active transports:', activeTransports.size);
```

### Inspect Claude Code Configuration

In ClaudeCodeProvider, log the MCP config:

```typescript
const config = await this.getMcpServersConfig(sessionId, workspacePath);
console.log('[CLAUDE-CODE] MCP config:', JSON.stringify(config, null, 2));
```

## Examples

See existing implementations:

1. **Shared MCP Server**: `packages/electron/src/main/mcp/httpServer.ts`
  - Multi-tool server with workspace routing
  - IPC coordination with renderer
  - Document state management

2. **Session Naming Server**: `packages/electron/src/main/mcp/sessionNamingServer.ts`
  - Simple single-tool server
  - Session-scoped context
  - Direct database updates

3. **Mockup Screenshot Service**: `packages/electron/src/main/services/MockupScreenshotService.ts`
  - Hot/cold path pattern
  - Request-response via IPC
  - Timeout handling

## Troubleshooting

### Port Already in Use

If you see `EADDRINUSE` errors:
1. Ensure previous server instance is shut down properly
2. Try a different port range
3. Check for zombie processes

### Tool Not Available in Claude Code

If your tool doesn't appear:
1. Verify server started successfully (check logs)
2. Ensure port was injected into provider
3. Check MCP config includes your server
4. Verify Claude Code is using correct session/workspace

### IPC Not Working

If IPC handlers don't receive messages:
1. Verify handlers are registered before windows open
2. Check window is not destroyed
3. Ensure correct channel names
4. Add logging to both sender and receiver

### Context Not Available

If workspace/session context is missing:
1. Pass context via URL query parameters
2. Store per-connection, not globally
3. Validate context before using it
4. Provide clear error messages when context is missing

## Extension Development Tools Reference

The Extension Development Kit (EDK) MCP server provides tools specifically designed for AI agents developing extensions. This enables iterative extension development with full visibility into logs, screenshots, and extension state.

### extension_get_logs

Retrieve recent logs from the renderer process console output. This captures ALL console.log/error/warn/debug calls from extension code, core application UI components, custom editors (Monaco, RevoGrid, etc.), and React component lifecycle. Use this for debugging any renderer-side issues, not just extensions.

**Parameters:**
- `extensionId` (string, optional): Filter logs to a specific extension ID
- `lastSeconds` (number, optional): Get logs from the last N seconds (default: 60, max: 300)
- `logLevel` (string, optional): Minimum log level - 'error', 'warn', 'info', 'debug', or 'all' (default: 'all')
- `source` (string, optional): Log source filter - 'renderer', 'main', 'build', or 'all' (default: 'all')
- `searchTerm` (string, optional): Filter logs containing this text (case-insensitive)

**Log Sources:**
- `renderer`: Console output from extension code running in the renderer process
- `main`: Main process logs related to extension operations
- `build`: Output from `npm run build` during extension compilation

**Example Response:**
```
Renderer Console Logs (last 60s)
Found 15 log entries (buffer: 42/1000)
Errors: 2, Warnings: 3, Info: 8, Debug: 2
---
17:23:45.123 INFO  [main]      Starting build for extension: com.example.my-ext
17:23:46.456 INFO  [build]     (com.example.my-ext) Compiling TypeScript...
17:23:47.789 ERROR [renderer]  (com.example.my-ext) TypeError: Cannot read property 'foo' of undefined
```

**Example with search:**
```
extension_get_logs(searchTerm: "Monaco", logLevel: "error", lastSeconds: 120)
```

### get_main_process_logs

Read logs from the main process log file (Node.js side). The main log persists across sessions and contains component-scoped entries.

**When to use:**
- File system errors (file watchers, workspace loading)
- IPC channel issues
- AI provider initialization failures
- Extension loading errors
- Database query errors

**Parameters:**
- `lastLines` (number, optional): Number of recent lines to read (default: 100, max: 1000)
- `component` (string, optional): Filter by component name: FILE_WATCHER, WORKSPACE_WATCHER, AI_CLAUDE, AI_CLAUDE_CODE, STREAMING, EXTENSION, IPC, DATABASE, etc.
- `logLevel` (string, optional): Filter by minimum log level (error, warn, info, debug)
- `searchTerm` (string, optional): Search for specific text in logs (case-insensitive)

**Example:**
```
get_main_process_logs(component: "FILE_WATCHER", logLevel: "error", lastLines: 50)
```

**Example Response:**
```
Main Process Logs (last 50 lines, component: FILE_WATCHER, level: error+)
File: ~/Library/Application Support/@nimbalyst/electron/logs/main.log
Found 3 matching lines
---
[2026-01-21 17:45:24.789] [error] [FILE_WATCHER] Failed to watch directory: ENOENT
[2026-01-21 17:46:12.345] [error] [FILE_WATCHER] Watcher closed unexpectedly
```

### get_renderer_debug_logs

Read the renderer debug log file (development mode only). Logs rotate on app restart, keeping last 5 sessions. Use the session parameter to access previous session logs for crash investigation or historical debugging.

**When to use:**
- UI component errors not visible in extension_get_logs ring buffer
- Historical debugging (ring buffer only keeps last 1000 entries)
- Multi-window debugging (filter by window ID)
- Investigating crashes or issues from previous sessions
- Long-running session analysis

**Parameters:**
- `session` (number, optional): Which session to read: 0 = current (default), 1 = previous, 2 = two sessions ago, up to 4
- `lastLines` (number, optional): Number of recent lines to read (default: 100, max: 1000)
- `windowId` (number, optional): Filter to logs from a specific window ID
- `logLevel` (string, optional): Filter by log level (ERROR, WARN, INFO, DEBUG)
- `searchTerm` (string, optional): Search for specific text in logs (case-insensitive)

**Note:** Returns error in production builds - only available in development mode.

**Examples:**
```
get_renderer_debug_logs(searchTerm: "Monaco", lastLines: 200)
get_renderer_debug_logs(session: 1, searchTerm: "crash")  // Previous session's crash logs
get_renderer_debug_logs(session: 2, logLevel: "error")    // Errors from 2 sessions ago
```

**Example Response:**
```
Renderer Debug Logs (session: 1 session(s) ago, last 100 lines, search: "crash")
File: ~/Library/Application Support/@nimbalyst/electron/nimbalyst-debug.1.log
Found 5 matching lines
---
[Window 1] [17:45:23] [ERROR] Uncaught exception: Application crash detected
[Window 1] [17:45:23] [ERROR] Stack trace: TypeError at crashHandler.ts:42
```

### extension_get_status

Query the current status of an installed extension.

**Parameters:**
- `extensionId` (string, required): The extension ID to query

**Example Response:**
```
Extension: com.example.my-ext
Status: loaded

Custom Editors (1):
  - My Custom Editor (*.myext)

AI Tools (2):
  - my_tool_1
  - my_tool_2

New File Menu Items (1):
  - My File Type (.myext)
```

### capture_editor_screenshot

Capture a screenshot of the current editor view. Works with any file type including custom editors from extensions.

**Parameters:**
- `file_path` (string, optional): The absolute path to the file being edited (uses active file if not specified)
- `selector` (string, optional): CSS selector to capture a specific element (captures full editor if not specified)

**Use Cases:**
- Verify custom editor UI rendering during development
- Capture visual state for debugging layout issues
- Document extension UI for testing

**Note:** This tool is in the Shared MCP Server (`httpServer.ts`), not the EDK server, but is essential for extension development workflows.

### Extension Development Workflow

A typical AI agent extension development session:

1. **Build the extension:**
```
   extension_build(path: "/path/to/my-extension")
```

2. **Install into running Nimbalyst:**
```
   extension_install(path: "/path/to/my-extension")
```

3. **Check logs for errors:**
```
   extension_get_logs(extensionId: "com.example.my-ext", logLevel: "error")
```

4. **Verify it loaded correctly:**
```
   extension_get_status(extensionId: "com.example.my-ext")
```

5. **Open a file using your custom editor and capture screenshot:**
```
   capture_editor_screenshot(file_path: "/path/to/test.myext")
```

6. **Make changes and hot reload:**
```
   extension_reload(extensionId: "com.example.my-ext", path: "/path/to/my-extension")
```

7. **Check logs after reload:**
```
   extension_get_logs(lastSeconds: 30)
```

### ExtensionLogService Architecture

The log capture system uses a ring buffer architecture:

```
┌─────────────────────────────────────────────────┐
│         ExtensionLogService (Singleton)          │
│                                                   │
│  ┌─────────────────────────────────────────────┐ │
│  │        Ring Buffer (1000 entries max)        │ │
│  │                                               │ │
│  │  Entry: { timestamp, level, source,          │ │
│  │           extensionId, message, stack? }     │ │
│  └─────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────┘
        ↑                    ↑                    ↑
   Renderer            Main Process          Build Output
   Console              Logs                 (npm run build)
```

**Log Entry Fields:**
- `timestamp`: Unix timestamp in milliseconds
- `level`: 'error' | 'warn' | 'info' | 'debug'
- `source`: 'renderer' | 'main' | 'build'
- `extensionId`: Extension ID when detectable from source path
- `message`: The log message content
- `stack`: Stack trace for errors (when available)
- `sourceFile`: File path for renderer logs
- `line`: Line number for renderer logs
